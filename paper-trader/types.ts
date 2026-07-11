// paper-trader/types.ts

export interface AlertInput {
  tokenSymbol: string;
  mint: string;
  score: number;
  walletCount: number;
  totalBoughtSol: number;
  marketCapUsd: number;
  liquidityUsd: number;
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
}

export interface PaperState {
  bankrollSol: number;
  dailyStartBankrollSol: number;
  dailyResetDate: string;
  consecutiveLosses: number;
  halted: boolean;
  haltReason: string | null;
}
