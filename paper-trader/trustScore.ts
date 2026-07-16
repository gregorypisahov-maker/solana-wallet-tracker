// paper-trader/trustScore.ts
//
// Transparent wallet trust scoring from 0-100. The formula rewards repeatable
// risk-adjusted profitability, while preventing one or two lucky trades from
// outranking wallets with a meaningful paper-trading history.

export interface WalletContribution {
  address: string;
  trustScore: number;
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

const MIN_SINGLE_WALLET_WEIGHT = 0.2;
const MAX_SINGLE_WALLET_WEIGHT = 1.8;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function computeWeightedWalletScore(
  wallets: WalletContribution[]
): WeightedScoreResult {
  if (wallets.length === 0) {
    return {
      weightedWalletScore: 0,
      averageTrustScore: 0,
      confidenceGrade: 'D',
      perWalletContribution: [],
    };
  }

  const perWalletContribution = wallets.map((wallet) => {
    const weight = clamp(
      wallet.trustScore / 50,
      MIN_SINGLE_WALLET_WEIGHT,
      MAX_SINGLE_WALLET_WEIGHT
    );
    return {
      address: wallet.address,
      trustScore: wallet.trustScore,
      weight: Number(weight.toFixed(3)),
      contribution: Number(weight.toFixed(3)),
    };
  });

  const weightedWalletScore = Number(
    perWalletContribution
      .reduce((sum, wallet) => sum + wallet.contribution, 0)
      .toFixed(3)
  );
  const averageTrustScore = Number(
    (
      wallets.reduce((sum, wallet) => sum + wallet.trustScore, 0) /
      wallets.length
    ).toFixed(2)
  );
  const weightedRatio = weightedWalletScore / wallets.length;

  let confidenceGrade: 'A' | 'B' | 'C' | 'D';
  if (
    wallets.length >= 5 &&
    averageTrustScore >= 65 &&
    weightedRatio >= 1.15
  ) {
    confidenceGrade = 'A';
  } else if (
    wallets.length >= 4 &&
    averageTrustScore >= 55 &&
    weightedRatio >= 1
  ) {
    confidenceGrade = 'B';
  } else if (wallets.length >= 3 && averageTrustScore >= 40) {
    confidenceGrade = 'C';
  } else {
    confidenceGrade = 'D';
  }

  return {
    weightedWalletScore,
    averageTrustScore,
    confidenceGrade,
    perWalletContribution,
  };
}

export interface WalletStatsInput {
  completedTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  averageReturn: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
  lastActivityAt: string | null;
  losingAlertParticipationPct: number;
}

export interface TrustScoreBreakdown {
  trustScore: number;
  sampleSizeFactor: number;
  winRateComponent: number;
  avgReturnComponent: number;
  profitFactorComponent: number;
  drawdownPenalty: number;
  recencyComponent: number;
  losingAlertPenalty: number;
  rawPerformanceSignal: number;
}

export const TRUST_CONFIG = {
  // A slightly lower neutral point creates clearer separation between proven
  // profitable wallets and weak wallets without making new wallets look bad.
  neutralBaseline: 45,

  // Full confidence requires 30 completed trades. A one-trade wallet can move
  // only 1/30 of the maximum performance swing from neutral.
  fullSampleSize: 30,

  weights: {
    winRate: 0.2,
    avgReturn: 0.35,
    profitFactor: 0.35,
    recency: 0.1,
  },

  maxSwingFromNeutral: 70,
  drawdownPenaltyMaxPoints: 12,
  losingAlertPenaltyMaxPoints: 18,
  recencyInactiveDays: 21,

  // Meme-coin strategies can be profitable with a modest win rate when the
  // winners are larger. Normalize around +8% average return and PF 2.0.
  avgReturnNormalizer: 0.08,
  profitFactorNeutral: 1,
  profitFactorNormalizer: 1,
};

export function computeTrustScore(
  input: WalletStatsInput
): TrustScoreBreakdown {
  const cfg = TRUST_CONFIG;
  const sampleSizeFactor = clamp(
    input.completedTrades / cfg.fullSampleSize,
    0,
    1
  );

  const winRateComponent = clamp((input.winRate - 0.5) * 2, -1, 1);
  const avgReturnComponent = clamp(
    input.averageReturn / cfg.avgReturnNormalizer,
    -1,
    1
  );
  const profitFactorComponent =
    input.profitFactor === null
      ? 0
      : clamp(
          (input.profitFactor - cfg.profitFactorNeutral) /
            cfg.profitFactorNormalizer,
          -1,
          1
        );

  let recencyComponent = 0;
  if (input.lastActivityAt) {
    const daysSinceActivity =
      (Date.now() - new Date(input.lastActivityAt).getTime()) / 86_400_000;
    recencyComponent = clamp(
      1 - daysSinceActivity / cfg.recencyInactiveDays,
      0,
      1
    );
  }

  const rawPerformanceSignal =
    cfg.weights.winRate * winRateComponent +
    cfg.weights.avgReturn * avgReturnComponent +
    cfg.weights.profitFactor * profitFactorComponent +
    cfg.weights.recency * recencyComponent;

  const drawdownPenalty =
    clamp(input.maxDrawdownPct / 100, 0, 1) *
    cfg.drawdownPenaltyMaxPoints;
  const losingAlertPenalty =
    clamp(input.losingAlertParticipationPct, 0, 1) *
    cfg.losingAlertPenaltyMaxPoints;
  const dampenedSwing =
    sampleSizeFactor * rawPerformanceSignal * cfg.maxSwingFromNeutral;

  const trustScore = clamp(
    cfg.neutralBaseline +
      dampenedSwing -
      drawdownPenalty -
      losingAlertPenalty,
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
