import type { JupiterQuoteOnlyResult } from "../lib/jupiterQuote";

const LAMPORTS_PER_SOL = 1_000_000_000;

function envNumber(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export const LIVE_COSTS = {
  baseNetworkFeeSol: envNumber("SNIPER_NETWORK_FEE_SOL_PER_TX", 0.000005, 0, 0.01),
  priorityFeeSol: envNumber("SNIPER_PRIORITY_FEE_SOL_PER_TX", 0.00015, 0, 0.05),
  jitoTipSol: envNumber("SNIPER_JITO_TIP_SOL_PER_TX", 0.0001, 0, 0.05),
  routeChangePenaltyBps: envNumber("SNIPER_ROUTE_CHANGE_PENALTY_BPS", 35, 0, 1_000),
  partialFillPenaltyBps: envNumber("SNIPER_PARTIAL_FILL_PENALTY_BPS", 25, 0, 1_000),
} as const;

export function legOverheadSol(): number {
  return LIVE_COSTS.baseNetworkFeeSol + LIVE_COSTS.priorityFeeSol + LIVE_COSTS.jitoTipSol;
}

function rawAmount(raw: Record<string, unknown> | null, key: string): bigint | null {
  const value = raw?.[key];
  return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : null;
}

export function conservativeQuoteOutputRaw(quote: JupiterQuoteOnlyResult): bigint {
  const quoted = rawAmount(quote.raw, "outAmount") ?? quote.outLamports;
  const threshold = rawAmount(quote.raw, "otherAmountThreshold") ?? quoted;
  const base = quoted < threshold ? quoted : threshold;
  const penaltyBps = BigInt(Math.round(LIVE_COSTS.routeChangePenaltyBps + LIVE_COSTS.partialFillPenaltyBps));
  return base * (10_000n - penaltyBps) / 10_000n;
}

export function conservativeSolProceeds(quote: JupiterQuoteOnlyResult): number {
  const gross = Number(conservativeQuoteOutputRaw(quote)) / LAMPORTS_PER_SOL;
  return Math.max(0, gross - legOverheadSol());
}

export function routeFeeSummary(raw: Record<string, unknown> | null) {
  const routePlan = Array.isArray(raw?.routePlan) ? raw?.routePlan : [];
  return {
    dexAndJupiterFeesIncludedInQuote: true,
    routePlan,
    priceImpactPct: Number(raw?.priceImpactPct ?? 0),
    quotedOutAmount: raw?.outAmount ?? null,
    worstCaseThreshold: raw?.otherAmountThreshold ?? null,
    networkFeeSol: LIVE_COSTS.baseNetworkFeeSol,
    priorityFeeSol: LIVE_COSTS.priorityFeeSol,
    jitoTipSol: LIVE_COSTS.jitoTipSol,
    routeChangePenaltyBps: LIVE_COSTS.routeChangePenaltyBps,
    partialFillPenaltyBps: LIVE_COSTS.partialFillPenaltyBps,
  };
}
