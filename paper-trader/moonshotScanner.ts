import {
  ConfirmedSignatureInfo,
  ParsedTransactionWithMeta,
  PublicKey,
} from "@solana/web3.js";
import { getConnection } from "../lib/solana";
import { getSupabaseAdmin } from "../lib/supabase";
import { SerialEventQueue, SignatureDeduper } from "../worker/eventIntake";

export const MOONSHOT_SCANNER_VERSION =
  "moonshot_scanner_v2_http_polling_2026_07_27";

const WRAPPED_SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const EXCLUDED_MINTS = new Set([WRAPPED_SOL, USDC, USDT]);

const RPC_RETRY_DELAYS_MS = [0, 500, 1_500, 3_000] as const;
const TX_FETCH_DELAYS_MS = [0, 250, 750, 1_500] as const;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_RPC_MIN_INTERVAL_MS = 250;
const DEFAULT_MAX_QUEUE_DEPTH = 200;
const DEFAULT_MAX_MINTS_PER_TRANSACTION = 8;
const DEFAULT_MAX_SIGNATURES_PER_POLL = 25;
const DEFAULT_MAX_SIGNATURE_AGE_MS = 120_000;
const DEDUPE_TTL_MS = 30 * 60_000;

type ProgramCursor = string | null;
type ProgramCursorMap = Map<string, ProgramCursor>;

export type MoonshotMintEvidence = {
  mint: string;
  appearedInPreBalances: boolean;
  appearedInPostBalances: boolean;
  newlyVisibleInPostBalances: boolean;
  preOwnerCount: number;
  postOwnerCount: number;
};

export type MoonshotSignatureInfo = Pick<
  ConfirmedSignatureInfo,
  "signature" | "slot" | "err" | "blockTime"
>;

type MoonshotSignatureEvent = {
  programId: string;
  signature: string;
  slot: number;
  receivedAt: number;
};

type MoonshotScannerMetrics = {
  eventsReceived: number;
  eventsDropped: number;
  transactionFetchFailures: number;
  signatureFetchFailures: number;
  candidatesRecorded: number;
  pollsCompleted: number;
  queueDepth: number;
  lastPollAt: string | null;
  lastEventAt: string | null;
  lastCandidateAt: string | null;
  lastError: string | null;
};

type MoonshotScannerConfig = {
  enabled: boolean;
  programIds: string[];
  heartbeatMs: number;
  pollIntervalMs: number;
  rpcMinIntervalMs: number;
  maxQueueDepth: number;
  maxMintsPerTransaction: number;
  maxSignaturesPerPoll: number;
  maxSignatureAgeMs: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function envFlag(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw == null) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

export function parseMoonshotProgramIds(raw: string | undefined): string[] {
  const values = String(raw ?? "")
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const valid = new Set<string>();

  for (const value of values) {
    try {
      valid.add(new PublicKey(value).toBase58());
    } catch {
      console.warn(`[moonshot-scanner] ignoring invalid program id: ${value}`);
    }
  }

  return [...valid];
}

function loadConfig(): MoonshotScannerConfig {
  return {
    enabled: envFlag("ENABLE_MOONSHOT_SCANNER", false),
    programIds: parseMoonshotProgramIds(process.env.MOONSHOT_PROGRAM_IDS),
    heartbeatMs: boundedInteger(
      process.env.MOONSHOT_HEARTBEAT_MS,
      DEFAULT_HEARTBEAT_MS,
      10_000,
      5 * 60_000
    ),
    pollIntervalMs: boundedInteger(
      process.env.MOONSHOT_POLL_INTERVAL_MS,
      DEFAULT_POLL_INTERVAL_MS,
      5_000,
      5 * 60_000
    ),
    rpcMinIntervalMs: boundedInteger(
      process.env.MOONSHOT_RPC_MIN_INTERVAL_MS,
      DEFAULT_RPC_MIN_INTERVAL_MS,
      100,
      10_000
    ),
    maxQueueDepth: boundedInteger(
      process.env.MOONSHOT_MAX_QUEUE_DEPTH,
      DEFAULT_MAX_QUEUE_DEPTH,
      10,
      5_000
    ),
    maxMintsPerTransaction: boundedInteger(
      process.env.MOONSHOT_MAX_MINTS_PER_TRANSACTION,
      DEFAULT_MAX_MINTS_PER_TRANSACTION,
      1,
      32
    ),
    maxSignaturesPerPoll: boundedInteger(
      process.env.MOONSHOT_MAX_SIGNATURES_PER_POLL,
      DEFAULT_MAX_SIGNATURES_PER_POLL,
      1,
      500
    ),
    maxSignatureAgeMs: boundedInteger(
      process.env.MOONSHOT_MAX_SIGNATURE_AGE_MS,
      DEFAULT_MAX_SIGNATURE_AGE_MS,
      30_000,
      15 * 60_000
    ),
  };
}

function ownerCounts(
  balances: NonNullable<ParsedTransactionWithMeta["meta"]>["preTokenBalances"]
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const balance of balances ?? []) {
    if (!balance.mint || EXCLUDED_MINTS.has(balance.mint)) continue;
    const owners = result.get(balance.mint) ?? new Set<string>();
    if (balance.owner) owners.add(balance.owner);
    result.set(balance.mint, owners);
  }
  return result;
}

