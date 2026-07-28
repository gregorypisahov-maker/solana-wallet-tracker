import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "../lib/supabase";
import { sendTelegramAlert } from "../lib/telegram";
import {
  getJupiterQuote,
  JUPITER_SOL_MINT,
  type JupiterQuoteOnlyResult,
} from "../lib/jupiterQuote";
import { PAPER_COST_MODEL } from "./executionCosts";
import { evaluateLiveEntrySafety } from "../live-executor/liveSafety";

const supabase = getSupabaseAdmin();
const VERSION = "ai_discovery_trader_v1_9_shared_entry_safety_2026_07_28";
const PAPER_ENTRY_SAFETY_ENABLED = process.env.AI_PAPER_ENTRY_SAFETY_ENABLED !== "false";
const PAPER_ENTRY_SAFETY_ENFORCE = process.env.AI_PAPER_ENTRY_SAFETY_ENFORCE !== "false";
const SHADOW_MODEL_VERSION = "baseline_v1_2026_07_24";
const DEX_URL = "https://api.dexscreener.com/tokens/v1/solana";
const FIXED_SIZE_SOL = 0.2;
const MAX_CONSECUTIVE_LOSSES = Math.max(3, Number(process.env.AI_MAX_CONSECUTIVE_LOSSES) || 5);
const CONSECUTIVE_LOSS_COOLDOWN_MS = Math.max(15 * 60_000, Number(process.env.AI_CONSECUTIVE_LOSS_COOLDOWN_MS) || 60 * 60_000);
const DAILY_LOSS_LIMIT_SOL = 0.05;
const MIN_SCORE = 82;
const MAX_OPPORTUNITY_AGE_MS = 3 * 60_000;
const COOLDOWN_MS = 2 * 60 * 60_000;
const HARD_STOP_PCT = -6;
const TAKE_PROFIT_PCT = 10;
const TRAIL_ARM_PCT = 6;
const TRAIL_DISTANCE_PCT = 4;
const MAX_HOLD_MS = 45 * 60_000;
const MAX_QUOTE_FAIL_STREAK = Math.max(
  1,
  Math.min(10, Number(process.env.AI_MAX_QUOTE_FAIL_STREAK) || 3)
);
const REQUEST_TIMEOUT_MS = 12_000;
const DEX_MIN_INTERVAL_MS = Math.max(
  250,
  Math.min(5_000, Number(process.env.AI_DEX_MIN_INTERVAL_MS) || 750)
);
const DEX_CACHE_TTL_MS = Math.max(
  1_000,
  Math.min(60_000, Number(process.env.AI_DEX_CACHE_TTL_MS) || 15_000)
);
const DEX_MAX_RETRIES = Math.max(
  0,
  Math.min(5, Number(process.env.AI_DEX_MAX_RETRIES) || 2)
);
const OUTCOME_BATCH_SIZE = Math.max(
  1,
  Math.min(10, Number(process.env.AI_OUTCOME_BATCH_SIZE) || 3)
);
const OUTCOME_HORIZONS = [5, 15, 30, 45] as const;
const LAMPORTS_PER_SOL = 1_000_000_000;
const QUOTE_EXITS_ENABLED = process.env.AI_PAPER_QUOTE_EXITS_ENABLED !== "false";
const QUOTE_SLIPPAGE_BPS = Math.min(
  200,
  Math.max(10, Number(process.env.LIVE_MAX_SLIPPAGE_BPS) || 100)
);
const EMERGENCY_EXIT_FLOOR_PCT = Math.min(
  100,
  Math.max(0, Number(process.env.EMERGENCY_EXIT_FLOOR_PCT) || 30)
);

let scanRunning = false;
let positionRunning = false;
let outcomeRunning = false;
let lastSummaryAt = 0;
let dexRequestTail: Promise<void> = Promise.resolve();
let lastDexRequestAt = 0;
let dexCooldownUntil = 0;

const dexCache = new Map<
  string,
  { expiresAt: number; value: unknown }
>();
const dexInflight = new Map<string, Promise<any>>();

type State = {
  enabled: boolean;
  halted: boolean;
  halt_reason: string | null;
  bankroll_sol: number | string;
  entries_today: number;
  daily_date: string;
  daily_realized_pnl_sol: number | string;
  consecutive_losses: number;
  updated_at: string;
};

type Position = {
  position_id: string;
  mint: string;
  token_symbol: string;
  pair_address: string;
  entry_price_usd: number | string;
  last_price_usd: number | string;
  peak_price_usd: number | string;
  size_sol: number | string;
  token_amount: string | null;
  quote_peak_value_sol: number | string | null;
  last_executable_value_sol: number | string | null;
  quote_fail_streak: number | string | null;
  opened_at: string;
  entry_snapshot: Record<string, unknown>;
};

type Market = {
  priceUsd: number;
  liquidityUsd: number;
  marketCapUsd: number;
  changeM5: number;
};

type LiveMirror = {
  token_amount: string;
  spent_sol: number | string;
  proceeds_sol: number | string | null;
  realized_pnl_sol: number | string | null;
  status: string;
  closed_at: string | null;
};

