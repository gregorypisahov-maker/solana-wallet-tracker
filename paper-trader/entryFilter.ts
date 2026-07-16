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

  const trustAdjustedMinScore =
    confidenceGrade === 'C' ? adaptive.minScore + 1 : adaptive.minScore;

  if (score < trustAdjustedMinScore) {
    reasons.push(`score ${score} below adaptive minimum ${trustAdjustedMinScore}`);
  }
  if (walletCount < config.entry.minWalletCount) {
    reasons.push(`walletCount ${walletCount} below minimum ${config.entry.minWalletCount}`);
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
  if (averageTrustScore !== undefined && averageTrustScore < 40) {
    reasons.push(`average wallet trust ${averageTrustScore.toFixed(1)} below minimum 40`);
  }
  if (
    weightedWalletScore !== undefined &&
    walletCount > 0 &&
    weightedWalletScore / walletCount < 0.8
  ) {
    reasons.push(
      `weighted wallet consensus ${(weightedWalletScore / walletCount).toFixed(2)} below minimum 0.80`
    );
  }

  return { pass: reasons.length === 0, reasons, avgBuyPerWallet, liqToMcap };
}
