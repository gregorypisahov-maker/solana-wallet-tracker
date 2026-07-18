// paper-trader/entryFilter.ts
import { config } from "./config";
import { AlertInput } from "./types";

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
    averageTrustScore,
    confidenceGrade,
  } = alert;

  const avgBuyPerWallet = walletCount > 0 ? totalBoughtSol / walletCount : 0;
  const liqToMcap = marketCapUsd > 0 ? liquidityUsd / marketCapUsd : 0;
  const isEliteTwoWalletSignal =
    walletCount === 2 &&
    avgBuyPerWallet >= config.entry.eliteTwoWalletMinAvgBuySol &&
    averageTrustScore !== undefined &&
    averageTrustScore >= config.entry.eliteTwoWalletMinAvgTrustScore;

  if (score < config.entry.minScore) {
    reasons.push(`score ${score} below minimum ${config.entry.minScore}`);
  }
  if (score > config.entry.maxScore) {
    reasons.push(`score ${score} above maximum ${config.entry.maxScore}`);
  }
  if (walletCount < config.entry.minWalletCount && !isEliteTwoWalletSignal) {
    reasons.push(
      walletCount === 2
        ? `2-wallet signal needs avg buy >= ${config.entry.eliteTwoWalletMinAvgBuySol} SOL and trust >= ${config.entry.eliteTwoWalletMinAvgTrustScore}`
        : `walletCount ${walletCount} below minimum ${config.entry.minWalletCount}`
    );
  }
  if (avgBuyPerWallet < config.entry.minAvgBuyPerWallet) {
    reasons.push(
      `avg buy/wallet ${avgBuyPerWallet.toFixed(2)} SOL below minimum ${config.entry.minAvgBuyPerWallet}`
    );
  }
  if (
    averageTrustScore === undefined ||
    !Number.isFinite(averageTrustScore) ||
    averageTrustScore < config.entry.minAvgTrustScore
  ) {
    reasons.push(
      `average trust ${averageTrustScore ?? "missing"} below minimum ${config.entry.minAvgTrustScore}`
    );
  }
  if (liqToMcap < config.entry.minLiquidityToMcapRatio) {
    reasons.push(
      `liquidity/mcap ratio ${(liqToMcap * 100).toFixed(1)}% below minimum ${
        config.entry.minLiquidityToMcapRatio * 100
      }%`
    );
  }
  if (marketCapUsd < config.entry.minMarketCapUsd) {
    reasons.push(`marketCap $${marketCapUsd} below floor $${config.entry.minMarketCapUsd}`);
  }
  if (marketCapUsd > config.entry.maxMarketCapUsd) {
    reasons.push(`marketCap $${marketCapUsd} above ceiling $${config.entry.maxMarketCapUsd}`);
  }
  if (liquidityUsd < config.entry.minLiquidityUsd) {
    reasons.push(`liquidity $${liquidityUsd} below floor $${config.entry.minLiquidityUsd}`);
  }
  if (
    confidenceGrade &&
    config.entry.blockedConfidenceGrades.has(confidenceGrade)
  ) {
    reasons.push(`confidence grade ${confidenceGrade} blocked`);
  }

  return { pass: reasons.length === 0, reasons, avgBuyPerWallet, liqToMcap };
}
