import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "../lib/supabase";
import { sendTelegramAlert } from "../lib/telegram";
import {
  decideScalpExit,
  evaluateScalpCandidate,
  SCALP_RULES,
} from "./momentumScalperRules";
import { fetchJsonWithBackoff, RateLimitGate } from "./httpBackoff";
import { parseGeckoMinuteCandles } from "./momentumPullback";
import {
  assertScalpEntryDecision,
  buildScalpEntryDecision,
} from "./scalpEntryDecision";
import { buildScalpScanAudit } from "./scalpScanAudit";
import type {
  CandidateEvaluation,
  ConfirmationEvaluation,
  ScalpCandidate,
  ScalpMarketConfirmation,
} from "./momentumScalperRules";
import type { PullbackEvaluation } from "./momentumPullback";
import type { ScalpEntryDecision } from "./scalpEntryDecision";

const supabase = getSupabaseAdmin();
const GECKO_TRENDING_URL =
  "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=1";
const DEX_TOKEN_URL = "https://api.dexscreener.com/tokens/v1/solana";
const REQUEST_TIMEOUT_MS = 12_000;
const STRATEGY_VERSION = "momentum_quality_v3_2026_07_17";
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
const STABLE_MINTS = new Set([
  WRAPPED_SOL_MINT,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

type ScalpStateRow = {
  bankroll_sol: number | string;
  starting_bankroll_sol: number | string;
  enabled: boolean;
  halted: boolean;
  halt_reason: string | null;
  entries_today: number;
  daily_date: string;
  daily_realized_pnl_sol: number | string;
  consecutive_losses: number;
  last_scan_at: string | null;
};

type ScalpPositionRow = {
  position_id: string;
  mint: string;
  token_symbol: string;
  pair_address: string;
  entry_price_usd: number | string;
  entry_time: string;
  size_sol: number | string;
  peak_price_usd: number | string;
  last_price_usd: number | string;
  entry_snapshot: Record<string, unknown>;
};

type DexSnapshot = ScalpMarketConfirmation;

type EvaluatedCandidate = {
  candidate: ScalpCandidate;
  evaluation: CandidateEvaluation;
};

type CandidateAudit = EvaluatedCandidate & {
  cooldown: "not_checked" | "passed" | "rejected";
  confirmation: ConfirmationEvaluation | null;
  pullback: PullbackEvaluation | null;
  bindingChecks: ScalpEntryDecision["bindingChecks"] | null;
  acceptedForEntry: boolean;
  reasons: string[];
};

let scanRunning = false;
let positionCheckRunning = false;
const geckoRateLimitGate = new RateLimitGate();

function boundedInterval(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, parsed))
    : fallback;
}

const SCAN_INTERVAL_MS = boundedInterval(
  process.env.SCALP_SCAN_INTERVAL_MS,
  60_000,
  30_000,
  5 * 60_000
);
const POSITION_CHECK_INTERVAL_MS = boundedInterval(
  process.env.SCALP_POSITION_CHECK_MS,
  3_000,
  3_000,
  60_000
);

