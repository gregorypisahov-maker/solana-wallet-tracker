import { getSupabaseAdmin } from "../lib/supabase";
import { getPriceUsd } from "./priceFeed";
import { AlertInput } from "./types";

const supabase = getSupabaseAdmin();

const RULES = {
  minScore: 10,
  maxScore: 65,
  minWallets: 3,
  minAvgBuySol: 0.75,
  minLiquidityUsd: 15_000,
  minMarketCapUsd: 20_000,
  maxMarketCapUsd: 200_000,
  blockedConfidenceGrades: new Set(["D"]),
  sizePct: 0.02,
  maxPositions: 3,
  hardStopPct: 0.12,
  breakEvenActivationMultiple: 1.08,
  trailingActivationMultiple: 1.18,
  trailingStopPct: 0.10,
  takeProfitMultiple: 1.35,
  maxHoldMinutes: 60,
};

type ShadowState = {
  bankroll_sol: number | string;
  starting_bankroll_sol: number | string;
  enabled: boolean;
};

type ShadowPosition = {
  mint: string;
  token_symbol: string;
  entry_price: number | string;
  entry_time: string;
  size_sol: number | string;
  remaining_pct: number | string;
  peak_multiple: number | string;
  entry_alert: AlertInput;
  position_id: string;
  realized_pnl_sol: number | string;
};

let operationTail: Promise<void> = Promise.resolve();

async function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const previous = operationTail;
  let release!: () => void;
  operationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

async function loadState(): Promise<ShadowState> {
  const { data, error } = await supabase.from("shadow_strategy_state").select("bankroll_sol, starting_bankroll_sol, enabled").eq("id", 1).single();
  if (error) throw new Error(`shadow state load failed: ${error.message}`);
  return data;
}
async function loadPositions(): Promise<ShadowPosition[]> { const { data, error } = await supabase.from("shadow_positions").select("*"); if (error) throw new Error(`shadow positions load failed: ${error.message}`); return (data ?? []) as ShadowPosition[]; }
function entryRejection(alert: AlertInput): string | null { const avgBuy = alert.walletCount > 0 ? alert.totalBoughtSol / alert.walletCount : 0; if (alert.score < RULES.minScore) return `score ${alert.score} < ${RULES.minScore}`; if (alert.score > RULES.maxScore) return `score ${alert.score} > ${RULES.maxScore} (late-entry guard)`; if (alert.walletCount < RULES.minWallets) return `wallets ${alert.walletCount} < ${RULES.minWallets}`; if (avgBuy < RULES.minAvgBuySol) return `avg buy ${avgBuy.toFixed(2)} < ${RULES.minAvgBuySol}`; if (alert.liquidityUsd < RULES.minLiquidityUsd) return `liquidity ${alert.liquidityUsd} < ${RULES.minLiquidityUsd}`; if (alert.marketCapUsd < RULES.minMarketCapUsd) return `market cap ${alert.marketCapUsd} < ${RULES.minMarketCapUsd}`; if (alert.marketCapUsd > RULES.maxMarketCapUsd) return `market cap ${alert.marketCapUsd} > ${RULES.maxMarketCapUsd}`; if (alert.confidenceGrade && RULES.blockedConfidenceGrades.has(alert.confidenceGrade)) return `confidence ${alert.confidenceGrade} blocked`; return null; }

export * from './shadowStrategy';