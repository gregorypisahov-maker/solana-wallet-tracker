// paper-trader/types.ts
export interface AlertInput {
  tokenSymbol: string;
  mint: string;
  score: number;
  walletCount: number;
  totalBoughtSol: number;
  marketCapUsd: number;
  liquidityUsd: number;
  // Optional Phase 3 fields. Undefined for any caller that hasn't been
  // updated to compute wallet-trust weighting yet, so this is fully
  // backward compatible with the existing onAlert(alert) call sites.
  weightedWalletScore?: number;
  averageTrustScore?: number;
  confidenceGrade?: 'A' | 'B' | 'C' | 'D';
}
export interface OpenPosition {
  mint: string;
  tokenSymbol: string;
  entryPrice: number;
  entryTime: number; // ms epoch
  sizeSol: number;
  remainingPct: number;
  peakMultiple: number;
  ladderHits: number[];
  entryAlert: AlertInput;
  // New: stable identifier for this position, generated once at open
  // time. Lets analytics correctly group every partial sell belonging
  // to this position instead of double-counting them as separate trades.
  positionId: string;
}
export interface TradeRecord {
  tokenSymbol: string;
  mint: string;
  type: 'partial_sell';
  reason: string;
  entryPrice: number;
  exitPrice: number;
  multiple: number;
  soldPct: number;
  soldSizeSol: number;
  proceedsSol: number;
  pnlSol: number;
  holdMinutes: number;
  timestamp: string;
  entryAlert: AlertInput;
  // New. Nullable because historical rows won't have this until
  // scripts/backfillPositionIds.ts has been run against them. All new
  // rows written by the updated engine.ts always populate it.
  positionId: string | null;
}
export interface PaperState {
  bankrollSol: number;
  dailyStartBankrollSol: number;
  dailyResetDate: string;
  consecutiveLosses: number;
  halted: boolean;
  haltReason: string | null;
}
