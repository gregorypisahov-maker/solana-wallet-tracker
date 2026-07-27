import { Logs, ParsedTransactionWithMeta, PublicKey } from "@solana/web3.js";
import { getConnection } from "../lib/solana";
import { getSupabaseAdmin } from "../lib/supabase";
import { SerialEventQueue, SignatureDeduper } from "../worker/eventIntake";

export const MOONSHOT_SCANNER_VERSION = "moonshot_scanner_v1_2026_07_27";

const WRAPPED_SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const EXCLUDED_MINTS = new Set([WRAPPED_SOL, USDC, USDT]);

const TX_FETCH_DELAYS_MS = [0, 250, 750, 1_500] as const;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_SUBSCRIPTION_SYNC_MS = 60_000;
const DEFAULT_MAX_QUEUE_DEPTH = 200;
const DEFAULT_MAX_MINTS_PER_TRANSACTION = 8;
const DEDUPE_TTL_MS = 30 * 60_000;

export type MoonshotMintEvidence = {
  mint: string;
  appearedInPreBalances: boolean;
  appearedInPostBalances: boolean;
  newlyVisibleInPostBalances: boolean;
  preOwnerCount: number;
  postOwnerCount: number;
};

type MoonshotLogEvent = {
  programId: string;
  signature: string;
  slot: number;
  receivedAt: number;
};

type MoonshotScannerMetrics = {
  eventsReceived: number;
  eventsDropped: number;
  transactionFetchFailures: number;
  candidatesRecorded: number;
  queueDepth: number;
  lastEventAt: string | null;
  lastCandidateAt: string | null;
  lastError: string | null;
};

type MoonshotScannerConfig = {
  enabled: boolean;
  programIds: string[];
  heartbeatMs: number;
  subscriptionSyncMs: number;
  maxQueueDepth: number;
  maxMintsPerTransaction: number;
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
    subscriptionSyncMs: boundedInteger(
      process.env.MOONSHOT_SUBSCRIPTION_SYNC_MS,
      DEFAULT_SUBSCRIPTION_SYNC_MS,
      30_000,
      10 * 60_000
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function startMoonshotScanner(): Promise<void> {
  const config = loadConfig();
  const metrics: MoonshotScannerMetrics = {
    eventsReceived: 0,
    eventsDropped: 0,
    transactionFetchFailures: 0,
    candidatesRecorded: 0,
    queueDepth: 0,
    lastEventAt: null,
    lastCandidateAt: null,
    lastError: null,
  };

  if (!config.enabled) {
    console.log(
      `[moonshot-scanner] ${MOONSHOT_SCANNER_VERSION} disabled; set ENABLE_MOONSHOT_SCANNER=true only after Phase 1 review`
    );
    setInterval(() => undefined, 60_000).unref?.();
    return;
  }

  if (config.programIds.length === 0) {
    console.error(
      "[moonshot-scanner] configuration blocked: MOONSHOT_PROGRAM_IDS contains no valid Solana program IDs"
    );
    setInterval(() => undefined, 60_000).unref?.();
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
    setInterval(() => undefined, 60_000).unref?.();
    return;
  }

  const processed = new SignatureDeduper(DEDUPE_TTL_MS, 100_000);
  const subscriptions = new Map<string, number>();
  let lastStateErrorLogAt = 0;

  async function persistState(status: string): Promise<void> {
    try {
      const { error } = await supabase.from("moonshot_scanner_state").upsert(
        {
          id: 1,
          version: MOONSHOT_SCANNER_VERSION,
          mode: "scanner_only",
          enabled: true,
          status,
          program_ids: config.programIds,
          active_subscriptions: subscriptions.size,
          queue_depth: metrics.queueDepth,
          events_received: metrics.eventsReceived,
          events_dropped: metrics.eventsDropped,
          transaction_fetch_failures: metrics.transactionFetchFailures,
          candidates_recorded: metrics.candidatesRecorded,
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

  async function fetchTransaction(
    signature: string
  ): Promise<ParsedTransactionWithMeta | null> {
    let lastError: unknown = null;

    for (const delayMs of TX_FETCH_DELAYS_MS) {
      if (delayMs > 0) await sleep(delayMs);
      try {
        const transaction = await connection.getParsedTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
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

  async function recordCandidates(event: MoonshotLogEvent): Promise<void> {
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

  const queue = new SerialEventQueue<MoonshotLogEvent>(
    recordCandidates,
    (error, event) => {
      metrics.lastError = `queue ${event.signature.slice(0, 8)}: ${errorMessage(error)}`;
      console.error(`[moonshot-scanner] ${metrics.lastError}`);
    },
    (depth) => {
      metrics.queueDepth = depth;
    }
  );

  function handleLogs(programId: string, logs: Logs, slot: number): void {
    if (logs.err || processed.has(logs.signature)) return;

    metrics.eventsReceived += 1;
    metrics.lastEventAt = new Date().toISOString();

    if (queue.depth >= config.maxQueueDepth) {
      metrics.eventsDropped += 1;
      metrics.lastError = `queue limit reached at ${queue.depth}`;
      console.warn(
        `[moonshot-scanner] event dropped; queue limit ${config.maxQueueDepth} reached`
      );
      return;
    }

    const enqueued = queue.enqueue(logs.signature, {
      programId,
      signature: logs.signature,
      slot,
      receivedAt: Date.now(),
    });
    if (!enqueued) return;
  }

  async function syncSubscriptions(): Promise<void> {
    for (const programId of config.programIds) {
      if (subscriptions.has(programId)) continue;
      try {
        const subscriptionId = connection.onLogs(
          new PublicKey(programId),
          (logs, context) => handleLogs(programId, logs, context.slot),
          "confirmed"
        );
        subscriptions.set(programId, subscriptionId);
        console.log(
          `[moonshot-scanner] subscribed ${programId.slice(0, 8)}…`
        );
      } catch (error) {
        metrics.lastError = `subscribe ${programId.slice(0, 8)}: ${errorMessage(error)}`;
        console.error(`[moonshot-scanner] ${metrics.lastError}`);
      }
    }
  }

  console.log(
    `[moonshot-scanner] ${MOONSHOT_SCANNER_VERSION} starting in scanner-only mode; trades disabled; programs=${config.programIds.length}`
  );

  await syncSubscriptions();
  await persistState(subscriptions.size > 0 ? "active" : "degraded");

  setInterval(() => {
    void syncSubscriptions().catch((error) => {
      metrics.lastError = `subscription sync: ${errorMessage(error)}`;
      console.error(`[moonshot-scanner] ${metrics.lastError}`);
    });
  }, config.subscriptionSyncMs);

  setInterval(() => {
    void persistState(subscriptions.size > 0 ? "active" : "degraded");
  }, config.heartbeatMs);
}
