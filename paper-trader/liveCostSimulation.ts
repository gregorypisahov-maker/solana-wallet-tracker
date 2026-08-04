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
  expectedSlippageBps: envNumber("SNIPER_EXPECTED_SLIPPAGE_BPS", 30, 0, 1_000),
  routeChangePenaltyBps: envNumber("SNIPER_ROUTE_CHANGE_PENALTY_BPS", 0, 0, 1_000),
  partialFillPenaltyBps: envNumber("SNIPER_PARTIAL_FILL_PENALTY_BPS", 0, 0, 1_000),
} as const;

export function legOverheadSol(): number {
  return LIVE_COSTS.baseNetworkFeeSol + LIVE_COSTS.priorityFeeSol + LIVE_COSTS.jitoTipSol;
}

function rawAmount(raw: Record<string, unknown> | null, key: string): bigint | null {
  const value = raw?.[key];
  return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : null;
}

export function expectedQuoteOutputRaw(quote: JupiterQuoteOnlyResult): bigint {
  const quoted = rawAmount(quote.raw, "outAmount") ?? quote.outLamports;
  const totalBps = BigInt(Math.round(
    LIVE_COSTS.expectedSlippageBps +
    LIVE_COSTS.routeChangePenaltyBps +
    LIVE_COSTS.partialFillPenaltyBps
  ));
  return quoted * (10_000n - totalBps) / 10_000n;
}

export function expectedRoundTripCostSol(positionSizeSol: number): number {
  const variablePct = (LIVE_COSTS.expectedSlippageBps * 2 + LIVE_COSTS.routeChangePenaltyBps + LIVE_COSTS.partialFillPenaltyBps) / 10_000;
  return Math.max(0, positionSizeSol * variablePct + legOverheadSol() * 2);
}

export function expectedRoundTripCostPct(positionSizeSol: number): number {
  return positionSizeSol > 0 ? expectedRoundTripCostSol(positionSizeSol) / positionSizeSol * 100 : Number.POSITIVE_INFINITY;
}

export function conservativeSolProceeds(quote: JupiterQuoteOnlyResult, entrySizeSol = 0): number {
  const expectedExitGross = Number(expectedQuoteOutputRaw(quote)) / LAMPORTS_PER_SOL;
  const entryExpectedSlippageSol = entrySizeSol * LIVE_COSTS.expectedSlippageBps / 10_000;
  const entryCostSol = entryExpectedSlippageSol + legOverheadSol();
  return Math.max(0, expectedExitGross - legOverheadSol() - entryCostSol);
}

export function routeFeeSummary(raw: Record<string, unknown> | null) {
  const routePlan = Array.isArray(raw?.routePlan) ? raw?.routePlan : [];
  return {
    dexAndJupiterFeesIncludedInQuote: true,
    routePlan,
    priceImpactPct: Number(raw?.priceImpactPct ?? 0),
    quotedOutAmount: raw?.outAmount ?? null,
    worstCaseThreshold: raw?.otherAmountThreshold ?? null,
    fillMarkPolicy: "quoted_out_amount_less_expected_costs",
    expectedSlippageBps: LIVE_COSTS.expectedSlippageBps,
    networkFeeSol: LIVE_COSTS.baseNetworkFeeSol,
    priorityFeeSol: LIVE_COSTS.priorityFeeSol,
    jitoTipSol: LIVE_COSTS.jitoTipSol,
    routeChangePenaltyBps: LIVE_COSTS.routeChangePenaltyBps,
    partialFillPenaltyBps: LIVE_COSTS.partialFillPenaltyBps,
  };
}
