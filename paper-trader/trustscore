// paper-trader/trustScore.ts
//
// A transparent, explainable formula for scoring wallet trustworthiness
// from 0-100. Deliberately NOT based on win rate alone — see the
// component breakdown below. Kept in its own file so the formula is
// easy to find, tune, and reason about independently of the rest of
// Phase 2/3.
//
// DESIGN GOALS (per spec):
// - A wallet with only one winning trade must NOT get a very high
//   score. Handled by `sampleSizeFactor`, which ramps 0 -> 1 as
//   completedTrades goes from 0 -> TRUST_FULL_SAMPLE_SIZE. All
//   performance-based adjustments are multiplied by this factor, so a
//   1-trade wallet can only move a small distance from the neutral
//   baseline of 50, no matter how good that one trade was.
// - Multiple factors, not just win rate: win rate, average return,
//   profit factor, drawdown contribution, recency, and frequency of
//   participation in losing alerts are all included.

export interface WalletContribution {
  address: string;
  trustScore: number; // pass 50 (neutral) for wallets with no wallet_performance row yet
}

export interface PerWalletContribution {
  address: string;
  trustScore: number;
  weight: number;
  contribution: number;
}

export interface WeightedScoreResult {
  weightedWalletScore: number;
  averageTrustScore: number;
  confidenceGrade: 'A' | 'B' | 'C' | 'D';
  perWalletContribution: PerWalletContribution[];
}

// Phase 3 — turns a raw list of participating wallets + their trust
// scores into a weighted consensus score, with an explainable per-wallet
// breakdown (logged by the worker for every alert, per spec).
//
// Weight formula: trust 50 (neutral/unproven) => weight 1.0, i.e. counts
// exactly as much as it would in the old unweighted scheme. Trust 0 =>
// weight floors at MIN_SINGLE_WALLET_WEIGHT (never zero — a low-trust
// wallet still contributes a little, it doesn't get erased). Trust 100
// => weight caps at MAX_SINGLE_WALLET_WEIGHT, so no single wallet can
// dominate the weighted score even with a perfect track record.
//
// This function does NOT decide whether to send an alert — the
// existing MIN_WALLETS_FOR_ALERT / MIN_SCORE_FOR_ALERT gate in
// worker/monitor.ts stays exactly as-is and continues to run first, so
// trust weighting can only refine the confidence grade shown alongside
// an alert that already passed the real gate on its own.
const MIN_SINGLE_WALLET_WEIGHT = 0.2;
const MAX_SINGLE_WALLET_WEIGHT = 1.8;

export function computeWeightedWalletScore(wallets: WalletContribution[]): WeightedScoreResult {
  if (wallets.length === 0) {
    return {
      weightedWalletScore: 0,
      averageTrustScore: 0,
      confidenceGrade: 'D',
      perWalletContribution: [],
    };
  }

  const perWalletContribution: PerWalletContribution[] = wallets.map((w) => {
    const weight = clamp(w.trustScore / 50, MIN_SINGLE_WALLET_WEIGHT, MAX_SINGLE_WALLET_WEIGHT);
    return {
      address: w.address,
      trustScore: w.trustScore,
      weight: Number(weight.toFixed(3)),
      contribution: Number(weight.toFixed(3)),
    };
  });

  const weightedWalletScore = Number(
    perWalletContribution.reduce((sum, c) => sum + c.contribution, 0).toFixed(3)
  );

  const averageTrustScore = Number(
    (wallets.reduce((sum, w) => sum + w.trustScore, 0) / wallets.length).toFixed(2)
  );

  const rawCount = wallets.length;
  const weightedRatio = weightedWalletScore / rawCount; // >1 means above-average trust wallets, <1 means below-average

  // Conservative, explainable thresholds — tune in TRUST_CONFIG-style
  // fashion if needed, but deliberately kept simple and readable here.
  let confidenceGrade: 'A' | 'B' | 'C' | 'D';
  if (rawCount >= 5 && averageTrustScore >= 65 && weightedRatio >= 1.15) {
    confidenceGrade = 'A';
  } else if (rawCount >= 4 && averageTrustScore >= 55 && weightedRatio >= 1.0) {
    confidenceGrade = 'B';
  } else if (rawCount >= 3 && averageTrustScore >= 40) {
    confidenceGrade = 'C';
  } else {
    confidenceGrade = 'D';
  }

  return { weightedWalletScore, averageTrustScore, confidenceGrade, perWalletContribution };
}

export interface WalletStatsInput {
  completedTrades: number;
  wins: number;
  losses: number;
  winRate: number; // 0..1
  averageReturn: number; // avg multiple - 1, e.g. 0.25 = +25%
  profitFactor: number | null; // null when no losses yet
  maxDrawdownPct: number; // 0..100
  lastActivityAt: string | null;
  losingAlertParticipationPct: number; // 0..1 — fraction of this wallet's
  // alert participations that belonged to tokens whose paper position
  // ended up a net loss
}

