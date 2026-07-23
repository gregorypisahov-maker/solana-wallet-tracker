// paper-trader/types.ts
import type { ProvenTraderSignalProfile } from "./provenTraderRules";

export interface AlertInput {
  tokenSymbol: string;
  mint: string;
  score: number;
  walletCount: number;
  totalBoughtSol: number;
  marketCapUsd: number;
  liquidityUsd: number;
  weightedWalletScore?: number;
  averageTrustScore?: number;
  confidenceGrade?: 'A' | 'B' | 'C' | 'D';
  signalSource?: 'wallet_consensus' | 'proven_trader_copy' | 'wallet_lab';
  leaderWallet?: string;
  leaderProfile?: ProvenTraderSignalProfile;
  strategyVersion?: string;
  shadowSizeMultiplier?: number;
  shadowStudyDecision?: Record<string, unknown>;
}

export interface OpenPosition {
  mint: string;
  tokenSymbol: string;
  entryPrice: number;
  entryTime: number;
  sizeSol: number;
  remainingPct: number;
  peakMultiple: number;
  ladderHits: number[];
  entryAlert: AlertInput;
  positionId: string;
  realizedPnlSol: number;
  entryFeeSol: number;
  entrySlippageSol: number;
  entryLiquidityUsd: number;
  costModelVersion: string | null;
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
  grossPnlSol: number;
  entryFeeSol: number;
  exitFeeSol: number;
  slippageSol: number;
  pnlSol: number;
  costModelVersion: string | null;
  holdMinutes: number;
  timestamp: string;
  entryAlert: AlertInput;
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
