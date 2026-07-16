// paper-trader/entryFilter.ts
import { config } from './config';
import { getAdaptiveEntryThresholds } from './adaptiveStrategy';
import { AlertInput } from './types';

export interface EntryEvaluation {
  pass: boolean;
  reasons: string[];
  avgBuyPerWallet: number;
  liqToMcap: number;
}

export function evaluateEntry(alert: AlertInput): EntryEvaluation {
  const reasons: string[] = [];
  const adaptive = getAdaptiveEntryThresholds();
  const {
    score,
    walletCount,
    totalBoughtSol,
    marketCapUsd,
    liquidityUsd,
    weightedWalletScore,
    averageTrustScore,
    confidenceGrade,
  } = alert;

  const avgBuyPerWallet = walletCount > 0 ? totalBoughtSol / walletCount : 0;
  const liqToMcap = marketCapUsd > 0 ? liquidityUsd / marketCapUsd : 0;
  const weightedConsensus =
    weightedWalletScore !== undefined && walletCount > 0
      ? weightedWalletScore / walletCount
      : undefined;

  const trustAdjustedMinScore =
    confidenceGrade === 'C' ? adaptive.minScore + 1 : adaptive.minScore;

  // Preserve some trade flow, but allow two-wallet entries only when both
  // wallets are high-trust and their buying conviction is unusually strong.
  const eliteTwoWalletSignal =
    walletCount === 2 &&
    avgBuyPerWallet >= 1.25 &&
    averageTrustScore !== undefined &&
    averageTrustScore >= 60 &&
    (weightedConsensus === undefined || weightedConsensus >= 0.95) &&
    confidenceGrade !== 'D';

  if (score < trustAdjustedMinScore) {
    reasons.push(`score ${score} below adaptive minimum ${trustAdjustedMinScore}`);
  }
  if (score > config.entry.maxScore) {
    reasons.push(`score ${score} above late-entry ceiling ${config.entry.maxScore}`);
  }
  if (walletCount < config.entry.minWalletCount && !eliteTwoWalletSignal) {
    reasons.push(
      walletCount === 2
        ? 'two-wallet signal is not elite enough'
        : `walletCount ${walletCount} below minimum ${config.entry.minWalletCount}`
    );
  }
  if (avgBuyPerWallet < adaptive.minAvgBuyPerWallet) {
    reasons.push(
      `avg buy/wallet ${avgBuyPerWallet.toFixed(2)} SOL below adaptive minimum ${adaptive.minAvgBuyPerWallet}`
    );
  }
  if (liqToMcap < adaptive.minLiquidityToMcapRatio) {
    reasons.push(
      `liquidity/mcap ratio ${(liqToMcap * 100).toFixed(1)}% below minimum ${
        adaptive.minLiquidityToMcapRatio * 100
      }%`
    );
  }
  if (marketCapUsd > config.entry.maxMarketCapUsd) {
    reasons.push(`marketCap $${marketCapUsd} above ceiling $${config.entry.maxMarketCapUsd}`);
  }
  if (liquidityUsd < adaptive.minLiquidityUsd) {
    reasons.push(`liquidity $${liquidityUsd} below floor $${adaptive.minLiquidityUsd}`);
  }
  if (confidenceGrade === 'D') {
    reasons.push('wallet confidence grade D is not tradeable');
  }
  if (
    averageTrustScore === undefined ||
    averageTrustScore < config.entry.minAverageTrustScore
  ) {
    reasons.push(
      `average wallet trust ${averageTrustScore?.toFixed(1) ?? 'n/a'} below minimum ${config.entry.minAverageTrustScore}`
    );
  }
  if (weightedConsensus !== undefined && weightedConsensus < 0.8) {
    reasons.push(
      `weighted wallet consensus ${weightedConsensus.toFixed(2)} below minimum 0.80`
    );
  }

  return { pass: reasons.length === 0, reasons, avgBuyPerWallet, liqToMcap };
}