type ExitValuation = {
  source: "quote" | "live_mirror";
  route: boolean;
  outLamports: bigint;
  executableSol: number;
  proceedsSol: number;
  impliedPriceUsd: number;
  entryValueSol: number;
  quoteCallFailed?: boolean;
  quoteError?: string;
  rawQuote?: Record<string, unknown> | null;
};

function n(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function enabled(): boolean {
  const raw = process.env.ENABLE_AI_DISCOVERY_TRADER?.trim().toLowerCase();
  return !raw || !["0", "false", "off", "no"].includes(raw);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(response: Response, attempt: number): number {
  const raw = response.headers.get("retry-after");
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.max(1_000, seconds * 1_000);
    }
    const dateMs = Date.parse(raw);
    if (Number.isFinite(dateMs)) {
      return Math.max(1_000, dateMs - Date.now());
    }
  }
  return Math.min(30_000, 1_500 * 2 ** attempt);
}

async function fetchDexJsonWithRetry(url: string): Promise<any> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= DEX_MAX_RETRIES; attempt += 1) {
    const paceUntil = Math.max(
      dexCooldownUntil,
      lastDexRequestAt + DEX_MIN_INTERVAL_MS
    );
    const waitMs = paceUntil - Date.now();
    if (waitMs > 0) await sleep(waitMs);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      lastDexRequestAt = Date.now();
      const response = await fetch(url, {
        cache: "no-store",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });

      if (response.ok) {
        return await response.json();
      }

      const error = new Error(`${response.status} ${response.statusText}`);
      lastError = error;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= DEX_MAX_RETRIES) throw error;

      const backoffMs = retryAfterMs(response, attempt);
      dexCooldownUntil = Math.max(dexCooldownUntil, Date.now() + backoffMs);
      console.warn(
        `[ai-discovery-trader] DexScreener ${response.status}; ` +
          `backing off ${backoffMs}ms (attempt ${attempt + 1}/${DEX_MAX_RETRIES + 1})`
      );
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      lastError = normalized;
      const isAbort = normalized.name === "AbortError";
      const isRetryableNetworkError =
        isAbort || /fetch|network|timeout|socket/i.test(normalized.message);
      if (!isRetryableNetworkError || attempt >= DEX_MAX_RETRIES) {
        throw normalized;
      }
      const backoffMs = Math.min(30_000, 1_500 * 2 ** attempt);
      dexCooldownUntil = Math.max(dexCooldownUntil, Date.now() + backoffMs);
      console.warn(
        `[ai-discovery-trader] DexScreener request failed; ` +
          `backing off ${backoffMs}ms (attempt ${attempt + 1}/${DEX_MAX_RETRIES + 1})`,
        normalized
      );
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new Error("DexScreener request failed");
}

async function fetchJson(url: string): Promise<any> {
  const cached = dexCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) dexCache.delete(url);

  const existing = dexInflight.get(url);
  if (existing) return existing;

  let resolveTask!: (value: any) => void;
  let rejectTask!: (reason?: unknown) => void;
  const task = new Promise<any>((resolve, reject) => {
    resolveTask = resolve;
    rejectTask = reject;
  });
  dexInflight.set(url, task);

  dexRequestTail = dexRequestTail
    .catch(() => undefined)
    .then(async () => {
      try {
        const value = await fetchDexJsonWithRetry(url);
        dexCache.set(url, {
          value,
          expiresAt: Date.now() + DEX_CACHE_TTL_MS,
        });
        resolveTask(value);
      } catch (error) {
        rejectTask(error);
      } finally {
        dexInflight.delete(url);
      }
    });

  return task;
}

async function pairFor(
  mint: string,
  pairAddress: string,
  minimumLiquidity = 0
): Promise<Market | null> {
  const body = await fetchJson(`${DEX_URL}/${encodeURIComponent(mint)}`);
  const pairs = Array.isArray(body) ? body : [];
  const pair = pairs.find(
    (item: any) =>
      item?.chainId === "solana" &&
      String(item?.pairAddress ?? "") === pairAddress &&
      item?.baseToken?.address === mint
  );
  if (!pair) return null;

  const priceUsd = n(pair?.priceUsd, Number.NaN);
  const liquidityUsd = n(pair?.liquidity?.usd, Number.NaN);
  if (
    !Number.isFinite(priceUsd) ||
    priceUsd <= 0 ||
    !Number.isFinite(liquidityUsd) ||
    liquidityUsd < minimumLiquidity
  ) {
    return null;
  }

  return {
    priceUsd,
    liquidityUsd,
    marketCapUsd: n(pair?.marketCap ?? pair?.fdv, 0),
    changeM5: n(pair?.priceChange?.m5, 0),
  };
}

async function priceFor(mint: string, pairAddress: string): Promise<Market | null> {
  return pairFor(mint, pairAddress, 25_000);
}

async function loadState(): Promise<State> {
  const { data, error } = await supabase
    .from("ai_discovery_state")
    .select("*")
    .eq("id", 1)
    .single();
  if (error) throw new Error(error.message);
  return data as State;
}