function envEnabled(name: string, fallback = true): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return !["0", "false", "no", "off"].includes(value);
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stripNetworkId(value: unknown): string {
  return String(value ?? "").replace(/^solana_/, "");
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function signed(value: number, digits = 3): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

async function fetchJson(
  url: string,
  headers?: HeadersInit,
  geckoRequest = false
): Promise<unknown> {
  return fetchJsonWithBackoff(url, {
    headers,
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxAttempts: geckoRequest ? 4 : 2,
    baseDelayMs: geckoRequest ? 1_500 : 750,
    maximumDelayMs: geckoRequest ? 30_000 : 5_000,
    rateLimitGate: geckoRequest ? geckoRateLimitGate : undefined,
  });
}

function parseTrendingCandidate(row: any): ScalpCandidate | null {
  const attributes = row?.attributes;
  const baseMint = stripNetworkId(
    row?.relationships?.base_token?.data?.id
  );
  if (!attributes || !baseMint || STABLE_MINTS.has(baseMint)) return null;

  const priceUsd = numberValue(attributes.base_token_price_usd, NaN);
  const liquidityUsd = numberValue(attributes.reserve_in_usd, NaN);
  const marketCapUsd = numberValue(
    attributes.market_cap_usd ?? attributes.fdv_usd,
    NaN
  );
  const pairAddress = String(attributes.address ?? "");
  const createdAt = Date.parse(String(attributes.pool_created_at ?? ""));
  const poolAgeMinutes = Number.isFinite(createdAt)
    ? Math.max(0, Date.now() - createdAt) / 60_000
    : Number.NaN;

  if (
    !pairAddress ||
    !Number.isFinite(priceUsd) ||
    priceUsd <= 0 ||
    !Number.isFinite(liquidityUsd) ||
    !Number.isFinite(marketCapUsd)
  ) {
    return null;
  }

  const symbol =
    String(attributes.name ?? "UNKNOWN").split("/")[0]?.trim() || "UNKNOWN";
  const transactions = attributes.transactions?.m5 ?? {};

  return {
    mint: baseMint,
    symbol,
    pairAddress,
    priceUsd,
    liquidityUsd,
    marketCapUsd,
    fiveMinuteChangePct: numberValue(
      attributes.price_change_percentage?.m5,
      Number.NaN
    ),
    fifteenMinuteChangePct: numberValue(
      attributes.price_change_percentage?.m15,
      Number.NaN
    ),
    fiveMinuteVolumeUsd: numberValue(attributes.volume_usd?.m5, Number.NaN),
    fiveMinuteBuys: Math.max(
      0,
      Math.floor(numberValue(transactions.buys, Number.NaN))
    ),
    fiveMinuteSells: Math.max(
      0,
      Math.floor(numberValue(transactions.sells, Number.NaN))
    ),
    fiveMinuteBuyers: Math.max(
      0,
      Math.floor(numberValue(transactions.buyers, Number.NaN))
    ),
    poolAgeMinutes,
  };
}

async function loadTrendingCandidates(): Promise<ScalpCandidate[]> {
  const body = (await fetchJson(GECKO_TRENDING_URL, {
    Accept: "application/vnd.api+json;version=20230302",
    "User-Agent": "solana-wallet-tracker-paper-scalper/1.0",
  }, true)) as any;
  const rows = Array.isArray(body?.data) ? body.data : [];
  const byMint = new Map<string, ScalpCandidate>();

  for (const row of rows) {
    const candidate = parseTrendingCandidate(row);
    if (!candidate) continue;
    const existing = byMint.get(candidate.mint);
    if (!existing || candidate.liquidityUsd > existing.liquidityUsd) {
      byMint.set(candidate.mint, candidate);
    }
  }
  return [...byMint.values()];
}

async function fetchMinuteCandles(pairAddress: string) {
  const url =
    "https://api.geckoterminal.com/api/v2/networks/solana/pools/" +
    `${encodeURIComponent(pairAddress)}/ohlcv/minute` +
    "?aggregate=1&limit=5&currency=usd&token=base";
  const body = await fetchJson(
    url,
    {
      Accept: "application/vnd.api+json;version=20230302",
      "User-Agent": "solana-wallet-tracker-paper-scalper/1.0",
    },
    true
  );
  return parseGeckoMinuteCandles(body);
}

async function fetchDexSnapshot(mint: string): Promise<DexSnapshot> {
  const body = await fetchJson(
    `${DEX_TOKEN_URL}/${encodeURIComponent(mint)}`,
    { Accept: "application/json" }
  );
  const pairs = Array.isArray(body) ? body : [];
  const eligible = pairs
    .filter(
      (pair: any) =>
        pair?.chainId === "solana" &&
        pair?.baseToken?.address === mint &&
        numberValue(pair?.priceUsd) > 0
    )
    .sort(
      (left: any, right: any) =>
        numberValue(right?.liquidity?.usd) -
        numberValue(left?.liquidity?.usd)
    );

  const pair = eligible[0];
  if (!pair) throw new Error(`No liquid DexScreener pair for ${mint}`);

  return {
    mint,
    pairAddress: String(pair.pairAddress ?? ""),
    priceUsd: numberValue(pair.priceUsd),
    liquidityUsd: numberValue(pair.liquidity?.usd),
    marketCapUsd: numberValue(pair.marketCap ?? pair.fdv),
    fiveMinuteChangePct: numberValue(pair.priceChange?.m5),
  };
}

async function loadState(): Promise<ScalpStateRow> {
  const { data, error } = await supabase
    .from("scalp_state")
    .select("*")
    .eq("id", 1)
    .single();
  if (error) throw new Error(`scalp state load failed: ${error.message}`);
  return data as ScalpStateRow;
}

async function loadPositions(): Promise<ScalpPositionRow[]> {
  const { data, error } = await supabase
    .from("scalp_positions")
    .select("*")
    .order("entry_time", { ascending: true });
  if (error) throw new Error(`scalp position load failed: ${error.message}`);
  return (data ?? []) as ScalpPositionRow[];
}

function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

async function resetDailyRiskIfNeeded(
  state: ScalpStateRow
): Promise<ScalpStateRow> {
  if (state.daily_date === utcDate()) return state;

  const { data, error } = await supabase
    .from("scalp_state")
    .update({
      entries_today: 0,
      daily_date: utcDate(),
      daily_realized_pnl_sol: 0,
      consecutive_losses: 0,
      halted: false,
      halt_reason: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1)
    .select("*")
    .single();
  if (error) throw new Error(`scalp daily reset failed: ${error.message}`);
  return data as ScalpStateRow;
}

async function isCoolingDown(mint: string): Promise<boolean> {
  const cutoff = new Date(
    Date.now() - SCALP_RULES.cooldownMinutes * 60_000
  ).toISOString();
  const { data, error } = await supabase
    .from("scalp_trades")
    .select("id")
    .eq("mint", mint)
    .gte("closed_at", cutoff)
    .limit(1);
  if (error) throw new Error(`scalp cooldown lookup failed: ${error.message}`);
  return Boolean(data?.length);
}

async function recordScan(input: {
  startedAt: string;
  status: "ok" | "error" | "skipped";
  scannedCount?: number;
  qualifiedCount?: number;
  top?: EvaluatedCandidate | null;
  selectedDecision?: ScalpEntryDecision | null;
  candidateAudits?: CandidateAudit[];
  message?: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const selected = input.selectedDecision ?? null;
  const audit = buildScalpScanAudit({
    strategyVersion: STRATEGY_VERSION,
    topBeforeSelection: input.top ?? null,
    selectedDecision: selected,
    candidateDecisions: input.candidateAudits ?? [],
  });
  const { error } = await supabase.from("scalp_scan_runs").insert({
    started_at: input.startedAt,
    finished_at: now,
    status: input.status,
    scanned_count: input.scannedCount ?? 0,
    qualified_count: input.qualifiedCount ?? 0,
    top_symbol: audit.topSymbol,
    top_mint: audit.topMint,
    top_score: audit.topScore,
    selected_mint: audit.selectedMint,
    message: input.message ?? null,
    top_snapshot: audit.snapshot,
  });
  if (error) {
    console.error("[momentum-scalper] scan audit insert failed:", error);
  }

  await supabase
    .from("scalp_state")
    .update({ last_scan_at: now, updated_at: now })
    .eq("id", 1);

  if (Math.random() < 0.02) {
    await supabase
      .from("scalp_scan_runs")
      .delete()
      .lt("started_at", new Date(Date.now() - 30 * 86_400_000).toISOString());
  }
}

async function openScalp(
  state: ScalpStateRow,
  decision: ScalpEntryDecision
): Promise<void> {
  assertScalpEntryDecision(decision);
  const candidate = decision.candidate;
  const market = decision.market;

  const sizeSol = Math.min(
    SCALP_RULES.fixedSizeSol,
    numberValue(state.bankroll_sol)
  );
  if (sizeSol < SCALP_RULES.fixedSizeSol) {
    throw new Error("paper bankroll below the fixed 0.05 SOL scalp size");
  }

  const openedAt = new Date().toISOString();
  const positionId = `scalp_${randomUUID()}`;
  const entrySnapshot = {
    strategyVersion: STRATEGY_VERSION,
    source: "geckoterminal_trending",
    selectedMint: decision.selectedMint,
    candidate: decision.candidate,
    score: decision.discovery.score,
    filterDecision: decision,
    friction: {
      entryPct: SCALP_RULES.entryFrictionPct * 100,
      exitPct: SCALP_RULES.exitFrictionPct * 100,
    },
  };

  // Re-check the immutable decision immediately before the state-changing RPC.
  assertScalpEntryDecision(decision);
  const { error } = await supabase.rpc("open_paper_scalp", {
    p_position_id: positionId,
    p_mint: candidate.mint,
    p_token_symbol: candidate.symbol,
    p_pair_address: market.pairAddress || candidate.pairAddress,
    p_entry_price_usd: market.priceUsd,
    p_entry_time: openedAt,
    p_size_sol: sizeSol,
    p_entry_snapshot: entrySnapshot,
  });
  if (error) throw new Error(`paper scalp open failed: ${error.message}`);

  console.log(
    `[MOMENTUM SCALP OPEN] ${candidate.symbol} | ${sizeSol.toFixed(3)} SOL | ` +
      `m5 ${signed(candidate.fiveMinuteChangePct, 1)}% | score ${decision.discovery.score}`
  );

  try {
    await sendTelegramAlert(
      [
      "⚡ <b>PAPER MOMENTUM SCALP OPENED</b>",
      "",
      `🪙 <b>${escapeHtml(candidate.symbol)}</b>`,
      `Size: <b>${sizeSol.toFixed(3)} SOL</b>`,
      `5m discovery: <b>${signed(candidate.fiveMinuteChangePct, 1)}%</b>`,
      `5m confirmation: <b>${signed(market.fiveMinuteChangePct, 1)}%</b>`,
      `5m volume: <b>$${Math.round(candidate.fiveMinuteVolumeUsd).toLocaleString()}</b>`,
      `Liquidity: <b>$${Math.round(market.liquidityUsd).toLocaleString()}</b>`,
      `Signal score: <b>${decision.discovery.score}/100</b>`,
      "",
      "Target: +4.0% net • Stop: -2.5% net • Max hold: 7 min",
      "Entry required a completed 1m pullback and hold above its short-term level.",
      "Includes 1.2% simulated round-trip friction.",
      "",
      `<a href="https://dexscreener.com/solana/${candidate.mint}">Open DexScreener</a>`,
      "",
      "🧪 Paper only — no real wallet or SOL is connected.",
      ].join("\n")
    );
  } catch (error) {
    console.warn("[momentum-scalper] open alert failed after position opened:", error);
  }
}

export async function runMomentumScalperScan(): Promise<void> {
  const startedAt = new Date().toISOString();
  let scannedCount = 0;
  let qualifiedCount = 0;
  let topForAudit: EvaluatedCandidate | null = null;
  let candidateAudits: CandidateAudit[] = [];
  let openedDecision: ScalpEntryDecision | null = null;

  try {
    let state = await loadState();
    state = await resetDailyRiskIfNeeded(state);

    if (
      state.enabled &&
      !state.halted &&
      state.entries_today >= SCALP_RULES.maxDailyEntries
    ) {
      const { data, error } = await supabase
        .from("scalp_state")
        .update({
          halted: true,
          halt_reason: "daily_entry_limit",
          updated_at: new Date().toISOString(),
        })
        .eq("id", 1)
        .select("*")
        .single();
      if (error) {
        throw new Error(`scalp daily-entry halt failed: ${error.message}`);
      }
      state = data as ScalpStateRow;
    }

    if (!state.enabled || state.halted) {
      await recordScan({
        startedAt,
        status: "skipped",
        message: !state.enabled
          ? "scalper_disabled"
          : state.halt_reason ?? "risk_guard_halted",
      });
      return;
    }

    const positions = await loadPositions();
    if (positions.length > 0) return;

    const candidates = await loadTrendingCandidates();
    const evaluated = candidates
      .map((candidate) => ({
        candidate,
        evaluation: evaluateScalpCandidate(candidate),
      }))
      .sort((left, right) => right.evaluation.score - left.evaluation.score);
    const qualified = evaluated.filter((item) => item.evaluation.accepted);
    scannedCount = candidates.length;
    qualifiedCount = qualified.length;
    topForAudit = evaluated[0] ?? null;
    candidateAudits = evaluated.map((item) => ({
      ...item,
      cooldown: "not_checked",
      confirmation: null,
      pullback: null,
      bindingChecks: null,
      acceptedForEntry: false,
      reasons: [...item.evaluation.reasons],
    }));
    let approvedDecision: ScalpEntryDecision | null = null;
    let entryFilterRejections = 0;
    let cooldownRejections = 0;

    for (const item of qualified) {
      const audit = candidateAudits.find(
        (candidateAudit) => candidateAudit.candidate.mint === item.candidate.mint
      );
      if (await isCoolingDown(item.candidate.mint)) {
        cooldownRejections += 1;
        if (audit) {
          audit.cooldown = "rejected";
          audit.reasons = [...new Set([...audit.reasons, "candidate_in_cooldown"])];
        }
        continue;
      }
      if (audit) audit.cooldown = "passed";

      try {
        const market = await fetchDexSnapshot(item.candidate.mint);
        const minuteCandles = await fetchMinuteCandles(item.candidate.pairAddress);
        const decision = buildScalpEntryDecision({
          candidate: item.candidate,
          market,
          minuteCandles,
          pullbackPairAddress: item.candidate.pairAddress,
        });
        if (audit) {
          audit.confirmation = decision.confirmation;
          audit.pullback = decision.pullback;
          audit.bindingChecks = decision.bindingChecks;
          audit.acceptedForEntry = decision.accepted;
          audit.reasons = [...decision.reasons];
        }
        if (!decision.accepted) {
          entryFilterRejections += 1;
          console.log(
            `[MOMENTUM SCALP REJECT] ${item.candidate.symbol}: ` +
              decision.reasons.join(",")
          );
          continue;
        }
        approvedDecision = decision;
        break;
      } catch (error) {
        entryFilterRejections += 1;
        const reason = error instanceof Error ? error.message : String(error);
        if (audit) {
          audit.acceptedForEntry = false;
          audit.reasons = [
            ...new Set([...audit.reasons, `entry_data_fetch_failed:${reason}`]),
          ];
        }
        console.warn(
          `[momentum-scalper] entry confirmation failed for ${item.candidate.symbol}:`,
          error
        );
      }
    }

    if (approvedDecision) {
      await openScalp(state, approvedDecision);
      openedDecision = approvedDecision;
    }

    const message = openedDecision
      ? "paper_scalp_opened"
      : entryFilterRejections > 0
        ? `entry_filters_rejected:${entryFilterRejections}`
        : cooldownRejections > 0
          ? "qualified_candidates_in_cooldown"
          : topForAudit
            ? `no_entry: ${topForAudit.evaluation.reasons.slice(0, 3).join(",")}`
            : "no_trending_candidates";

    await recordScan({
      startedAt,
      status: "ok",
      scannedCount,
      qualifiedCount,
      top: topForAudit,
      selectedDecision: openedDecision,
      candidateAudits,
      message,
    });

    console.log(
      `[momentum-scalper] scanned ${scannedCount}; qualified ${qualifiedCount}; ` +
        `${openedDecision ? `opened ${openedDecision.candidate.symbol}` : message}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[momentum-scalper] scan failed:", error);
    await recordScan({
      startedAt,
      status: "error",
      scannedCount,
      qualifiedCount,
      top: topForAudit,
      selectedDecision: openedDecision,
      candidateAudits,
      message,
    });
  }
}

export async function checkMomentumScalpPositions(): Promise<void> {
  const positions = await loadPositions();

  for (const position of positions) {
    try {
      const market = await fetchDexSnapshot(position.mint);
      const entryPriceUsd = numberValue(position.entry_price_usd);
      const peakPriceUsd = Math.max(
        numberValue(position.peak_price_usd),
        market.priceUsd
      );
      const nowMs = Date.now();
      const decision = decideScalpExit({
        entryPriceUsd,
        currentPriceUsd: market.priceUsd,
        peakPriceUsd,
        openedAtMs: Date.parse(position.entry_time),
        nowMs,
      });
      const now = new Date(nowMs).toISOString();

      if (!decision) {
        const { error } = await supabase
          .from("scalp_positions")
          .update({
            peak_price_usd: peakPriceUsd,
            last_price_usd: market.priceUsd,
            last_checked_at: now,
            updated_at: now,
          })
          .eq("position_id", position.position_id);
        if (error) {
          throw new Error(`scalp mark update failed: ${error.message}`);
        }
        continue;
      }

      const sizeSol = numberValue(position.size_sol);
      const proceedsSol = sizeSol * decision.netMultiple;
      const pnlSol = proceedsSol - sizeSol;
      const exitSnapshot = {
        source: "dexscreener",
        market,
        peakPriceUsd,
        priceMultiple: market.priceUsd / entryPriceUsd,
        netMultiple: decision.netMultiple,
        friction: {
          entryPct: SCALP_RULES.entryFrictionPct * 100,
          exitPct: SCALP_RULES.exitFrictionPct * 100,
        },
      };

      const { data, error } = await supabase.rpc("close_paper_scalp", {
        p_position_id: position.position_id,
        p_exit_price_usd: market.priceUsd,
        p_gross_return_pct: decision.grossReturnPct,
        p_net_return_pct: decision.netReturnPct,
        p_pnl_sol: pnlSol,
        p_proceeds_sol: proceedsSol,
        p_exit_reason: decision.reason,
        p_closed_at: now,
        p_exit_snapshot: exitSnapshot,
      });
      if (error) throw new Error(`paper scalp close failed: ${error.message}`);

      const closeResult = (data ?? {}) as Record<string, unknown>;
      const bankrollSol = numberValue(closeResult.bankrollSol, NaN);
      const profitable = pnlSol >= 0;
      console.log(
        `[MOMENTUM SCALP CLOSE] ${position.token_symbol} | ${decision.reason} | ` +
          `net ${signed(decision.netReturnPct, 2)}% | PnL ${signed(pnlSol, 5)} SOL`
      );

      await sendTelegramAlert(
        [
          `${profitable ? "✅" : "🔴"} <b>PAPER MOMENTUM SCALP CLOSED</b>`,
          "",
          `🪙 <b>${escapeHtml(position.token_symbol)}</b>`,
          `Reason: <b>${decision.reason.replaceAll("_", " ")}</b>`,
          `Gross move: <b>${signed(decision.grossReturnPct, 2)}%</b>`,
          `Net after friction: <b>${signed(decision.netReturnPct, 2)}%</b>`,
          `Paper PnL: <b>${signed(pnlSol, 5)} SOL</b>`,
          Number.isFinite(bankrollSol)
            ? `Scalper bankroll: <b>${bankrollSol.toFixed(4)} SOL</b>`
            : "",
          closeResult.halted
            ? `🛑 Risk guard: <b>${escapeHtml(closeResult.haltReason)}</b>`
            : "",
          "",
          "🧪 Paper only — this is measured simulation, not guaranteed profit.",
        ]
          .filter(Boolean)
          .join("\n")
      );
    } catch (error) {
      console.error(
        `[momentum-scalper] ${position.token_symbol} position check failed:`,
        error
      );
    }
  }
}

async function scanSafely(): Promise<void> {
  if (scanRunning) return;
  scanRunning = true;
  try {
    await runMomentumScalperScan();
  } finally {
    scanRunning = false;
  }
}

async function checkPositionsSafely(): Promise<void> {
  if (positionCheckRunning) return;
  positionCheckRunning = true;
  try {
    await checkMomentumScalpPositions();
  } finally {
    positionCheckRunning = false;
  }
}

export function startMomentumScalperScheduler(): void {
  if (!envEnabled("ENABLE_MOMENTUM_SCALPER", true)) {
    console.log("[momentum-scalper] disabled by ENABLE_MOMENTUM_SCALPER");
    return;
  }

  console.log(
    `[momentum-scalper] paper-only wallet-free strategy enabled; ` +
      `scan ${SCAN_INTERVAL_MS / 1000}s; position check ${POSITION_CHECK_INTERVAL_MS / 1000}s; ` +
      `size ${SCALP_RULES.fixedSizeSol.toFixed(2)} SOL`
  );

  void scanSafely().catch((error) =>
    console.error("[momentum-scalper] initial scan failed:", error)
  );
  void checkPositionsSafely().catch((error) =>
    console.error("[momentum-scalper] initial position check failed:", error)
  );

  setInterval(() => {
    void scanSafely().catch((error) =>
      console.error("[momentum-scalper] scheduled scan failed:", error)
    );
  }, SCAN_INTERVAL_MS);

  setInterval(() => {
    void checkPositionsSafely().catch((error) =>
      console.error("[momentum-scalper] scheduled position check failed:", error)
    );
  }, POSITION_CHECK_INTERVAL_MS);
}
