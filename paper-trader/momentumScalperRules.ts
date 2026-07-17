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
  // ---- ENTRY RULES ----
  minScore: 45,                      // was 25 — raise quality bar
  minLiquidityUsd: 50_000,           // was 30k — avoid illiquid traps
  maxMarketCapUsd: 150_000,          // was 500k — catch early runners, not chasing
  minPoolAgeMinutes: 3,              // must be real token (not fake)
  maxPoolAgeHours: 72,               // don't trade dead/abandoned tokens
  minFiveMinVolumeUsd: 25_000,       // need real activity, not ghost volume
  minBuyersIn5min: 12,               // at least 12 unique buyers = real interest
  buyToSellRatio: 0.6,               // 60%+ buys vs sells = real momentum
  minPositiveMomentum: 1.5,          // +1.5% min in 5m discovery
  
  // ---- POSITION SIZING ----
  fixedSizeSol: 0.08,                // was 0.05 — small enough for low risk, big enough for real wins
  maxConcurrentPositions: 1,         // one at a time — focus on quality
  
  // ---- EXIT RULES (AGGRESSIVE PROFIT TAKING) ----
  targetProfitPct: 2.5,              // +2.5% net = realistic goal
  hardStopLossPct: 3.0,              // -3.0% net = exit before bigger losses
  maxHoldSeconds: 420,               // 7 minutes max — memecoin moves fast
  
  // ---- FRICTION (SLIPPAGE + FEE SIMULATION) ----
  entryFrictionPct: 0.6,             // 0.6% entry (slippage + fees)
  exitFrictionPct: 0.6,              // 0.6% exit (slippage + fees)
  
  // ---- DAILY RISK LIMITS ----
  maxDailyEntries: 12,               // max 12 scalps/day
  dailyLossLimitPct: 0.15,           // halt if down 15% of daily start
  maxConsecutiveLosses: 3,           // stop after 3 losses in a row
  
  // ---- COOLDOWN AFTER TRADE ----
  cooldownMinutes: 8,                // wait 8 min before trading same token again
};

function getTotalFrictionPct(): number {
  return SCALP_RULES.entryFrictionPct + SCALP_RULES.exitFrictionPct;
}

export function evaluateScalpCandidate(
  candidate: ScalpCandidate
): CandidateEvaluation {
  const reasons: string[] = [];
  let score = 100;

  // --- LIQUIDITY CHECK ---
  if (candidate.liquidityUsd < SCALP_RULES.minLiquidityUsd) {
    reasons.push(
      `low_liquidity_${Math.round(candidate.liquidityUsd / 1000)}k`
    );
    score -= 30;
  }

  // --- MARKET CAP CHECK ---
  if (candidate.marketCapUsd > SCALP_RULES.maxMarketCapUsd) {
    reasons.push(
      `high_mcap_${Math.round(candidate.marketCapUsd / 1000)}k`
    );
    score -= 20;
  }

  // --- POOL AGE CHECK ---
  if (candidate.poolAgeMinutes < SCALP_RULES.minPoolAgeMinutes) {
    reasons.push(`too_new_${Math.floor(candidate.poolAgeMinutes)}m`);
    score -= 25;
  }
  const maxPoolAgeMinutes = SCALP_RULES.maxPoolAgeHours * 60;
  if (candidate.poolAgeMinutes > maxPoolAgeMinutes) {
    reasons.push(`too_old_${Math.floor(candidate.poolAgeMinutes / 60)}h`);
    score -= 15;
  }

  // --- VOLUME CHECK (real activity) ---
  if (candidate.fiveMinuteVolumeUsd < SCALP_RULES.minFiveMinVolumeUsd) {
    reasons.push(
      `low_volume_${Math.round(candidate.fiveMinuteVolumeUsd / 1000)}k`
    );
    score -= 20;
  }

  // --- BUYER DIVERSITY (unique buyers = real interest, not bots) ---
  if (candidate.fiveMinuteBuyers < SCALP_RULES.minBuyersIn5min) {
    reasons.push(`few_buyers_${candidate.fiveMinuteBuyers}`);
    score -= 25;
  }

  // --- BUY/SELL RATIO (momentum) ---
  const buyVolume = candidate.fiveMinuteBuys * (candidate.priceUsd || 1);
  const sellVolume = candidate.fiveMinuteSells * (candidate.priceUsd || 1);
  const totalVolume = buyVolume + sellVolume || 1;
  const buyRatio = buyVolume / totalVolume;

  if (buyRatio < SCALP_RULES.buyToSellRatio) {
    reasons.push(
      `weak_buy_ratio_${(buyRatio * 100).toFixed(0)}pct`
    );
    score -= 30;
  }

  // --- MOMENTUM CHECK (5m price action) ---
  if (candidate.fiveMinuteChangePct < SCALP_RULES.minPositiveMomentum) {
    reasons.push(
      `weak_momentum_${candidate.fiveMinuteChangePct.toFixed(1)}pct`
    );
    score -= 20;
  }

  // --- 15m confirmation (not a pump-and-dump yet) ---
  if (candidate.fifteenMinuteChangePct > 10) {
    reasons.push(
      `already_pumped_${candidate.fifteenMinuteChangePct.toFixed(0)}pct`
    );
    score -= 40;
  }

  const accepted = score >= SCALP_RULES.minScore && reasons.length === 0;

  return {
    accepted,
    score: Math.max(0, Math.min(100, score)),
    reasons,
  };
}

