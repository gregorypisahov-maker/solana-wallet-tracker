// paper-trader/momentumScalperRules.ts
// Scalper rules engine with PROFITABILITY FOCUS

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

// ==== SCALPER CONFIGURATION (PROFITABILITY OPTIMIZED) ====
export const SCALP_RULES = {
  minScore: 45,
  minLiquidityUsd: 15_000,
  maxMarketCapUsd: 120_000,
  minPoolAgeMinutes: 3,
  maxPoolAgeHours: 72,
  minFiveMinVolumeUsd: 25_000,
  minBuyersIn5min: 12,
  buyToSellRatio: 0.6,
  minPositiveMomentum: 1.5,
  fixedSizeSol: 0.20,
  maxConcurrentPositions: 1,
  targetProfitPct: 4.5,
  hardStopLossPct: 3.0,
  maxHoldSeconds: 600,
  entryFrictionPct: 0.6,
  exitFrictionPct: 0.6,
  maxDailyEntries: 12,
  dailyLossLimitPct: 0.15,
  maxConsecutiveLosses: 3,
  cooldownMinutes: 8,
};

function getTotalFrictionPct(): number {
  return SCALP_RULES.entryFrictionPct + SCALP_RULES.exitFrictionPct;
}

export function evaluateScalpCandidate(candidate: ScalpCandidate): CandidateEvaluation {
  const reasons: string[] = [];
  let score = 100;

  if (candidate.liquidityUsd < SCALP_RULES.minLiquidityUsd) {
    reasons.push(`low_liquidity_${Math.round(candidate.liquidityUsd / 1000)}k`);
    score -= 30;
  }

  if (candidate.marketCapUsd > SCALP_RULES.maxMarketCapUsd) {
    reasons.push(`high_mcap_${Math.round(candidate.marketCapUsd / 1000)}k`);
    score -= 20;
  }

  if (candidate.poolAgeMinutes < SCALP_RULES.minPoolAgeMinutes) {
    reasons.push(`too_new_${Math.floor(candidate.poolAgeMinutes)}m`);
    score -= 25;
  }
  const maxPoolAgeMinutes = SCALP_RULES.maxPoolAgeHours * 60;
  if (candidate.poolAgeMinutes > maxPoolAgeMinutes) {
    reasons.push(`too_old_${Math.floor(candidate.poolAgeMinutes / 60)}h`);
    score -= 15;
  }

  if (candidate.fiveMinuteVolumeUsd < SCALP_RULES.minFiveMinVolumeUsd) {
    reasons.push(`low_volume_${Math.round(candidate.fiveMinuteVolumeUsd / 1000)}k`);
    score -= 20;
  }

  if (candidate.fiveMinuteBuyers < SCALP_RULES.minBuyersIn5min) {
    reasons.push(`few_buyers_${candidate.fiveMinuteBuyers}`);
    score -= 25;
  }

  const buyVolume = candidate.fiveMinuteBuys * (candidate.priceUsd || 1);
  const sellVolume = candidate.fiveMinuteSells * (candidate.priceUsd || 1);
  const totalVolume = buyVolume + sellVolume || 1;
  const buyRatio = buyVolume / totalVolume;

  if (buyRatio < SCALP_RULES.buyToSellRatio) {
    reasons.push(`weak_buy_ratio_${(buyRatio * 100).toFixed(0)}pct`);
    score -= 30;
  }

  if (candidate.fiveMinuteChangePct < SCALP_RULES.minPositiveMomentum) {
    reasons.push(`weak_momentum_${candidate.fiveMinuteChangePct.toFixed(1)}pct`);
    score -= 20;
  }

  if (candidate.fifteenMinuteChangePct > 10) {
    reasons.push(`already_pumped_${candidate.fifteenMinuteChangePct.toFixed(0)}pct`);
    score -= 40;
  }

  const accepted = score >= SCALP_RULES.minScore && reasons.length === 0;

  return { accepted, score: Math.max(0, Math.min(100, score)), reasons };
}

export function evaluateScalpConfirmation(market: ScalpMarketConfirmation): string[] {
  const reasons: string[] = [];

  if (market.liquidityUsd < SCALP_RULES.minLiquidityUsd * 0.8) {
    reasons.push(`liquidity_drop_${Math.round(market.liquidityUsd / 1000)}k`);
  }

  if (market.marketCapUsd > SCALP_RULES.maxMarketCapUsd * 1.5) {
    reasons.push(`mcap_spike_${Math.round(market.marketCapUsd / 1000)}k`);
  }

  if (market.fiveMinuteChangePct > 8) {
    reasons.push(`price_spiked_${market.fiveMinuteChangePct.toFixed(1)}pct`);
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
  const holdSeconds = (input.nowMs - input.openedAtMs) / 1_000;
  const totalFrictionPct = getTotalFrictionPct();

  const grossMultiple = input.currentPriceUsd / input.entryPriceUsd;
  const grossReturnPct = (grossMultiple - 1) * 100;
  const netMultiple = grossMultiple * (1 - totalFrictionPct / 100);
  const netReturnPct = (netMultiple - 1) * 100;

  if (netReturnPct >= SCALP_RULES.targetProfitPct) {
    return { netMultiple, grossReturnPct, netReturnPct, reason: "target_profit_hit" };
  }

  if (netReturnPct <= -SCALP_RULES.hardStopLossPct) {
    return { netMultiple, grossReturnPct, netReturnPct, reason: "hard_stop_loss" };
  }

  if (holdSeconds >= SCALP_RULES.maxHoldSeconds) {
    return { netMultiple, grossReturnPct, netReturnPct, reason: "max_hold_time_exceeded" };
  }

  if (input.peakPriceUsd > input.entryPriceUsd) {
    const trailingFloor = input.peakPriceUsd * 0.988;
    if (input.currentPriceUsd <= trailingFloor) {
      const trailingNetMultiple = input.currentPriceUsd / input.entryPriceUsd * (1 - totalFrictionPct / 100);
      return { netMultiple: trailingNetMultiple, grossReturnPct, netReturnPct, reason: "trailing_stop" };
    }
  }

  return null;
}

export function calculateNetMultiple(grossMultiple: number): number {
  return grossMultiple * (1 - getTotalFrictionPct() / 100);
}
