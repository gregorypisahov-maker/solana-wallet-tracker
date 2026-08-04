// paper-trader/momentumScalperRules.ts
// Paper-only momentum-scalper rules. All strategy tunables resolve once at boot.

export type ScalpCandidate = {
  mint: string;
  symbol: string;
  pairAddress: string;
  priceUsd: number;
  liquidityUsd: number;
  marketCapUsd: number;
  fiveMinuteChangePct: number;
  fifteenMinuteChangePct: number;
  fiveMinuteVolumeUsd: number;
  fiveMinuteBuys: number;
  fiveMinuteSells: number;
  fiveMinuteBuyers: number;
  poolAgeMinutes: number;
};

export type ScalpMarketConfirmation = {
  priceUsd: number;
  liquidityUsd: number;
  marketCapUsd: number;
  fiveMinuteChangePct: number;
};

export type CandidateEvaluation = {
  accepted: boolean;
  score: number;
  reasons: string[];
};

export type ExitDecision = {
  netMultiple: number;
  grossReturnPct: number;
  netReturnPct: number;
  reason: string;
};

function envNumber(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function envMode(): "scalp" | "runner" {
  return process.env.SNIPER_MODE?.trim().toLowerCase() === "runner" ? "runner" : "scalp";
}

export const SNIPER_MODE = envMode();
const scalpMode = SNIPER_MODE === "scalp";

export const SCALP_RULES = {
  minLiquidityUsd: envNumber("SCALP_MIN_LIQUIDITY_USD", 35_000, 5_000, 10_000_000),
  minMarketCapUsd: envNumber("SCALP_MIN_MARKET_CAP_USD", 100_000, 10_000, 100_000_000),
  maxMarketCapUsd: envNumber("SCALP_MAX_MARKET_CAP_USD", 650_000, 20_000, 1_000_000_000),
  shadowPreferredMaxMarketCapUsd: 200_000,
  shadowPreferredMinLiquidityToMcapRatio: 0.30,
  shadowMarketCapScoreBonus: 8,
  shadowLiquidityScoreBonus: 8,
  minFiveMinuteChangePct: envNumber("SCALP_MIN_5M_CHANGE_PCT", 2, -100, 1_000),
  maxFiveMinuteChangePct: envNumber("SCALP_MAX_5M_CHANGE_PCT", 8, 0, 10_000),
  minFifteenMinuteChangePct: envNumber("SCALP_MIN_15M_CHANGE_PCT", 5, -100, 1_000),
  maxFifteenMinuteChangePct: envNumber("SCALP_MAX_15M_CHANGE_PCT", 20, 0, 10_000),
  minFiveMinuteVolumeUsd: envNumber("SCALP_MIN_5M_VOLUME_USD", 3_000, 0, 100_000_000),
  minFiveMinuteTrades: envNumber("SCALP_MIN_5M_TRADES", 30, 0, 1_000_000),
  minFiveMinuteBuyers: envNumber("SCALP_MIN_5M_BUYERS", 12, 0, 1_000_000),
  minBuySellRatio: envNumber("SCALP_MIN_BUY_SELL_RATIO", 0.9, 0, 100),
  minLiquidityToMcapRatio: envNumber("SCALP_MIN_LIQUIDITY_MCAP_RATIO", 0.20, 0, 10),
  minPoolAgeMinutes: envNumber("SCALP_MIN_POOL_AGE_MINUTES", 60, 0, 525_600),
  minimumSignalScore: envNumber("SCALP_MIN_SIGNAL_SCORE", 45, 0, 100),
  fixedSizeSol: envNumber("SCALP_POSITION_SIZE_SOL", 0.20, 0.001, 10_000),
  maxConcurrentPositions: Math.floor(envNumber("SCALP_MAX_CONCURRENT", 3, 1, 50)),
  targetProfitPct: envNumber("SCALP_TARGET_PROFIT_PCT", scalpMode ? 5 : 25, 0.1, 1_000),
  hardStopLossPct: envNumber("SCALP_HARD_STOP_PCT", scalpMode ? 3.5 : 2.5, 0.1, 100),
  trailingActivationGrossPct: envNumber("SCALP_TRAIL_ARM_PCT", scalpMode ? 2 : 3, 0.1, 1_000),
  trailingGivebackPct: envNumber("SCALP_TRAIL_GIVEBACK_PCT", scalpMode ? 1.5 : 2, 0.1, 100),
  maxHoldSeconds: Math.floor(envNumber("SCALP_MAX_HOLD_SECONDS", scalpMode ? 300 : 480, 10, 86_400)),
  runnerMaxHoldSeconds: Math.floor(envNumber("SCALP_RUNNER_MAX_HOLD_SECONDS", 1_500, 10, 86_400)),
  maxDailyEntries: Math.floor(envNumber("SCALP_MAX_DAILY_ENTRIES", 20, 1, 10_000)),
  dailyLossLimitPct: envNumber("SCALP_DAILY_LOSS_LIMIT_PCT", 0.08, 0, 1),
  maxConsecutiveLosses: Math.floor(envNumber("SCALP_MAX_CONSECUTIVE_LOSSES", 3, 1, 100)),
  cooldownMinutes: Math.floor(envNumber("SCALP_COOLDOWN_MINUTES", 120, 0, 100_000)),
  maxEntryPriceGapPct: envNumber("SCALP_MAX_ENTRY_PRICE_GAP_PCT", 3, 0.1, 100),
  maxLiquidityDropPct: envNumber("SCALP_MAX_LIQUIDITY_DROP_PCT", 20, 0, 100),
  // Compatibility fields used only by older dashboard/tests. Live realized costs
  // are calculated by liveCostSimulation.ts, not by these two values.
  entryFrictionPct: envNumber("SCALP_DASHBOARD_ENTRY_FRICTION_PCT", 0.6, 0, 10),
  exitFrictionPct: envNumber("SCALP_DASHBOARD_EXIT_FRICTION_PCT", 0.6, 0, 10),
} as const;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

// Kept for dashboard and older callers. This does not drive live exit triggers.
export function calculateNetMultiple(grossMultiple: number): number {
  if (!Number.isFinite(grossMultiple) || grossMultiple <= 0) return 0;
  const entryFriction = SCALP_RULES.entryFrictionPct / 100;
  const exitFriction = SCALP_RULES.exitFrictionPct / 100;
  return grossMultiple * ((1 - exitFriction) / (1 + entryFriction));
}

export function evaluateScalpCandidate(candidate: ScalpCandidate): CandidateEvaluation {
  const reasons: string[] = [];
  const trades = candidate.fiveMinuteBuys + candidate.fiveMinuteSells;
  const buySellRatio = candidate.fiveMinuteBuys / Math.max(1, candidate.fiveMinuteSells);
  const liquidityToMcapRatio = candidate.marketCapUsd > 0
    ? candidate.liquidityUsd / candidate.marketCapUsd
    : 0;

  if (candidate.liquidityUsd < SCALP_RULES.minLiquidityUsd) reasons.push("liquidity_below_minimum");
  if (candidate.marketCapUsd < SCALP_RULES.minMarketCapUsd) reasons.push("market_cap_below_minimum");
  if (candidate.marketCapUsd > SCALP_RULES.maxMarketCapUsd) reasons.push("market_cap_above_maximum");
  if (liquidityToMcapRatio < SCALP_RULES.minLiquidityToMcapRatio) reasons.push("liquidity_to_market_cap_too_low");
  if (candidate.fiveMinuteChangePct < SCALP_RULES.minFiveMinuteChangePct) reasons.push("five_minute_momentum_too_low");
  if (candidate.fiveMinuteChangePct > SCALP_RULES.maxFiveMinuteChangePct) reasons.push("five_minute_momentum_overheated");
  if (candidate.fifteenMinuteChangePct < SCALP_RULES.minFifteenMinuteChangePct) reasons.push("fifteen_minute_confirmation_too_low");
  if (candidate.fifteenMinuteChangePct > SCALP_RULES.maxFifteenMinuteChangePct) reasons.push("fifteen_minute_move_overheated");
  if (candidate.fiveMinuteVolumeUsd < SCALP_RULES.minFiveMinuteVolumeUsd) reasons.push("five_minute_volume_too_low");
  if (trades < SCALP_RULES.minFiveMinuteTrades) reasons.push("five_minute_trades_too_low");
  if (candidate.fiveMinuteBuyers < SCALP_RULES.minFiveMinuteBuyers) reasons.push("buyer_breadth_too_low");
  if (buySellRatio < SCALP_RULES.minBuySellRatio) reasons.push("buy_flow_too_weak");
  if (candidate.poolAgeMinutes < SCALP_RULES.minPoolAgeMinutes) reasons.push("pool_too_new");

  const momentumScore = clamp(
    (candidate.fiveMinuteChangePct - SCALP_RULES.minFiveMinuteChangePct) /
      Math.max(0.01, SCALP_RULES.maxFiveMinuteChangePct - SCALP_RULES.minFiveMinuteChangePct),
    0,
    1
  ) * 25;
  const confirmationScore = clamp(candidate.fifteenMinuteChangePct / 15, 0, 1) * 20;
  const volumeScore = clamp(candidate.fiveMinuteVolumeUsd / 20_000, 0, 1) * 20;
  const breadthScore = clamp(candidate.fiveMinuteBuyers / 50, 0, 1) * 20;
  const flowScore = clamp(buySellRatio / 2, 0, 1) * 15;
  const shadowMarketCapBonus = candidate.marketCapUsd <= SCALP_RULES.shadowPreferredMaxMarketCapUsd
    ? SCALP_RULES.shadowMarketCapScoreBonus
    : 0;
  const shadowLiquidityBonus = liquidityToMcapRatio >= SCALP_RULES.shadowPreferredMinLiquidityToMcapRatio
    ? SCALP_RULES.shadowLiquidityScoreBonus
    : 0;
  const score = Math.round(clamp(
    momentumScore + confirmationScore + volumeScore + breadthScore + flowScore +
      shadowMarketCapBonus + shadowLiquidityBonus,
    0,
    100
  ));

  if (score < SCALP_RULES.minimumSignalScore) reasons.push("signal_score_below_minimum");
  return { accepted: reasons.length === 0, score, reasons };
}

export function evaluateScalpConfirmation(market: ScalpMarketConfirmation): string[] {
  const reasons: string[] = [];
  const liquidityToMcapRatio = market.marketCapUsd > 0
    ? market.liquidityUsd / market.marketCapUsd
    : 0;

  if (!Number.isFinite(market.priceUsd) || market.priceUsd <= 0) reasons.push("dex_price_invalid");
  if (market.liquidityUsd < SCALP_RULES.minLiquidityUsd) reasons.push("dex_liquidity_below_minimum");
  if (market.marketCapUsd < SCALP_RULES.minMarketCapUsd) reasons.push("dex_market_cap_below_minimum");
  if (market.marketCapUsd > SCALP_RULES.maxMarketCapUsd) reasons.push("dex_market_cap_above_maximum");
  if (liquidityToMcapRatio < SCALP_RULES.minLiquidityToMcapRatio) reasons.push("dex_liquidity_to_market_cap_too_low");
  if (market.fiveMinuteChangePct < SCALP_RULES.minFiveMinuteChangePct) reasons.push("dex_five_minute_momentum_too_low");
  if (market.fiveMinuteChangePct > SCALP_RULES.maxFiveMinuteChangePct) reasons.push("dex_five_minute_momentum_overheated");
  return reasons;
}

// Exit triggers are deliberately based on gross market movement. Modeled costs are
// applied only when the live Jupiter quote is converted into realized paper PnL.
export function decideScalpExit(input: {
  entryPriceUsd: number;
  currentPriceUsd: number;
  peakPriceUsd: number;
  openedAtMs: number;
  nowMs: number;
}): ExitDecision | null {
  const grossMultiple = input.currentPriceUsd / input.entryPriceUsd;
  if (!Number.isFinite(grossMultiple) || grossMultiple <= 0) return null;

  const peakGrossMultiple = Math.max(input.currentPriceUsd, input.peakPriceUsd) / input.entryPriceUsd;
  const grossReturnPct = (grossMultiple - 1) * 100;
  const peakGrossReturnPct = (peakGrossMultiple - 1) * 100;
  const holdSeconds = Math.max(0, input.nowMs - input.openedAtMs) / 1_000;
  const netMultiple = calculateNetMultiple(grossMultiple);
  const netReturnPct = (netMultiple - 1) * 100;
  const result = (reason: string): ExitDecision => ({
    netMultiple,
    grossReturnPct,
    netReturnPct,
    reason,
  });

  if (grossReturnPct <= -SCALP_RULES.hardStopLossPct) return result("hard_stop");
  if (
    peakGrossReturnPct >= SCALP_RULES.trailingActivationGrossPct &&
    grossReturnPct <= peakGrossReturnPct - SCALP_RULES.trailingGivebackPct
  ) return result("trailing_stop");
  if (grossReturnPct >= SCALP_RULES.targetProfitPct) return result("take_profit");

  const maxHoldSeconds = SNIPER_MODE === "runner" && peakGrossReturnPct >= SCALP_RULES.trailingActivationGrossPct
    ? SCALP_RULES.runnerMaxHoldSeconds
    : SCALP_RULES.maxHoldSeconds;
  return holdSeconds >= maxHoldSeconds ? result("max_hold_time") : null;
}
