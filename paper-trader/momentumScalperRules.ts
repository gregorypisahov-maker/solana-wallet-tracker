// paper-trader/momentumScalperRules.ts
// Momentum-scalper rules kept separate from the wallet/shadow strategy.

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

export const SCALP_RULES = {
  minLiquidityUsd: 35_000,
  minMarketCapUsd: 100_000,
  maxMarketCapUsd: 650_000,
  // Reopen the useful momentum window, but require real liquidity backing below.
  minFiveMinuteChangePct: 2,
  maxFiveMinuteChangePct: 8,
  minFifteenMinuteChangePct: 5,
  maxFifteenMinuteChangePct: 20,
  minFiveMinuteVolumeUsd: 3_000,
  minFiveMinuteTrades: 30,
  minFiveMinuteBuyers: 12,
  minBuySellRatio: 0.9,
  // Historical losses clustered in thin pools even when absolute liquidity passed.
  minLiquidityToMcapRatio: 0.20,
  minPoolAgeMinutes: 60,
  minimumSignalScore: 45,
  fixedSizeSol: 0.20,
  maxConcurrentPositions: 1,
  targetProfitPct: 25,
  hardStopLossPct: 2.5,
  trailingActivationNetPct: 5.5,
  trailingGivebackPctLow: 2.0,
  trailingGivebackPctMid: 1.5,
  trailingGivebackPctHigh: 1.0,
  trailingMidPeakNetPct: 9,
  trailingHighPeakNetPct: 15,
  maxHoldSeconds: 480,
  runnerMaxHoldSeconds: 1_500,
  entryFrictionPct: 0.6,
  exitFrictionPct: 0.6,
  maxDailyEntries: 6,
  dailyLossLimitPct: 0.08,
  maxConsecutiveLosses: 3,
  // Repeated entries in the same token were the largest measured loss cohort.
  cooldownMinutes: 24 * 60,
} as const;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export function calculateNetMultiple(grossMultiple: number): number {
  if (!Number.isFinite(grossMultiple) || grossMultiple <= 0) return 0;

  const entryFriction = SCALP_RULES.entryFrictionPct / 100;
  const exitFriction = SCALP_RULES.exitFrictionPct / 100;
  return grossMultiple * ((1 - exitFriction) / (1 + entryFriction));
}

export function evaluateScalpCandidate(
  candidate: ScalpCandidate
): CandidateEvaluation {
  const reasons: string[] = [];
  const trades = candidate.fiveMinuteBuys + candidate.fiveMinuteSells;
  const buySellRatio =
    candidate.fiveMinuteBuys / Math.max(1, candidate.fiveMinuteSells);
  const liquidityToMcapRatio =
    candidate.marketCapUsd > 0
      ? candidate.liquidityUsd / candidate.marketCapUsd
      : 0;

  if (candidate.liquidityUsd < SCALP_RULES.minLiquidityUsd) {
    reasons.push("liquidity_below_35k");
  }
  if (candidate.marketCapUsd < SCALP_RULES.minMarketCapUsd) {
    reasons.push("market_cap_below_100k");
  }
  if (candidate.marketCapUsd > SCALP_RULES.maxMarketCapUsd) {
    reasons.push("market_cap_above_650k");
  }
  if (liquidityToMcapRatio < SCALP_RULES.minLiquidityToMcapRatio) {
    reasons.push("liquidity_to_market_cap_below_20pct");
  }
  if (candidate.fiveMinuteChangePct < SCALP_RULES.minFiveMinuteChangePct) {
    reasons.push("five_minute_momentum_too_low");
  }
  if (candidate.fiveMinuteChangePct > SCALP_RULES.maxFiveMinuteChangePct) {
    reasons.push("five_minute_momentum_overheated");
  }
  if (
    candidate.fifteenMinuteChangePct <
    SCALP_RULES.minFifteenMinuteChangePct
  ) {
    reasons.push("fifteen_minute_confirmation_too_low");
  }
  if (
    candidate.fifteenMinuteChangePct >
    SCALP_RULES.maxFifteenMinuteChangePct
  ) {
    reasons.push("fifteen_minute_move_overheated");
  }
  if (
    candidate.fiveMinuteVolumeUsd <
    SCALP_RULES.minFiveMinuteVolumeUsd
  ) {
    reasons.push("five_minute_volume_too_low");
  }
  if (trades < SCALP_RULES.minFiveMinuteTrades) {
    reasons.push("five_minute_trades_too_low");
  }
  if (candidate.fiveMinuteBuyers < SCALP_RULES.minFiveMinuteBuyers) {
    reasons.push("buyer_breadth_too_low");
  }
  if (buySellRatio < SCALP_RULES.minBuySellRatio) {
    reasons.push("buy_flow_too_weak");
  }
  if (candidate.poolAgeMinutes < SCALP_RULES.minPoolAgeMinutes) {
    reasons.push("pool_too_new");
  }

  const momentumScore =
    clamp(
      (candidate.fiveMinuteChangePct -
        SCALP_RULES.minFiveMinuteChangePct) /
        (SCALP_RULES.maxFiveMinuteChangePct -
          SCALP_RULES.minFiveMinuteChangePct),
      0,
      1
    ) * 25;
  const confirmationScore =
    clamp(candidate.fifteenMinuteChangePct / 15, 0, 1) * 20;
  const volumeScore =
    clamp(candidate.fiveMinuteVolumeUsd / 20_000, 0, 1) * 20;
  const breadthScore =
    clamp(candidate.fiveMinuteBuyers / 50, 0, 1) * 20;
  const flowScore = clamp(buySellRatio / 2, 0, 1) * 15;
  const score = Math.round(
    momentumScore +
      confirmationScore +
      volumeScore +
      breadthScore +
      flowScore
  );

  if (score < SCALP_RULES.minimumSignalScore) {
    reasons.push("signal_score_below_45");
  }

  return { accepted: reasons.length === 0, score, reasons };
}