export function evaluateScalpConfirmation(
  market: ScalpMarketConfirmation
): string[] {
  const reasons: string[] = [];

  // DexScreener must confirm minimum liquidity (can change between GeckoTerminal discovery and here)
  if (market.liquidityUsd < SCALP_RULES.minLiquidityUsd * 0.8) {
    reasons.push(
      `liquidity_drop_${Math.round(market.liquidityUsd / 1000)}k`
    );
  }

  // Market cap must not have exploded since discovery
  if (market.marketCapUsd > SCALP_RULES.maxMarketCapUsd * 1.5) {
    reasons.push(
      `mcap_spike_${Math.round(market.marketCapUsd / 1000)}k`
    );
  }

  // Price shouldn't have already mooned
  if (market.fiveMinuteChangePct > 8) {
    reasons.push(
      `price_spiked_${market.fiveMinuteChangePct.toFixed(1)}pct`
    );
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

  // --- GROSS RETURN (before friction) ---
  const grossMultiple = input.currentPriceUsd / input.entryPriceUsd;
  const grossReturnPct = (grossMultiple - 1) * 100;

  // --- NET RETURN (after friction) ---
  const netMultiple = grossMultiple * (1 - totalFrictionPct / 100);
  const netReturnPct = (netMultiple - 1) * 100;

  // --- TARGET HIT: take the win ---
  if (netReturnPct >= SCALP_RULES.targetProfitPct) {
    return {
      netMultiple,
      grossReturnPct,
      netReturnPct,
      reason: "target_profit_hit",
    };
  }

  // --- HARD STOP LOSS: cut losses fast ---
  if (netReturnPct <= -SCALP_RULES.hardStopLossPct) {
    return {
      netMultiple,
      grossReturnPct,
      netReturnPct,
      reason: "hard_stop_loss",
    };
  }

  // --- MAX HOLD TIME: don't hold stale positions ---
  if (holdSeconds >= SCALP_RULES.maxHoldSeconds) {
    return {
      netMultiple,
      grossReturnPct,
      netReturnPct,
      reason: "max_hold_time_exceeded",
    };
  }

  // --- TRAILING STOP (if in profit, protect gains) ---
  // Trail 1.2% below peak
  if (input.peakPriceUsd > input.entryPriceUsd) {
    const peakMultiple = input.peakPriceUsd / input.entryPriceUsd;
    const trailingFloor = input.peakPriceUsd * 0.988; // trail 1.2%
    if (input.currentPriceUsd <= trailingFloor) {
      const trailingNetMultiple =
        input.currentPriceUsd /
        input.entryPriceUsd *
        (1 - totalFrictionPct / 100);
      return {
        netMultiple: trailingNetMultiple,
        grossReturnPct: (input.currentPriceUsd / input.entryPriceUsd - 1) * 100,
        netReturnPct: (trailingNetMultiple - 1) * 100,
        reason: "trailing_stop",
      };
    }
  }

  return null; // hold
}

export function calculateNetMultiple(
  grossMultiple: number
): number {
  return grossMultiple * (1 - getTotalFrictionPct() / 100);
}
