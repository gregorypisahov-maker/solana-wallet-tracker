export const SCALP_RULES = {
  startingBankrollSol: 1,
  fixedSizeSol: 0.05,
  minLiquidityUsd: 35_000,
  minMarketCapUsd: 100_000,
  maxMarketCapUsd: 5_000_000,
  minFiveMinuteChangePct: 2,
  maxFiveMinuteChangePct: 10,
  minFifteenMinuteChangePct: 2,
  maxFifteenMinuteChangePct: 25,
  minFiveMinuteVolumeUsd: 2_500,
  minFiveMinuteTrades: 25,
  minFiveMinuteBuyers: 10,
  minBuySellRatio: 0.6,
  minPoolAgeMinutes: 60,
  entryFrictionPct: 0.006,
  exitFrictionPct: 0.006,
  takeProfitNetPct: 2.5,
  hardStopNetPct: -3,
  trailingActivationNetPct: 1.8,
  trailingGivebackPct: 1.2,
  maxHoldMinutes: 7,
  cooldownMinutes: 30,
  maxDailyEntries: 12,
  maxDailyLossSol: 0.01,
  maxConsecutiveLosses: 4,
} as const;

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

export type CandidateEvaluation = {
  accepted: boolean;
  score: number;
  reasons: string[];
};

export type ScalpExitReason =
  | "take_profit"
  | "hard_stop"
  | "trailing_stop"
  | "max_hold_time";

export type ExitDecision = {
  reason: ScalpExitReason;
  grossReturnPct: number;
  netReturnPct: number;
  netMultiple: number;
} | null;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export function calculateNetMultiple(
  priceMultiple: number,
  entryFrictionPct = SCALP_RULES.entryFrictionPct,
  exitFrictionPct = SCALP_RULES.exitFrictionPct
): number {
  if (!Number.isFinite(priceMultiple) || priceMultiple <= 0) return 0;
  return (
    priceMultiple *
    ((1 - exitFrictionPct) / (1 + entryFrictionPct))
  );
}

export function evaluateScalpCandidate(
  candidate: ScalpCandidate
): CandidateEvaluation {
  const reasons: string[] = [];
  const trades = candidate.fiveMinuteBuys + candidate.fiveMinuteSells;
  const buySellRatio =
    candidate.fiveMinuteBuys / Math.max(1, candidate.fiveMinuteSells);

  if (candidate.liquidityUsd < SCALP_RULES.minLiquidityUsd) {
    reasons.push("liquidity_below_35k");
  }
  if (candidate.marketCapUsd < SCALP_RULES.minMarketCapUsd) {
    reasons.push("market_cap_below_100k");
  }
  if (candidate.marketCapUsd > SCALP_RULES.maxMarketCapUsd) {
    reasons.push("market_cap_above_5m");
  }
  if (
    candidate.fiveMinuteChangePct < SCALP_RULES.minFiveMinuteChangePct
  ) {
    reasons.push("five_minute_momentum_too_low");
  }
  if (
    candidate.fiveMinuteChangePct > SCALP_RULES.maxFiveMinuteChangePct
  ) {
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

  return {
    accepted: reasons.length === 0,
    score: Math.round(
      momentumScore +
        confirmationScore +
        volumeScore +
        breadthScore +
        flowScore
    ),
    reasons,
  };
}

export function decideScalpExit(input: {
  entryPriceUsd: number;
  currentPriceUsd: number;
  peakPriceUsd: number;
  openedAtMs: number;
  nowMs: number;
}): ExitDecision {
  const {
    entryPriceUsd,
    currentPriceUsd,
    peakPriceUsd,
    openedAtMs,
    nowMs,
  } = input;
  if (
    !Number.isFinite(entryPriceUsd) ||
    entryPriceUsd <= 0 ||
    !Number.isFinite(currentPriceUsd) ||
    currentPriceUsd <= 0
  ) {
    return null;
  }

  const priceMultiple = currentPriceUsd / entryPriceUsd;
  const peakPriceMultiple =
    Math.max(currentPriceUsd, peakPriceUsd) / entryPriceUsd;
  const netMultiple = calculateNetMultiple(priceMultiple);
  const peakNetMultiple = calculateNetMultiple(peakPriceMultiple);
  const grossReturnPct = (priceMultiple - 1) * 100;
  const netReturnPct = (netMultiple - 1) * 100;
  const peakNetReturnPct = (peakNetMultiple - 1) * 100;
  const holdMinutes = Math.max(0, nowMs - openedAtMs) / 60_000;

  const result = (reason: ScalpExitReason): NonNullable<ExitDecision> => ({
    reason,
    grossReturnPct,
    netReturnPct,
    netMultiple,
  });

  if (netReturnPct <= SCALP_RULES.hardStopNetPct) {
    return result("hard_stop");
  }
  if (netReturnPct >= SCALP_RULES.takeProfitNetPct) {
    return result("take_profit");
  }
  if (
    peakNetReturnPct >= SCALP_RULES.trailingActivationNetPct &&
    netReturnPct <=
      peakNetReturnPct - SCALP_RULES.trailingGivebackPct
  ) {
    return result("trailing_stop");
  }
  if (holdMinutes >= SCALP_RULES.maxHoldMinutes) {
    return result("max_hold_time");
  }
  return null;
}