export function extractMoonshotCandidateMints(
  transaction: ParsedTransactionWithMeta,
  maximum = DEFAULT_MAX_MINTS_PER_TRANSACTION
): MoonshotMintEvidence[] {
  const meta = transaction.meta;
  if (!meta) return [];

  const preOwners = ownerCounts(meta.preTokenBalances);
  const postOwners = ownerCounts(meta.postTokenBalances);
  const mints = new Set<string>([...postOwners.keys(), ...preOwners.keys()]);

  return [...mints]
    .map((mint) => ({
      mint,
      appearedInPreBalances: preOwners.has(mint),
      appearedInPostBalances: postOwners.has(mint),
      newlyVisibleInPostBalances: !preOwners.has(mint) && postOwners.has(mint),
      preOwnerCount: preOwners.get(mint)?.size ?? 0,
      postOwnerCount: postOwners.get(mint)?.size ?? 0,
    }))
    .sort((left, right) => {
      if (left.newlyVisibleInPostBalances !== right.newlyVisibleInPostBalances) {
        return left.newlyVisibleInPostBalances ? -1 : 1;
      }
      return right.postOwnerCount - left.postOwnerCount;
    })
    .slice(0, Math.max(1, maximum));
}

export function selectMoonshotSignatures(
  signaturesNewestFirst: readonly MoonshotSignatureInfo[],
  nowMs: number,
  maxAgeMs: number
): MoonshotSignatureInfo[] {
  return signaturesNewestFirst
    .filter((signature) => {
      if (signature.err) return false;
      if (signature.blockTime == null) return true;
      return nowMs - signature.blockTime * 1_000 <= maxAgeMs;
    })
    .reverse();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deserializeProgramCursors(
  value: unknown,
  allowedProgramIds: readonly string[]
): ProgramCursorMap {
  const cursors: ProgramCursorMap = new Map();
  if (!value || typeof value !== "object" || Array.isArray(value)) return cursors;

  const allowed = new Set(allowedProgramIds);
  for (const [programId, cursor] of Object.entries(value)) {
    if (!allowed.has(programId)) continue;
    if (cursor === null || typeof cursor === "string") {
      cursors.set(programId, cursor);
    }
  }
  return cursors;
}

function serializeProgramCursors(cursors: ProgramCursorMap): Record<string, ProgramCursor> {
  return Object.fromEntries(cursors.entries());
}

export async function startMoonshotScanner(): Promise<void> {
  const config = loadConfig();
  const metrics: MoonshotScannerMetrics = {
    eventsReceived: 0,
    eventsDropped: 0,
    transactionFetchFailures: 0,
    signatureFetchFailures: 0,
    candidatesRecorded: 0,
    pollsCompleted: 0,
    queueDepth: 0,
    lastPollAt: null,
    lastEventAt: null,
    lastCandidateAt: null,
    lastError: null,
  };

  if (!config.enabled) {
    console.log(
      `[moonshot-scanner] ${MOONSHOT_SCANNER_VERSION} disabled; set ENABLE_MOONSHOT_SCANNER=true only after Phase 1 review`
    );
    setInterval(() => undefined, 60_000);
    return;
  }

  if (config.programIds.length === 0) {
    console.error(
      "[moonshot-scanner] configuration blocked: MOONSHOT_PROGRAM_IDS contains no valid Solana program IDs"
    );
    setInterval(() => undefined, 60_000);
    return;
  }

  let connection: ReturnType<typeof getConnection>;
  let supabase: ReturnType<typeof getSupabaseAdmin>;
  try {
    connection = getConnection();
    supabase = getSupabaseAdmin();
  } catch (error) {
    console.error(
      `[moonshot-scanner] configuration blocked: ${errorMessage(error)}`
    );
    setInterval(() => undefined, 60_000);
    return;
  }

  const processed = new SignatureDeduper(DEDUPE_TTL_MS, 100_000);
  let cursors: ProgramCursorMap = new Map();
  let lastStateErrorLogAt = 0;
  let rpcTail: Promise<void> = Promise.resolve();
  let lastRpcFinishedAt = 0;
  let polling = false;

  async function pacedRpc<T>(operation: () => Promise<T>): Promise<T> {
    const run = rpcTail
      .catch(() => undefined)
      .then(async () => {
        const waitMs = Math.max(
          0,
          config.rpcMinIntervalMs - (Date.now() - lastRpcFinishedAt)
        );
        if (waitMs > 0) await sleep(waitMs);
        try {
          return await operation();
        } finally {
          lastRpcFinishedAt = Date.now();
        }
      });

    rpcTail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async function persistState(status: string): Promise<void> {
    try {
      const { error } = await supabase.from("moonshot_scanner_state").upsert(
        {
          id: 1,
          version: MOONSHOT_SCANNER_VERSION,
          mode: "scanner_only",
          intake_mode: "http_polling",
          enabled: true,
          status,
          program_ids: config.programIds,
          active_subscriptions: 0,
          active_programs: cursors.size,
          program_cursors: serializeProgramCursors(cursors),
          queue_depth: metrics.queueDepth,
          events_received: metrics.eventsReceived,
          events_dropped: metrics.eventsDropped,
          transaction_fetch_failures: metrics.transactionFetchFailures,
          signature_fetch_failures: metrics.signatureFetchFailures,
          candidates_recorded: metrics.candidatesRecorded,
          polls_completed: metrics.pollsCompleted,
          last_poll_at: metrics.lastPollAt,
          last_event_at: metrics.lastEventAt,
          last_candidate_at: metrics.lastCandidateAt,
          last_error: metrics.lastError,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" }
      );
      if (error) throw error;
    } catch (error) {
      const now = Date.now();
      if (now - lastStateErrorLogAt >= 60_000) {
        lastStateErrorLogAt = now;
        console.error(
          `[moonshot-scanner] state heartbeat failed: ${errorMessage(error)}`
        );
      }
    }
  }

  async function loadStoredCursors(): Promise<void> {
    try {
      const { data, error } = await supabase
        .from("moonshot_scanner_state")
        .select("program_cursors")
        .eq("id", 1)
        .maybeSingle();
      if (error) throw error;
      cursors = deserializeProgramCursors(data?.program_cursors, config.programIds);
    } catch (error) {
      metrics.lastError = `cursor load: ${errorMessage(error)}`;
      console.warn(`[moonshot-scanner] ${metrics.lastError}; starting at now`);
      cursors = new Map();
    }
  }

  async function fetchProgramSignatures(
    programId: string,
    untilSignature: string | null,
    limit: number
  ): Promise<ConfirmedSignatureInfo[] | null> {
    let lastError: unknown = null;

    for (const delayMs of RPC_RETRY_DELAYS_MS) {
      if (delayMs > 0) await sleep(delayMs);
      try {
        return await pacedRpc(() =>
          connection.getSignaturesForAddress(
            new PublicKey(programId),
            {
              limit,
              until: untilSignature ?? undefined,
            },
            "confirmed"
          )
        );
      } catch (error) {
        lastError = error;
      }
    }

    metrics.signatureFetchFailures += 1;
    metrics.lastError = `signature fetch ${programId.slice(0, 8)}: ${errorMessage(lastError)}`;
    console.error(`[moonshot-scanner] ${metrics.lastError}`);
    return null;
  }

  async function initializeProgramCursor(programId: string): Promise<boolean> {
    if (cursors.has(programId)) return true;

    const latest = await fetchProgramSignatures(programId, null, 1);
    if (!latest) return false;

    const latestSignature = latest[0]?.signature ?? null;
    cursors.set(programId, latestSignature);
    console.log(
      `[moonshot-scanner] cursor initialized ${programId.slice(0, 8)}…; historical transactions skipped`
    );
    return true;
  }

  async function fetchTransaction(
    signature: string
  ): Promise<ParsedTransactionWithMeta | null> {
    let lastError: unknown = null;

    for (const delayMs of TX_FETCH_DELAYS_MS) {
      if (delayMs > 0) await sleep(delayMs);
      try {
        const transaction = await pacedRpc(() =>
          connection.getParsedTransaction(signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          })
        );
        if (transaction) return transaction;
        lastError = new Error("confirmed transaction not available yet");
      } catch (error) {
        lastError = error;
      }
    }

    metrics.transactionFetchFailures += 1;
    metrics.lastError = `transaction ${signature.slice(0, 8)}: ${errorMessage(lastError)}`;
    console.warn(`[moonshot-scanner] ${metrics.lastError}`);
    return null;
  }

  async function recordCandidates(event: MoonshotSignatureEvent): Promise<void> {
    const transaction = await fetchTransaction(event.signature);
    if (!transaction) {
      processed.mark(event.signature);
      return;
    }

    const candidates = extractMoonshotCandidateMints(
      transaction,
      config.maxMintsPerTransaction
    );
    if (candidates.length === 0) {
      processed.mark(event.signature);
      return;
    }

    const detectedAt = new Date().toISOString();
    const blockTimeMs = transaction.blockTime
      ? transaction.blockTime * 1_000
      : null;
    const rows = candidates.map((candidate) => ({
      signature: event.signature,
      program_id: event.programId,
      slot: event.slot || transaction.slot,
      mint: candidate.mint,
      received_at: new Date(event.receivedAt).toISOString(),
      detected_at: detectedAt,
      block_time: blockTimeMs ? new Date(blockTimeMs).toISOString() : null,
      latency_ms: blockTimeMs ? Math.max(0, event.receivedAt - blockTimeMs) : null,
      sequence_status: "observed",
      rug_gate_status: "not_run",
      would_enter: false,
      evidence: {
        scannerVersion: MOONSHOT_SCANNER_VERSION,
        intakeMode: "http_polling",
        appearedInPreBalances: candidate.appearedInPreBalances,
        appearedInPostBalances: candidate.appearedInPostBalances,
        newlyVisibleInPostBalances: candidate.newlyVisibleInPostBalances,
        preOwnerCount: candidate.preOwnerCount,
        postOwnerCount: candidate.postOwnerCount,
        transactionError: transaction.meta?.err ?? null,
        logCount: transaction.meta?.logMessages?.length ?? 0,
      },
    }));

    try {
      const { error } = await supabase.from("moonshot_candidates").upsert(rows, {
        onConflict: "signature,program_id,mint",
        ignoreDuplicates: true,
      });
      if (error) throw error;
      metrics.candidatesRecorded += rows.length;
      metrics.lastCandidateAt = detectedAt;
      metrics.lastError = null;
      console.log(
        `[moonshot-scanner] observed ${rows.length} candidate mint(s) from ${event.programId.slice(0, 8)}… tx ${event.signature.slice(0, 8)}…`
      );
    } catch (error) {
      metrics.lastError = `candidate write: ${errorMessage(error)}`;
      console.error(`[moonshot-scanner] ${metrics.lastError}`);
    } finally {
      processed.mark(event.signature);
    }
  }

  const queue = new SerialEventQueue<MoonshotSignatureEvent>(
    recordCandidates,
    (error, event) => {
      metrics.lastError = `queue ${event.signature.slice(0, 8)}: ${errorMessage(error)}`;
      console.error(`[moonshot-scanner] ${metrics.lastError}`);
    },
    (depth) => {
      metrics.queueDepth = depth;
    }
  );

  async function pollProgram(programId: string): Promise<boolean> {
    const initialized = await initializeProgramCursor(programId);
    if (!initialized) return false;

    const previousCursor = cursors.get(programId) ?? null;
    const fetchedAt = Date.now();
    const signatures = await fetchProgramSignatures(
      programId,
      previousCursor,
      config.maxSignaturesPerPoll
    );
    if (!signatures) return false;

    if (signatures.length === config.maxSignaturesPerPoll) {
      metrics.eventsDropped += 1;
      console.warn(
        `[moonshot-scanner] ${programId.slice(0, 8)}… poll cap reached (${config.maxSignaturesPerPoll}); older backlog may be skipped`
      );
    }

    const selected = selectMoonshotSignatures(
      signatures,
      fetchedAt,
      config.maxSignatureAgeMs
    );

    for (const signatureInfo of selected) {
      if (processed.has(signatureInfo.signature)) continue;
      if (queue.depth >= config.maxQueueDepth) {
        metrics.eventsDropped += 1;
        metrics.lastError = `queue limit reached at ${queue.depth}`;
        console.warn(
          `[moonshot-scanner] event dropped; queue limit ${config.maxQueueDepth} reached`
        );
        continue;
      }

      const enqueued = queue.enqueue(signatureInfo.signature, {
        programId,
        signature: signatureInfo.signature,
        slot: signatureInfo.slot,
        receivedAt: fetchedAt,
      });
      if (!enqueued) continue;

      metrics.eventsReceived += 1;
      metrics.lastEventAt = new Date(fetchedAt).toISOString();
    }

    await queue.whenIdle();

    const newestSignature = signatures[0]?.signature;
    if (newestSignature) {
      cursors.set(programId, newestSignature);
    }
    return true;
  }

  async function pollAllPrograms(): Promise<void> {
    if (polling) return;
    polling = true;
    let failures = 0;

    try {
      for (const programId of config.programIds) {
        const ok = await pollProgram(programId);
        if (!ok) failures += 1;
      }

      metrics.pollsCompleted += 1;
      metrics.lastPollAt = new Date().toISOString();
      if (failures === 0 && metrics.queueDepth === 0) {
        metrics.lastError = null;
      }
      await persistState(failures === config.programIds.length ? "degraded" : "active");
    } catch (error) {
      metrics.lastError = `poll loop: ${errorMessage(error)}`;
      console.error(`[moonshot-scanner] ${metrics.lastError}`);
      await persistState("degraded");
    } finally {
      polling = false;
    }
  }

  function scheduleNextPoll(): void {
    setTimeout(() => {
      void pollAllPrograms().finally(scheduleNextPoll);
    }, config.pollIntervalMs);
  }

  console.log(
    `[moonshot-scanner] ${MOONSHOT_SCANNER_VERSION} starting in scanner-only HTTP polling mode; trades disabled; programs=${config.programIds.length}; intervalMs=${config.pollIntervalMs}; maxSignatures=${config.maxSignaturesPerPoll}`
  );

  await loadStoredCursors();
  await pollAllPrograms();
  scheduleNextPoll();

  setInterval(() => {
    void persistState(metrics.lastPollAt ? "active" : "degraded");
  }, config.heartbeatMs);
}
