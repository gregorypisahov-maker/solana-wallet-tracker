import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "../lib/supabase";
import { sendTelegramAlert } from "../lib/telegram";

const supabase = getSupabaseAdmin();
const VERSION = "ai_discovery_trader_v1_5_2026_07_24";
const SHADOW_MODEL_VERSION = "baseline_v1_2026_07_24";
const DEX_URL = "https://api.dexscreener.com/tokens/v1/solana";
const ENTRY_FRICTION_PCT = 0.6;
const EXIT_FRICTION_PCT = 0.6;
const FIXED_SIZE_SOL = 0.2;
const MAX_CONSECUTIVE_LOSSES = 3;
const DAILY_LOSS_LIMIT_SOL = 0.05;
const MIN_SCORE = 82;
const MAX_OPPORTUNITY_AGE_MS = 3 * 60_000;
const COOLDOWN_MS = 2 * 60 * 60_000;
const HARD_STOP_PCT = -6;
const TAKE_PROFIT_PCT = 10;
const TRAIL_ARM_PCT = 6;
const TRAIL_DISTANCE_PCT = 4;
const MAX_HOLD_MS = 45 * 60_000;
const REQUEST_TIMEOUT_MS = 12_000;
const OUTCOME_HORIZONS = [5, 15, 30, 45] as const;

let scanRunning = false;
let positionRunning = false;
let outcomeRunning = false;
let lastSummaryAt = 0;

type State = {
  enabled: boolean;
  halted: boolean;
  halt_reason: string | null;
  bankroll_sol: number | string;
  entries_today: number;
  daily_date: string;
  daily_realized_pnl_sol: number | string;
  consecutive_losses: number;
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
  opened_at: string;
  entry_snapshot: Record<string, unknown>;
};

type Market = {
  priceUsd: number;
  liquidityUsd: number;
  marketCapUsd: number;
  changeM5: number;
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

async function fetchJson(url: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
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
  const snapshot = {
    version: VERSION,
    opportunity,
    market,
    observationId,
    friction: { entryPct: ENTRY_FRICTION_PCT, exitPct: EXIT_FRICTION_PCT },
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

    if (!state.enabled || state.halted) return;

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
      .limit(20);
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
              ? Number(
                  (((market.priceUsd / effectiveBase) - 1) * 100).toFixed(4)
                )
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

async function closeTrade(
  position: Position,
  market: any,
  reason: string,
  grossPct: number
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
    console.warn(
      `[ai-discovery-trader] close already recorded for ${position.token_symbol}`
    );
    return;
  }

  const exitMultiple =
    1 + (grossPct - ENTRY_FRICTION_PCT - EXIT_FRICTION_PCT) / 100;
  const sizeSol = n(position.size_sol);
  const proceeds = Math.max(0, sizeSol * exitMultiple);
  const pnlSol = proceeds - sizeSol;
  const netPct = grossPct - ENTRY_FRICTION_PCT - EXIT_FRICTION_PCT;
  const now = new Date().toISOString();
  const state = await loadState();

  const { error } = await supabase.from("ai_discovery_trades").insert({
    position_id: position.position_id,
    mint: position.mint,
    token_symbol: position.token_symbol,
    pair_address: position.pair_address,
    entry_price_usd: n(position.entry_price_usd),
    exit_price_usd: market.priceUsd,
    size_sol: sizeSol,
    gross_return_pct: grossPct,
    net_return_pct: netPct,
    pnl_sol: pnlSol,
    exit_reason: reason,
    opened_at: position.opened_at,
    closed_at: now,
    entry_snapshot: position.entry_snapshot,
    exit_snapshot: {
      version: VERSION,
      market,
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
      console.warn(
        `[ai-discovery-trader] close already recorded for ${position.token_symbol}`
      );
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
      daily_realized_pnl_sol:
        n(state.daily_realized_pnl_sol) + pnlSol,
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
      "",
      "🧪 Paper only.",
    ].join("\n")
  );
}

async function managePositions(): Promise<void> {
  if (positionRunning) return;
  positionRunning = true;

  try {
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
          console.warn(
            `[ai-discovery-trader] close already recorded for ${position.token_symbol}`
          );
          continue;
        }

        const heldMs = Date.now() - Date.parse(position.opened_at);
        const market = await priceFor(position.mint, position.pair_address);

        if (!market) {
          if (heldMs < MAX_HOLD_MS) continue;
          const fallbackPrice = n(
            position.last_price_usd,
            n(position.entry_price_usd)
          );
          const entry = n(position.entry_price_usd);
          await closeTrade(
            position,
            { priceUsd: fallbackPrice, source: "last_valid_price" },
            "max_hold_price_unavailable",
            (fallbackPrice / entry - 1) * 100
          );
          continue;
        }

        const entry = n(position.entry_price_usd);
        const grossPct = (market.priceUsd / entry - 1) * 100;
        const peak = Math.max(n(position.peak_price_usd), market.priceUsd);
        const peakPct = (peak / entry - 1) * 100;
        const pullbackPct = (market.priceUsd / peak - 1) * 100;

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
          await closeTrade(position, market, reason, grossPct);
        } else {
          const now = new Date().toISOString();
          await supabase
            .from("ai_discovery_positions")
            .update({
              last_price_usd: market.priceUsd,
              peak_price_usd: peak,
              last_checked_at: now,
              updated_at: now,
            })
            .eq("position_id", position.position_id);
        }
      } catch (error) {
        console.warn(
          `[ai-discovery-trader] position ${position.token_symbol} check skipped`,
          error
        );
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
    `[ai-discovery-trader] ${VERSION} enabled; paper-only; restored pre-queue feed behavior; ` +
      `shadow dataset ${SHADOW_MODEL_VERSION}; no daily entry pause; ` +
      `size ${FIXED_SIZE_SOL.toFixed(2)} SOL; score ${MIN_SCORE}+`
  );

  void scanEntries().catch((error) =>
    console.error("[ai-discovery-trader] initial scan failed", error)
  );
  void managePositions().catch((error) =>
    console.error("[ai-discovery-trader] initial position check failed", error)
  );
  void trackCandidateOutcomes().catch((error) =>
    console.error(
      "[ai-discovery-trader] initial outcome tracking failed",
      error
    )
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