export interface TrustScoreBreakdown {
  trustScore: number; // 0..100, final
  sampleSizeFactor: number; // 0..1
  winRateComponent: number; // -1..1 before weighting
  avgReturnComponent: number; // -1..1 before weighting
  profitFactorComponent: number; // -1..1 before weighting
  drawdownPenalty: number; // 0..1, always subtracts
  recencyComponent: number; // -1..1
  losingAlertPenalty: number; // 0..20, subtracted directly (not sample-dampened —
  // showing up disproportionately in losing alerts is informative even early on)
  rawPerformanceSignal: number; // combined -1..1 signal before sample dampening
}

// Tunable constants — all in one place, matching the project's existing
// "config.ts is the only place to hardcode numbers" convention.
export const TRUST_CONFIG = {
  neutralBaseline: 50,
  fullSampleSize: 10, // trades needed before a wallet's performance history is weighted at full strength
  weights: {
    winRate: 0.35,
    avgReturn: 0.25,
    profitFactor: 0.2,
    recency: 0.1,
    // drawdown is handled as a separate penalty (see drawdownPenalty), not
    // part of this weighted sum, since it should never be able to push the
    // score UP — only down.
  },
  maxSwingFromNeutral: 45, // performance signal can move score at most +/-45 from the 50 baseline
  drawdownPenaltyMaxPoints: 10, // max points subtracted for max_drawdown
  losingAlertPenaltyMaxPoints: 20, // max points subtracted for frequent losing-alert participation
  recencyInactiveDays: 21, // after this many days of no activity, recency component decays to 0
  avgReturnNormalizer: 0.5, // +50% average return maps to a full +1 component before weighting
  profitFactorNeutral: 1.0, // profit factor of 1.0 is break-even -> component 0
  profitFactorNormalizer: 2.0, // profit factor of 3.0 maps to a full +1 component
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function computeTrustScore(input: WalletStatsInput): TrustScoreBreakdown {
  const cfg = TRUST_CONFIG;

  const sampleSizeFactor = clamp(input.completedTrades / cfg.fullSampleSize, 0, 1);

  // Win rate: 0.5 (coin flip) is neutral -> 0. 1.0 -> +1. 0.0 -> -1.
  const winRateComponent = clamp((input.winRate - 0.5) * 2, -1, 1);

  // Average return normalized against a configurable reference point.
  const avgReturnComponent = clamp(input.averageReturn / cfg.avgReturnNormalizer, -1, 1);

  // Profit factor: below 1.0 is a losing wallet (negative component),
  // above 1.0 is profitable. Wallets with no losses yet (profitFactor
  // === null, division by zero avoided upstream) are treated as
  // neutral rather than infinitely good — that's exactly the "one
  // winning trade shouldn't look amazing" guard applied to this
  // component specifically.
  const profitFactorComponent =
    input.profitFactor === null
      ? 0
      : clamp((input.profitFactor - cfg.profitFactorNeutral) / cfg.profitFactorNormalizer, -1, 1);

  // Recency: linearly decays from +1 (active today) to 0 (inactive for
  // recencyInactiveDays or longer). Does not go negative — inactivity
  // is a reason for LESS confidence, not active distrust.
  let recencyComponent = 0;
  if (input.lastActivityAt) {
    const daysSinceActivity = (Date.now() - new Date(input.lastActivityAt).getTime()) / 86_400_000;
    recencyComponent = clamp(1 - daysSinceActivity / cfg.recencyInactiveDays, 0, 1);
  }

  const rawPerformanceSignal =
    cfg.weights.winRate * winRateComponent +
    cfg.weights.avgReturn * avgReturnComponent +
    cfg.weights.profitFactor * profitFactorComponent +
    cfg.weights.recency * recencyComponent;

  const drawdownPenalty = clamp(input.maxDrawdownPct / 100, 0, 1) * cfg.drawdownPenaltyMaxPoints;

  const losingAlertPenalty =
    clamp(input.losingAlertParticipationPct, 0, 1) * cfg.losingAlertPenaltyMaxPoints;

  const dampenedSwing = sampleSizeFactor * rawPerformanceSignal * cfg.maxSwingFromNeutral;

  const trustScore = clamp(
    cfg.neutralBaseline + dampenedSwing - drawdownPenalty - losingAlertPenalty,
    0,
    100
  );

  return {
    trustScore: Number(trustScore.toFixed(2)),
    sampleSizeFactor: Number(sampleSizeFactor.toFixed(3)),
    winRateComponent: Number(winRateComponent.toFixed(3)),
    avgReturnComponent: Number(avgReturnComponent.toFixed(3)),
    profitFactorComponent: Number(profitFactorComponent.toFixed(3)),
    drawdownPenalty: Number(drawdownPenalty.toFixed(2)),
    recencyComponent: Number(recencyComponent.toFixed(3)),
    losingAlertPenalty: Number(losingAlertPenalty.toFixed(2)),
    rawPerformanceSignal: Number(rawPerformanceSignal.toFixed(3)),
  };
}