async function resetDay(state: State): Promise<State> {
  const today = new Date().toISOString().slice(0, 10);
  if (state.daily_date === today) return state;

  const { data, error } = await supabase
    .from("ai_discovery_state")
    .update({
      entries_today: 0,
      daily_date: today,
      daily_realized_pnl_sol: 0,
      consecutive_losses: 0,
      halted: false,
      halt_reason: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as State;
}

async function loadPositions(): Promise<Position[]> {
  const { data, error } = await supabase
    .from("ai_discovery_positions")
    .select("*")
    .order("opened_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as Position[];
}

async function cooledDown(mint: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - COOLDOWN_MS).toISOString();
  const { data, error } = await supabase
    .from("ai_discovery_trades")
    .select("id")
    .eq("mint", mint)
    .gte("closed_at", cutoff)
    .limit(1);
  if (error) throw new Error(error.message);
  return Boolean(data?.length);
}

function baselineProbability(opportunity: any): number {
  const score = n(opportunity.score);
  const liquidity = n(opportunity.liquidity_usd);
  const momentum = n(opportunity.price_change_m5);
  const buyers = n(opportunity.buyers_m5);
  const sells = n(opportunity.sells_m5);
  const riskCount = Array.isArray(opportunity.risks) ? opportunity.risks.length : 0;
  const regimeBoost =
    opportunity.market_regime === "bullish"
      ? 8
      : opportunity.market_regime === "neutral"
        ? 0
        : -12;
  const raw =
    25 +
    (score - 70) * 1.2 +
    Math.log10(Math.max(liquidity, 1)) * 4 +
    clamp(momentum, -10, 10) * 1.1 +
    clamp((buyers - sells) / Math.max(buyers + sells, 1), -1, 1) * 12 +
    regimeBoost -
    riskCount * 12;
  return Number(clamp(raw, 1, 99).toFixed(2));
}

function ruleAssessment(opportunity: any): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (opportunity.status !== "armed") reasons.push("not_armed");
  if (n(opportunity.score) < MIN_SCORE) reasons.push("score_below_minimum");
  if ((opportunity.risks ?? []).length > 1) reasons.push("too_many_risks");
  if (!opportunity.pair_address) reasons.push("missing_pair");
  return { passed: reasons.length === 0, reasons };
}

async function recordObservation(
  opportunity: any,
  assessment: { passed: boolean; reasons: string[] }
): Promise<number | null> {
  const cutoff = new Date(Date.now() - 2 * 60_000).toISOString();
  const { data: existing } = await supabase
    .from("ai_candidate_observations")
    .select("id")
    .eq("mint", opportunity.mint)
    .gte("observed_at", cutoff)
    .limit(1);
  if (existing?.length) return Number(existing[0].id);

  const features = {
    score: n(opportunity.score),
    confidence: opportunity.confidence,
    status: opportunity.status,
    marketRegime: opportunity.market_regime,
    liquidityUsd: n(opportunity.liquidity_usd),
    marketCapUsd: n(opportunity.market_cap_usd),
    priceChangeM5: n(opportunity.price_change_m5),
    priceChangeH1: n(opportunity.price_change_h1),
    volumeM5Usd: n(opportunity.volume_m5_usd),
    volumeH1Usd: n(opportunity.volume_h1_usd),
    buysM5: n(opportunity.buys_m5),
    sellsM5: n(opportunity.sells_m5),
    buyersM5: n(opportunity.buyers_m5),
    poolAgeMinutes: n(opportunity.pool_age_minutes),
    reasons: opportunity.reasons ?? [],
    risks: opportunity.risks ?? [],
  };

  const { data, error } = await supabase
    .from("ai_candidate_observations")
    .insert({
      mint: opportunity.mint,
      token_symbol: opportunity.token_symbol,
      pair_address: opportunity.pair_address,
      source_last_seen_at: opportunity.last_seen_at,
      features,
      rules_passed: assessment.passed,
      decision: assessment.passed ? "observe" : "reject",
      rejection_reasons: assessment.reasons,
      baseline_probability: baselineProbability(opportunity),
      model_version: SHADOW_MODEL_VERSION,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return Number(data.id);
}

async function markObservationEntered(
  id: number | null,
  entryPriceUsd: number
): Promise<void> {
  if (!id) return;
  await supabase
    .from("ai_candidate_observations")
    .update({
      entered: true,
      decision: "enter",
      entry_price_usd: entryPriceUsd,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
}

async function collectCandidateObservations(cutoff: string): Promise<any[]> {
  const { data, error } = await supabase
    .from("market_opportunities")
    .select("*")
    .gte("last_seen_at", cutoff)
    .order("score", { ascending: false })
    .limit(30);
  if (error) throw new Error(error.message);

  for (const opportunity of data ?? []) {
    try {
      await recordObservation(opportunity, ruleAssessment(opportunity));
    } catch (error) {
      console.warn(
        `[ai-discovery-trader] observation failed for ${opportunity.token_symbol}`,
        error
      );
    }
  }
  return data ?? [];
}

async function maybeSummary(): Promise<void> {
  if (Date.now() - lastSummaryAt < 30 * 60_000) return;
  lastSummaryAt = Date.now();

  const { data } = await supabase
    .from("market_opportunities")
    .select("token_symbol,score,status,market_regime,reasons,risks,last_seen_at")
    .order("score", { ascending: false })
    .limit(3);
  if (!data?.length) return;

  const lines = data.map(
    (row: any, index: number) =>
      `${index + 1}. <b>${row.token_symbol}</b> — ${row.score}/100 · ${row.status}\n` +
      `${(row.reasons ?? []).slice(0, 2).join(", ")}` +
      `${row.risks?.length ? ` · risk: ${row.risks.slice(0, 1).join(", ")}` : ""}`
  );
  await sendTelegramAlert(
    [
      "🧠 <b>AI MARKET DISCOVERY UPDATE</b>",
      `Regime: <b>${data[0]?.market_regime ?? "unknown"}</b>`,
      "",
      ...lines,
      "",
      "Paper execution only.",
    ].join("\n")
  );
}

async function paperEntryTokenAmount(
  mint: string,
  sizeSol: number
): Promise<{ tokenAmount: string | null; quote: Record<string, unknown> | null }> {
  try {
    const quote = await getJupiterQuote({
      inputMint: JUPITER_SOL_MINT,
      outputMint: mint,
      rawTokenAmount: String(Math.floor(sizeSol * LAMPORTS_PER_SOL)),
      slippageBps: QUOTE_SLIPPAGE_BPS,
    });
    return {
      tokenAmount: quote.route ? String(quote.outLamports) : null,
      quote: quote.raw,
    };
  } catch (error) {
    console.warn("[ai-discovery-trader] entry token amount quote failed", error);
    return { tokenAmount: null, quote: null };
  }
}

async function openTrade(
  state: State,
  opportunity: any,
  market: Market,
  observationId: number | null
): Promise<void> {
  const sizeSol = Math.min(FIXED_SIZE_SOL, n(state.bankroll_sol));
  if (sizeSol < FIXED_SIZE_SOL) return;

  const now = new Date().toISOString();
  const positionId = `ai_${randomUUID()}`;
  const entryQuote = await paperEntryTokenAmount(opportunity.mint, sizeSol);
  const snapshot = {
    version: VERSION,
    opportunity,
    market,
    observationId,
    quoteExitAccounting: true,
    entryQuote: entryQuote.quote,
  };

  const { error } = await supabase.from("ai_discovery_positions").insert({
    position_id: positionId,
    mint: opportunity.mint,
    token_symbol: opportunity.token_symbol,
    pair_address: opportunity.pair_address,
    entry_price_usd: market.priceUsd,
    last_price_usd: market.priceUsd,
    peak_price_usd: market.priceUsd,
    size_sol: sizeSol,
    token_amount: entryQuote.tokenAmount,
    quote_peak_value_sol: sizeSol,
    last_executable_value_sol: sizeSol,
    opened_at: now,
    last_checked_at: now,
    entry_snapshot: snapshot,
    updated_at: now,
  });
  if (error) throw new Error(error.message);

  await supabase
    .from("ai_discovery_state")
    .update({
      bankroll_sol: n(state.bankroll_sol) - sizeSol,
      entries_today: state.entries_today + 1,
      last_entry_at: now,
      last_scan_at: now,
      updated_at: now,
    })
    .eq("id", 1);

  await markObservationEntered(observationId, market.priceUsd);
  await sendTelegramAlert(
    [
      "🧠⚡ <b>AI DISCOVERY PAPER TRADE OPENED</b>",
      "",
      `Token: <b>${opportunity.token_symbol}</b>`,
      `Score: <b>${opportunity.score}/100</b>`,
      `Size: <b>${sizeSol.toFixed(3)} SOL</b>`,
      `Liquidity: <b>$${Math.round(market.liquidityUsd).toLocaleString()}</b>`,
      `Reasons: ${(opportunity.reasons ?? []).slice(0, 3).join(", ")}`,
      "",
      `<a href="https://dexscreener.com/solana/${opportunity.pair_address}">Open chart</a>`,
      "",
      "🧪 Paper only — no real SOL used.",
    ].join("\n")
  );
}

async function scanEntries(): Promise<void> {
  if (scanRunning) return;
  scanRunning = true;
  try {
    const state = await resetDay(await loadState());
    const now = new Date().toISOString();
    await supabase
      .from("ai_discovery_state")
      .update({ last_scan_at: now, updated_at: now })
      .eq("id", 1);

    await maybeSummary().catch((error) =>
      console.warn("[ai-discovery-trader] summary failed", error)
    );

    const cutoff = new Date(Date.now() - MAX_OPPORTUNITY_AGE_MS).toISOString();
    const opportunities = await collectCandidateObservations(cutoff);
    if (!state.enabled) return;
    if (state.halted) {
      const haltedForMs = Date.now() - Date.parse(state.updated_at);
      if (state.halt_reason === "consecutive_loss_limit" && Number.isFinite(haltedForMs) && haltedForMs >= CONSECUTIVE_LOSS_COOLDOWN_MS) {
        const resumedAt = new Date().toISOString();
        await supabase.from("ai_discovery_state").update({ halted: false, halt_reason: null, consecutive_losses: 0, updated_at: resumedAt }).eq("id", 1);
        state.halted = false; state.halt_reason = null; state.consecutive_losses = 0; state.updated_at = resumedAt;
        console.warn("[ai-discovery-trader] auto-resumed after consecutive-loss cooldown");
      } else return;
    }

    if (
      n(state.daily_realized_pnl_sol) <= -DAILY_LOSS_LIMIT_SOL ||
      state.consecutive_losses >= MAX_CONSECUTIVE_LOSSES
    ) {
      const reason =
        n(state.daily_realized_pnl_sol) <= -DAILY_LOSS_LIMIT_SOL
          ? "daily_loss_limit"
          : "consecutive_loss_limit";
      await supabase
        .from("ai_discovery_state")
        .update({ halted: true, halt_reason: reason, updated_at: now })
        .eq("id", 1);
      return;
    }

    if ((await loadPositions()).length > 0) return;
    for (const opportunity of opportunities.filter(
      (item: any) => ruleAssessment(item).passed
    )) {
      const observationId = await recordObservation(
        opportunity,
        ruleAssessment(opportunity)
      );
      if (await cooledDown(opportunity.mint)) continue;
      try {
        const market = await priceFor(opportunity.mint, opportunity.pair_address);
        if (!market || market.changeM5 < 0 || market.changeM5 > 15) continue;
        if (PAPER_ENTRY_SAFETY_ENABLED) {
          const safety = await evaluateLiveEntrySafety({ mint: opportunity.mint, sizeSol: FIXED_SIZE_SOL, slippageBps: QUOTE_SLIPPAGE_BPS });
          await supabase.from("ai_entry_screen_observations").insert({ mint: opportunity.mint, symbol: opportunity.token_symbol ?? null, passed: safety.passed, check_failed: safety.reason, snapshot: safety.details, enforcement_enabled: PAPER_ENTRY_SAFETY_ENFORCE });
          opportunity.entry_safety = { passed: safety.passed, reason: safety.reason, ...safety.details };
          if (!safety.passed && PAPER_ENTRY_SAFETY_ENFORCE) { console.warn(`[ai-discovery-trader] paper entry blocked ${opportunity.token_symbol ?? opportunity.mint}: ${safety.reason}`); continue; }
        }
        await openTrade(state, opportunity, market, observationId);
        break;
      } catch (error) {
        console.warn(
          `[ai-discovery-trader] candidate ${opportunity.token_symbol} skipped`,
          error
        );
      }
    }
  } finally {
    scanRunning = false;
  }
}

async function trackCandidateOutcomes(): Promise<void> {
  if (outcomeRunning) return;
  outcomeRunning = true;
  try {
    const oldest = new Date(Date.now() - 48 * 60 * 60_000).toISOString();
    const { data, error } = await supabase
      .from("ai_candidate_observations")
      .select("*")
      .eq("outcome_complete", false)
      .gte("observed_at", oldest)
      .order("observed_at", { ascending: true })
      .limit(OUTCOME_BATCH_SIZE);
    if (error) throw new Error(error.message);

    for (const observation of data ?? []) {
      const ageMinutes =
        (Date.now() - Date.parse(observation.observed_at)) / 60_000;
      const due = OUTCOME_HORIZONS.filter(
        (minutes) =>
          ageMinutes >= minutes &&
          observation[`price_${minutes}m_usd`] == null
      );
      if (!due.length) continue;
      try {
        const market = await pairFor(
          observation.mint,
          observation.pair_address,
          0
        );
        if (!market) continue;
        const basePrice =
          n(
            observation.entry_price_usd ??
              observation.features?.priceUsd ??
              observation.features?.price_usd,
            0
          ) || n(observation.features?.priceUsd, 0);
        const effectiveBase =
          basePrice > 0
            ? basePrice
            : n(observation.features?.signalSnapshot?.priceUsd, 0);
        const updates: Record<string, unknown> = {
          updated_at: new Date().toISOString(),
        };
        for (const minutes of due) {
          updates[`price_${minutes}m_usd`] = market.priceUsd;
          updates[`return_${minutes}m_pct`] =
            effectiveBase > 0
              ? Number((((market.priceUsd / effectiveBase) - 1) * 100).toFixed(4))
              : null;
        }
        if (ageMinutes >= 45) updates.outcome_complete = true;
        await supabase
          .from("ai_candidate_observations")
          .update(updates)
          .eq("id", observation.id);
      } catch (error) {
        console.warn(
          `[ai-discovery-trader] outcome tracking failed for ${observation.token_symbol}`,
          error
        );
      }
    }
  } finally {
    outcomeRunning = false;
  }
}

async function liveMirrorFor(positionId: string): Promise<LiveMirror | null> {
  const { data, error } = await supabase
    .from("live_positions")
    .select("token_amount,spent_sol,proceeds_sol,realized_pnl_sol,status,closed_at")
    .eq("source_position_id", positionId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as LiveMirror | null;
}

async function syncPositionTokenAmount(
  position: Position,
  mirror: LiveMirror | null
): Promise<string | null> {
  if (mirror?.token_amount && mirror.token_amount !== position.token_amount) {
    await supabase
      .from("ai_discovery_positions")
      .update({ token_amount: mirror.token_amount, updated_at: new Date().toISOString() })
      .eq("position_id", position.position_id);
    position.token_amount = mirror.token_amount;
  }
  return position.token_amount;
}

async function quoteExitValuation(
  position: Position,
  mirror: LiveMirror | null
): Promise<ExitValuation> {
  const entryValueSol = Math.max(0, n(mirror?.spent_sol, n(position.size_sol)));
  const tokenAmount = await syncPositionTokenAmount(position, mirror);
  const entryPriceUsd = n(position.entry_price_usd);

  if (!QUOTE_EXITS_ENABLED) {
    const market = await pairFor(position.mint, position.pair_address, 0).catch(() => null);
    if (!market) {
      return {
        source: "quote",
        route: false,
        outLamports: 0n,
        executableSol: 0,
        proceedsSol: 0,
        impliedPriceUsd: 0,
        entryValueSol,
        quoteCallFailed: true,
        quoteError: "quote_exits_disabled_and_market_unavailable",
      };
    }
    const executableSol = Math.max(
      0,
      entryValueSol * (market.priceUsd / Math.max(entryPriceUsd, Number.EPSILON))
    );
    return {
      source: "quote",
      route: true,
      outLamports: BigInt(Math.floor(executableSol * LAMPORTS_PER_SOL)),
      executableSol,
      proceedsSol: Math.max(
        0,
        executableSol - PAPER_COST_MODEL.networkCostSolPerTransaction
      ),
      impliedPriceUsd: market.priceUsd,
      entryValueSol,
      quoteError: "quote_exits_disabled",
    };
  }

  if (!tokenAmount || !/^\d+$/.test(tokenAmount) || BigInt(tokenAmount) <= 0n) {
    return {
      source: "quote",
      route: false,
      outLamports: 0n,
      executableSol: 0,
      proceedsSol: 0,
      impliedPriceUsd: 0,
      entryValueSol,
      quoteCallFailed: true,
      quoteError: "missing_raw_token_amount",
    };
  }

  let quote: JupiterQuoteOnlyResult;
  try {
    quote = await getJupiterQuote({
      inputMint: position.mint,
      outputMint: JUPITER_SOL_MINT,
      rawTokenAmount: tokenAmount,
      slippageBps: QUOTE_SLIPPAGE_BPS,
    });
  } catch (error) {
    return {
      source: "quote",
      route: false,
      outLamports: 0n,
      executableSol: 0,
      proceedsSol: 0,
      impliedPriceUsd: 0,
      entryValueSol,
      quoteCallFailed: true,
      quoteError: error instanceof Error ? error.message : String(error),
    };
  }

  const executableSol = Number(quote.outLamports) / LAMPORTS_PER_SOL;
  const proceedsSol = Math.max(
    0,
    executableSol - PAPER_COST_MODEL.networkCostSolPerTransaction
  );
  const impliedPriceUsd =
    entryValueSol > 0
      ? entryPriceUsd * (executableSol / entryValueSol)
      : 0;
  return {
    source: "quote",
    route: quote.route,
    outLamports: quote.outLamports,
    executableSol,
    proceedsSol,
    impliedPriceUsd,
    entryValueSol,
    rawQuote: quote.raw,
  };
}

async function closeTrade(
  position: Position,
  valuation: ExitValuation,
  reason: string
): Promise<void> {
  const { data: existing, error: existingError } = await supabase
    .from("ai_discovery_trades")
    .select("id")
    .eq("position_id", position.position_id)
    .limit(1);
  if (existingError) throw new Error(existingError.message);
  if (existing?.length) {
    await supabase
      .from("ai_discovery_positions")
      .delete()
      .eq("position_id", position.position_id);
    return;
  }

  const sizeSol = n(position.size_sol);
  const proceeds = Math.max(0, valuation.proceedsSol);
  const pnlSol = proceeds - sizeSol;
  const grossPct = sizeSol > 0 ? ((valuation.executableSol / sizeSol) - 1) * 100 : -100;
  const netPct = sizeSol > 0 ? (pnlSol / sizeSol) * 100 : -100;
  const now = new Date().toISOString();
  const state = await loadState();

  console.log(
    `[ai-discovery-trader] exit quote ${position.token_symbol} ` +
      `outLamports=${valuation.outLamports.toString()} route=${valuation.route} ` +
      `impliedPrice=${valuation.impliedPriceUsd} slippageBps=${QUOTE_SLIPPAGE_BPS} ` +
      `source=${valuation.source} reason=${reason}`
  );

  const { error } = await supabase.from("ai_discovery_trades").insert({
    position_id: position.position_id,
    mint: position.mint,
    token_symbol: position.token_symbol,
    pair_address: position.pair_address,
    entry_price_usd: n(position.entry_price_usd),
    exit_price_usd: Math.max(0, valuation.impliedPriceUsd),
    size_sol: sizeSol,
    proceeds_sol: proceeds,
    gross_return_pct: grossPct,
    net_return_pct: netPct,
    pnl_sol: pnlSol,
    execution_source: valuation.source,
    exit_reason: reason,
    opened_at: position.opened_at,
    closed_at: now,
    entry_snapshot: position.entry_snapshot,
    exit_snapshot: {
      version: VERSION,
      source: valuation.source,
      route: valuation.route,
      outLamports: valuation.outLamports.toString(),
      executableSol: valuation.executableSol,
      proceedsSol: proceeds,
      impliedPriceUsd: valuation.impliedPriceUsd,
      slippageBps: QUOTE_SLIPPAGE_BPS,
      quoteError: valuation.quoteError ?? null,
      quote: valuation.rawQuote ?? null,
      peakPriceUsd: n(position.peak_price_usd),
    },
  });

  if (error) {
    if (
      error.code === "23505" ||
      error.message.includes("ai_discovery_trade_position_unique_idx")
    ) {
      await supabase
        .from("ai_discovery_positions")
        .delete()
        .eq("position_id", position.position_id);
      return;
    }
    throw new Error(error.message);
  }

  await supabase
    .from("ai_discovery_positions")
    .delete()
    .eq("position_id", position.position_id);

  const losses = pnlSol < 0 ? state.consecutive_losses + 1 : 0;
  await supabase
    .from("ai_discovery_state")
    .update({
      bankroll_sol: n(state.bankroll_sol) + proceeds,
      daily_realized_pnl_sol: n(state.daily_realized_pnl_sol) + pnlSol,
      consecutive_losses: losses,
      updated_at: now,
    })
    .eq("id", 1);

  await sendTelegramAlert(
    [
      `${pnlSol >= 0 ? "✅" : "🔴"} <b>AI DISCOVERY PAPER TRADE CLOSED</b>`,
      "",
      `Token: <b>${position.token_symbol}</b>`,
      `Exit: <b>${reason.replaceAll("_", " ")}</b>`,
      `Net: <b>${netPct >= 0 ? "+" : ""}${netPct.toFixed(2)}%</b>`,
      `PnL: <b>${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(5)} SOL</b>`,
      `Source: <b>${valuation.source}</b>`,
      "",
      "🧪 Paper accounting uses executable value.",
    ].join("\n")
  );
}

async function reconcileClosedLiveMirrors(): Promise<void> {
  const { data: mirrors, error } = await supabase
    .from("live_positions")
    .select("source_position_id,proceeds_sol,realized_pnl_sol,closed_at")
    .eq("status", "closed")
    .not("proceeds_sol", "is", null)
    .order("closed_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);

  for (const mirror of mirrors ?? []) {
    const { data: trade, error: tradeError } = await supabase
      .from("ai_discovery_trades")
      .select("id,size_sol,pnl_sol,proceeds_sol,execution_source,exit_snapshot")
      .eq("position_id", mirror.source_position_id)
      .maybeSingle();
    if (tradeError) throw new Error(tradeError.message);
    if (!trade || trade.execution_source === "live_mirror") continue;

    const actualProceeds = n(mirror.proceeds_sol);
    const actualPnl = n(mirror.realized_pnl_sol, actualProceeds - n(trade.size_sol));
    const oldPnl = n(trade.pnl_sol);
    const delta = actualPnl - oldPnl;
    const netPct = n(trade.size_sol) > 0 ? (actualPnl / n(trade.size_sol)) * 100 : -100;

    const { error: updateError } = await supabase
      .from("ai_discovery_trades")
      .update({
        proceeds_sol: actualProceeds,
        pnl_sol: actualPnl,
        net_return_pct: netPct,
        execution_source: "live_mirror",
        exit_snapshot: {
          ...(trade.exit_snapshot ?? {}),
          liveMirror: {
            proceedsSol: actualProceeds,
            realizedPnlSol: actualPnl,
            closedAt: mirror.closed_at,
          },
        },
      })
      .eq("id", trade.id);
    if (updateError) throw new Error(updateError.message);

    const state = await loadState();
    await supabase
      .from("ai_discovery_state")
      .update({
        bankroll_sol: n(state.bankroll_sol) + delta,
        daily_realized_pnl_sol: n(state.daily_realized_pnl_sol) + delta,
        updated_at: new Date().toISOString(),
      })
      .eq("id", 1);

    console.log(
      `[ai-discovery-trader] live mirror parity ${mirror.source_position_id} ` +
        `proceedsSol=${actualProceeds} pnlSol=${actualPnl}`
    );
  }
}

async function managePositions(): Promise<void> {
  if (positionRunning) return;
  positionRunning = true;
  try {
    await reconcileClosedLiveMirrors();
    for (const position of await loadPositions()) {
      try {
        const { data: recorded, error: recordedError } = await supabase
          .from("ai_discovery_trades")
          .select("id")
          .eq("position_id", position.position_id)
          .limit(1);
        if (recordedError) throw new Error(recordedError.message);
        if (recorded?.length) {
          await supabase
            .from("ai_discovery_positions")
            .delete()
            .eq("position_id", position.position_id);
          continue;
        }

        const heldMs = Date.now() - Date.parse(position.opened_at);
        const mirror = await liveMirrorFor(position.position_id);
        const valuation = await quoteExitValuation(position, mirror);
        const entryValue = Math.max(valuation.entryValueSol, Number.EPSILON);
        const recoveryPct = (valuation.executableSol / entryValue) * 100;
        const failStreak = n(position.quote_fail_streak);

        // Could not obtain an executable value this cycle (transient Jupiter
        // quote failure that survived the helper's retries, or a missing token
        // amount). This is NOT evidence of a rug, so never book a loss on it.
        // Hold and retry; only force-close once the failures persist or the
        // position ages out, so a temporary quote blip can never realize a
        // healthy position at ~-100%.
        if (valuation.quoteCallFailed) {
          const nextStreak = failStreak + 1;
          if (nextStreak >= MAX_QUOTE_FAIL_STREAK || heldMs >= MAX_HOLD_MS) {
            await closeTrade(position, valuation, "quote_unavailable_forced_exit");
            continue;
          }
          const now = new Date().toISOString();
          await supabase
            .from("ai_discovery_positions")
            .update({
              quote_fail_streak: nextStreak,
              last_checked_at: now,
              updated_at: now,
            })
            .eq("position_id", position.position_id);
          console.warn(
            `[ai-discovery-trader] quote unavailable for ${position.token_symbol} ` +
              `(streak ${nextStreak}/${MAX_QUOTE_FAIL_STREAK}); holding, error=${valuation.quoteError ?? "unknown"}`
          );
          continue;
        }

        // A successful quote that genuinely cannot route out is a real rug.
        if (!valuation.route) {
          await closeTrade(position, valuation, "liquidity_gone");
          continue;
        }
        if (recoveryPct < EMERGENCY_EXIT_FLOOR_PCT) {
          await closeTrade(position, valuation, "emergency_liquidity_drop");
          continue;
        }

        const entry = n(position.entry_price_usd);
        const impliedPrice = valuation.impliedPriceUsd;
        const grossPct = entry > 0 ? (impliedPrice / entry - 1) * 100 : -100;
        const peak = Math.max(n(position.peak_price_usd), impliedPrice);
        const peakPct = entry > 0 ? (peak / entry - 1) * 100 : 0;
        const pullbackPct = peak > 0 ? (impliedPrice / peak - 1) * 100 : -100;

        let reason: string | null = null;
        if (grossPct <= HARD_STOP_PCT) reason = "hard_stop";
        else if (grossPct >= TAKE_PROFIT_PCT) reason = "take_profit";
        else if (
          peakPct >= TRAIL_ARM_PCT &&
          pullbackPct <= -TRAIL_DISTANCE_PCT
        ) {
          reason = "trailing_stop";
        } else if (heldMs >= MAX_HOLD_MS) {
          reason = "max_hold";
        }

        if (reason) {
          await closeTrade(position, valuation, reason);
        } else {
          const now = new Date().toISOString();
          await supabase
            .from("ai_discovery_positions")
            .update({
              last_price_usd: impliedPrice,
              peak_price_usd: peak,
              quote_peak_value_sol: Math.max(
                n(position.quote_peak_value_sol, n(position.size_sol)),
                valuation.executableSol
              ),
              last_executable_value_sol: valuation.executableSol,
              quote_fail_streak: 0,
              last_checked_at: now,
              updated_at: now,
            })
            .eq("position_id", position.position_id);
        }
      } catch (error) {
        // An unexpected error (DB/parse/network) is not evidence of a rug.
        // Skip this position for this cycle rather than force-closing it at a
        // loss. Only if it has aged past max-hold and still cannot be handled
        // do we close it out, so transient faults never fabricate losses.
        const heldMs = Date.now() - Date.parse(position.opened_at);
        if (heldMs >= MAX_HOLD_MS) {
          await closeTrade(
            position,
            {
              source: "quote",
              route: false,
              outLamports: 0n,
              executableSol: 0,
              proceedsSol: 0,
              impliedPriceUsd: 0,
              entryValueSol: n(position.size_sol),
              quoteCallFailed: true,
              quoteError: error instanceof Error ? error.message : String(error),
            },
            "quote_unavailable_forced_exit"
          ).catch((closeError) =>
            console.error(
              `[ai-discovery-trader] fail-closed exit failed for ${position.token_symbol}`,
              closeError
            )
          );
        } else {
          console.warn(
            `[ai-discovery-trader] position ${position.token_symbol} check skipped (transient error); not force-closing`,
            error
          );
        }
      }
    }
  } finally {
    positionRunning = false;
  }
}

export function startAiDiscoveryTrader(): void {
  if (!enabled()) {
    console.log(
      "[ai-discovery-trader] disabled by ENABLE_AI_DISCOVERY_TRADER"
    );
    return;
  }

  console.log(
    `[ai-discovery-trader] ${VERSION} enabled; quote exits=${QUOTE_EXITS_ENABLED}; ` +
      `emergency floor=${EMERGENCY_EXIT_FLOOR_PCT}%; slippage=${QUOTE_SLIPPAGE_BPS}bps; ` +
      `DexScreener interval=${DEX_MIN_INTERVAL_MS}ms cache=${DEX_CACHE_TTL_MS}ms ` +
      `outcomeBatch=${OUTCOME_BATCH_SIZE}; ` +
      `size ${FIXED_SIZE_SOL.toFixed(2)} SOL; score ${MIN_SCORE}+`
  );

  void scanEntries().catch((error) =>
    console.error("[ai-discovery-trader] initial scan failed", error)
  );
  void managePositions().catch((error) =>
    console.error("[ai-discovery-trader] initial position check failed", error)
  );
  void trackCandidateOutcomes().catch((error) =>
    console.error("[ai-discovery-trader] initial outcome tracking failed", error)
  );

  setInterval(
    () =>
      void scanEntries().catch((error) =>
        console.error("[ai-discovery-trader] scan failed", error)
      ),
    60_000
  );
  setInterval(
    () =>
      void managePositions().catch((error) =>
        console.error("[ai-discovery-trader] position check failed", error)
      ),
    10_000
  );
  setInterval(
    () =>
      void trackCandidateOutcomes().catch((error) =>
        console.error("[ai-discovery-trader] outcome tracking failed", error)
      ),
    60_000
  );
}