export function evaluateScalpConfirmation(
  market: ScalpMarketConfirmation
): string[] {
  const reasons: string[] = [];
  const liquidityToMcapRatio =
    market.marketCapUsd > 0 ? market.liquidityUsd / market.marketCapUsd : 0;

  if (!Number.isFinite(market.priceUsd) || market.priceUsd <= 0) {
    reasons.push("dex_price_invalid");
  }
  if (market.liquidityUsd < SCALP_RULES.minLiquidityUsd) {
    reasons.push("dex_liquidity_below_35k");
  }
  if (market.marketCapUsd < SCALP_RULES.minMarketCapUsd) {
    reasons.push("dex_market_cap_below_100k");
  }
  if (market.marketCapUsd > SCALP_RULES.maxMarketCapUsd) {
    reasons.push("dex_market_cap_above_650k");
  }
  if (liquidityToMcapRatio < SCALP_RULES.minLiquidityToMcapRatio) {
    reasons.push("dex_liquidity_to_market_cap_below_20pct");
  }
  if (market.fiveMinuteChangePct < SCALP_RULES.minFiveMinuteChangePct) {
    reasons.push("dex_five_minute_momentum_too_low");
  }
  if (market.fiveMinuteChangePct > SCALP_RULES.maxFiveMinuteChangePct) {
    reasons.push("dex_five_minute_momentum_overheated");
  }

  return reasons;
}

export function decideScalpExit(input: {
  entryPriceUsd: number;
  currentPriceUsd: number;
  peakPriceUsd: number;
  openedAtMs: number;
  nowMs: number;
}): ExitDecision | null {
  const priceMultiple = input.currentPriceUsd / input.entryPriceUsd;
  if (!Number.isFinite(priceMultiple) || priceMultiple <= 0) return null;

  const peakPriceMultiple =
    Math.max(input.currentPriceUsd, input.peakPriceUsd) / input.entryPriceUsd;
  const netMultiple = calculateNetMultiple(priceMultiple);
  const peakNetMultiple = calculateNetMultiple(peakPriceMultiple);
  const grossReturnPct = (priceMultiple - 1) * 100;
  const netReturnPct = (netMultiple - 1) * 100;
  const peakNetReturnPct = (peakNetMultiple - 1) * 100;
  const holdSeconds = Math.max(0, input.nowMs - input.openedAtMs) / 1_000;

  const result = (reason: string): ExitDecision => ({
    netMultiple,
    grossReturnPct,
    netReturnPct,
    reason,
  });

  if (netReturnPct <= -SCALP_RULES.hardStopLossPct) {
    return result("hard_stop");
  }

  const trailingGivebackPct =
    peakNetReturnPct >= SCALP_RULES.trailingHighPeakNetPct
      ? SCALP_RULES.trailingGivebackPctHigh
      : peakNetReturnPct >= SCALP_RULES.trailingMidPeakNetPct
        ? SCALP_RULES.trailingGivebackPctMid
        : SCALP_RULES.trailingGivebackPctLow;

  if (
    peakNetReturnPct >= SCALP_RULES.trailingActivationNetPct &&
    netReturnPct <= peakNetReturnPct - trailingGivebackPct
  ) {
    return result("trailing_stop");
  }

  if (netReturnPct >= SCALP_RULES.targetProfitPct) {
    return result("take_profit");
  }

  const maxHoldSeconds =
    peakNetReturnPct >= SCALP_RULES.trailingActivationNetPct
      ? SCALP_RULES.runnerMaxHoldSeconds
      : SCALP_RULES.maxHoldSeconds;
  if (holdSeconds >= maxHoldSeconds) {
    return result("max_hold_time");
  }

  return null;
}
