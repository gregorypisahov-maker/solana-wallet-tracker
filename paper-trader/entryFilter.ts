// paper-trader/entryFilter.ts
import { config } from './config';
import { AlertInput } from './types';

export interface EntryEvaluation {
  pass: boolean;
  reasons: string[];
  avgBuyPerWallet: number;
  liqToMcap: number;
}

export function evaluateEntry(alert: AlertInput): EntryEvaluation {
  const reasons: string[] = [];
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

  // Require stronger raw consensus when learned wallet quality is only average.
  // A/B setups keep the normal threshold; C setups need +1 score. D setups are
  // rejected because the participating wallets have weak or insufficient trust.
  const trustAdjustedMinScore =
    confidenceGrade === 'C' ? config.entry.minScore + 1 : config.entry.minScore;

  if (score < trustAdjustedMinScore) {
    reasons.push(`score ${score} below trust-adjusted minimum ${trustAdjustedMinScore}`);
  }
  if (walletCount < config.entry.minWalletCount) {
    reasons.push(`walletCount ${walletCount} below minimum ${config.entry.minWalletCount}`);
  }
  if (avgBuyPerWallet < config.entry.minAvgBuyPerWallet) {
    reasons.push(
      `avg buy/wallet ${avgBuyPerWallet.toFixed(2)} SOL below minimum ${config.entry.minAvgBuyPerWallet}`
    );
  }
  if (liqToMcap < config.entry.minLiquidityToMcapRatio) {
    reasons.push(
      `liquidity/mcap ratio ${(liqToMcap * 100).toFixed(1)}% below minimum ${
        config.entry.minLiquidityToMcapRatio * 100
      }%`
    );
  }
  if (marketCapUsd > config.entry.maxMarketCapUsd) {
    reasons.push(`marketCap $${marketCapUsd} above ceiling $${config.entry.maxMarketCapUsd}`);
  }
  if (liquidityUsd < config.entry.minLiquidityUsd) {
    reasons.push(`liquidity $${liquidityUsd} below floor $${config.entry.minLiquidityUsd}`);
  }

  // These fields are optional for backward compatibility. When the worker has
  // learned wallet-performance data, use it to stop repeating low-quality setups.
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
