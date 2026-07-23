import { getSupabaseAdmin } from "../lib/supabase";

export type PaperCostStrategy = "MAIN" | "SHADOW" | "TIERED" | "SCALP";

const finiteEnv = (name: string, fallback: number, minimum = 0): number => {
  const parsed = Number(process.env[name] ?? fallback);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
};

const boundedEnv = (
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number => Math.min(maximum, Math.max(minimum, finiteEnv(name, fallback, minimum)));

/**
 * P0 calibration, 2026-07-23 UTC.
 *
 * - 0.2 SOL Jupiter quotes were sampled on four live PumpSwap pools whose
 *   liquidity was inside the strategy's $15k-$60k target band.
 * - Incremental size slippage was 0.086%-0.164%; a coefficient of 2.0 times
 *   trade-notional/pool-liquidity reproduces the centre of that sample.
 * - PumpSwap canonical-pool fees in this market-cap band are 1.10%-1.25% per
 *   side. The model uses the conservative 1.25% tier.
 * - Jupiter's live HIGH priority estimate was 225,430 lamports. Adding the
 *   5,000-lamport Solana base fee gives 230,430 lamports per transaction.
 * - No real-money execution telemetry exists yet. The 5% failed-entry rate is
 *   therefore an explicit scenario input, not a measured production rate, and
 *   remains overrideable by environment variable.
 */
export const PAPER_COST_MODEL = {
  enabled: process.env.PAPER_COST_MODEL_ENABLED === "true",
  version: "p0_jupiter_pumpswap_2026_07_23_v1",
  calibrationDate: "2026-07-23",
  networkCostSolPerTransaction: finiteEnv(
    "PAPER_NETWORK_COST_SOL_PER_TX",
    0.00023043
  ),
  swapFeePctPerSide: boundedEnv("PAPER_SWAP_FEE_PCT_PER_SIDE", 0.0125, 0, 1),
  slippageLiquidityCoefficient: finiteEnv(
    "PAPER_SLIPPAGE_LIQUIDITY_COEFFICIENT",
    2.0
  ),
  solUsdReference: finiteEnv("PAPER_COST_SOL_USD_REFERENCE", 76.6981212318335, 0.01),
  failedTransactionRate: boundedEnv("PAPER_FAILED_TRANSACTION_RATE", 0.05, 0, 0.95),
} as const;

export type ExecutionCostBreakdown = {
  networkFeeSol: number;
  swapFeeSol: number;
  slippageSol: number;
  totalSol: number;
  liquidityUsd: number;
  notionalSol: number;
  slippagePct: number;
  costModelVersion: string;
};

const positive = (value: unknown, label: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`[paper-costs] ${label} must be a positive finite number`);
  }
  return parsed;
};

export function estimateLiquiditySlippagePct(
  notionalSol: number,
  liquidityUsd: number
): number {
  const sizeSol = positive(notionalSol, "notionalSol");
  const poolLiquidityUsd = positive(liquidityUsd, "liquidityUsd");
  return (
    PAPER_COST_MODEL.slippageLiquidityCoefficient *
    ((sizeSol * PAPER_COST_MODEL.solUsdReference) / poolLiquidityUsd)
  );
}

function calculateExecutionCosts(
  notionalSol: number,
  liquidityUsd: number
): ExecutionCostBreakdown {
  const sizeSol = positive(notionalSol, "notionalSol");
  const poolLiquidityUsd = positive(liquidityUsd, "liquidityUsd");

  if (!PAPER_COST_MODEL.enabled) {
    return {
      networkFeeSol: 0,
      swapFeeSol: 0,
      slippageSol: 0,
      totalSol: 0,
      liquidityUsd: poolLiquidityUsd,
      notionalSol: sizeSol,
      slippagePct: 0,
      costModelVersion: "legacy_price_friction",
    };
  }

  const slippagePct = estimateLiquiditySlippagePct(sizeSol, poolLiquidityUsd);
  const networkFeeSol = PAPER_COST_MODEL.networkCostSolPerTransaction;
  const swapFeeSol = sizeSol * PAPER_COST_MODEL.swapFeePctPerSide;
  const slippageSol = sizeSol * slippagePct;

  return {
    networkFeeSol,
    swapFeeSol,
    slippageSol,
    totalSol: networkFeeSol + swapFeeSol + slippageSol,
    liquidityUsd: poolLiquidityUsd,
    notionalSol: sizeSol,
    slippagePct,
    costModelVersion: PAPER_COST_MODEL.version,
  };
}

export const calculateEntryExecutionCosts = calculateExecutionCosts;
export const calculateExitExecutionCosts = calculateExecutionCosts;

export function shouldSimulateFailedEntry(randomValue = Math.random()): boolean {
  return (
    PAPER_COST_MODEL.enabled &&
    randomValue >= 0 &&
    randomValue < PAPER_COST_MODEL.failedTransactionRate
  );
}

export async function appendFailedPaperEntry(input: {
  strategy: PaperCostStrategy;
  mint: string;
  tokenSymbol: string;
  attemptedSizeSol: number;
  liquidityUsd: number;
  networkFeeSol: number;
  reason?: string;
  snapshot?: Record<string, unknown>;
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("paper_failed_entries").insert({
    strategy: input.strategy,
    mint: input.mint,
    token_symbol: input.tokenSymbol,
    attempted_size_sol: input.attemptedSizeSol,
    liquidity_usd: input.liquidityUsd,
    network_fee_sol: input.networkFeeSol,
    reason: input.reason ?? "simulated_entry_transaction_failed",
    cost_model_version: PAPER_COST_MODEL.version,
    cost_snapshot: {
      failed_transaction_rate: PAPER_COST_MODEL.failedTransactionRate,
      calibration_date: PAPER_COST_MODEL.calibrationDate,
      ...input.snapshot,
    },
    happened_at: new Date().toISOString(),
  });
  if (error) throw new Error(`[paper-costs] failed-entry log insert failed: ${error.message}`);
}
