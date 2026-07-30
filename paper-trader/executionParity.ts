import { PAPER_COST_MODEL } from "./executionCosts";

const LAMPORTS_PER_SOL = 1_000_000_000;

const finiteEnv = (name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
  const parsed = Number(process.env[name] ?? fallback);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

export const EXECUTION_PARITY_CONFIG = {
  version: "ai_execution_parity_v1_2026_07_30",
  enabled: process.env.AI_EXECUTION_PARITY_ENABLED !== "false",
  shadowOnly: process.env.AI_EXECUTION_PARITY_SHADOW_ONLY !== "false",
  execRiskBpsPerLeg: finiteEnv("AI_EXEC_RISK_BPS_PER_LEG", 75, 0, 1_000),
  maxAcceptableExitImpactPct: finiteEnv("AI_MAX_SHADOW_EXIT_PRICE_IMPACT_PCT", 5, 0, 100),
} as const;

export type QuoteLeg = {
  status: "available" | "no_route" | "quote_failed";
  inAmountRaw: string | null;
  outAmountRaw: string | null;
  priceImpactPct: number | null;
  platformFeeAmountRaw: string | null;
  platformFeeBps: number | null;
  routeLabels: string[];
  raw: Record<string, unknown> | null;
  error: string | null;
};

export type ModeledParity = {
  modelVersion: string;
  status: "modeled" | "entry_unavailable" | "exit_unavailable";
  executableNetReturnPct: number | null;
  stressNetReturnPct: number | null;
  executablePnlSol: number | null;
  stressPnlSol: number | null;
  cost: {
    baseFeeSol: number;
    priorityFeeSol: number;
    jitoTipSol: number;
    networkFeeSol: number;
    knownRoundTripFeeSol: number;
    stressHaircutSol: number;
    totalExecutableCostSol: number;
    totalStressCostSol: number;
  };
};

const asRecord = (value: unknown): Record<string, any> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;

const finiteNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function parseJupiterQuoteLeg(
  raw: Record<string, unknown> | null,
  error: string | null = null
): QuoteLeg {
  if (!raw) {
    return {
      status: error ? "quote_failed" : "no_route",
      inAmountRaw: null,
      outAmountRaw: null,
      priceImpactPct: null,
      platformFeeAmountRaw: null,
      platformFeeBps: null,
      routeLabels: [],
      raw: null,
      error,
    };
  }

  const quote = asRecord(raw);
  const outAmountRaw = quote?.outAmount == null ? null : String(quote.outAmount);
  const routePlan = Array.isArray(quote?.routePlan) ? quote.routePlan : [];
  const routeLabels = routePlan
    .map((leg: any) => String(leg?.swapInfo?.label ?? "").trim())
    .filter(Boolean);
  const fee = asRecord(quote?.platformFee);

  return {
    status: outAmountRaw && /^\d+$/.test(outAmountRaw) && BigInt(outAmountRaw) > 0n
      ? "available"
      : "no_route",
    inAmountRaw: quote?.inAmount == null ? null : String(quote.inAmount),
    outAmountRaw,
    priceImpactPct: finiteNumber(quote?.priceImpactPct),
    platformFeeAmountRaw: fee?.amount == null ? null : String(fee.amount),
    platformFeeBps: finiteNumber(fee?.feeBps),
    routeLabels,
    raw,
    error,
  };
}

export function modelRoundTrip(input: {
  sizeSol: number;
  entry: QuoteLeg;
  exit: QuoteLeg;
  exitOutLamports: bigint;
}): ModeledParity {
  const sizeSol = Math.max(0, input.sizeSol);
  const fixedPerTx = PAPER_COST_MODEL.networkCostSolPerTransaction;
  const knownRoundTripFeeSol = fixedPerTx * 2;
  const executableProceedsSol = Number(input.exitOutLamports) / LAMPORTS_PER_SOL;
  const executablePnlSol = executableProceedsSol - sizeSol - knownRoundTripFeeSol;
  const stressHaircutSol =
    sizeSol * (EXECUTION_PARITY_CONFIG.execRiskBpsPerLeg / 10_000) +
    executableProceedsSol * (EXECUTION_PARITY_CONFIG.execRiskBpsPerLeg / 10_000);
  const stressPnlSol = executablePnlSol - stressHaircutSol;

  const status = input.entry.status !== "available"
    ? "entry_unavailable"
    : input.exit.status !== "available"
      ? "exit_unavailable"
      : "modeled";

  return {
    modelVersion: EXECUTION_PARITY_CONFIG.version,
    status,
    executableNetReturnPct: status === "modeled" && sizeSol > 0
      ? (executablePnlSol / sizeSol) * 100
      : null,
    stressNetReturnPct: status === "modeled" && sizeSol > 0
      ? (stressPnlSol / sizeSol) * 100
      : null,
    executablePnlSol: status === "modeled" ? executablePnlSol : null,
    stressPnlSol: status === "modeled" ? stressPnlSol : null,
    cost: {
      baseFeeSol: PAPER_COST_MODEL.baseFeeSolPerTransaction * 2,
      priorityFeeSol: PAPER_COST_MODEL.priorityFeeSolPerTransaction * 2,
      jitoTipSol: PAPER_COST_MODEL.jitoTipSolPerTransaction * 2,
      networkFeeSol: fixedPerTx * 2,
      knownRoundTripFeeSol,
      stressHaircutSol,
      totalExecutableCostSol: knownRoundTripFeeSol,
      totalStressCostSol: knownRoundTripFeeSol + stressHaircutSol,
    },
  };
}
