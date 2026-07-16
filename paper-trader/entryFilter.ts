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
  const { score, walletCount, totalBoughtSol, marketCapUsd, liquidityUsd } = alert;

  const avgBuyPerWallet = walletCount > 0 ? totalBoughtSol / walletCount : 0;
  const liqToMcap = marketCapUsd > 0 ? liquidityUsd / marketCapUsd : 0;

  if (score < config.entry.minScore) {
    reasons.push(`score ${score} below minimum ${config.entry.minScore}`);
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

  return { pass: reasons.length === 0, reasons, avgBuyPerWallet, liqToMcap };
}
