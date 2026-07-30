import fs from "node:fs";

const path = "paper-trader/aiDiscoveryTrader.ts";
let source = fs.readFileSync(path, "utf8");

function replaceOnce(before, after, label) {
  if (!source.includes(before)) throw new Error(`[real-readiness] missing patch anchor: ${label}`);
  source = source.replace(before, after);
}

replaceOnce(
  'import { PAPER_COST_MODEL } from "./executionCosts";',
  'import { PAPER_COST_MODEL } from "./executionCosts";\nimport { EXECUTION_PARITY_CONFIG, modelRoundTrip, parseJupiterQuoteLeg } from "./executionParity";',
  "parity import"
);

replaceOnce(
  'const VERSION = "ai_discovery_trader_v1_9_shared_entry_safety_2026_07_28";',
  'const VERSION = "ai_discovery_trader_v2_execution_parity_2026_07_30";',
  "version"
);

replaceOnce(
`  const sizeSol = n(position.size_sol);
  const proceeds = Math.max(0, valuation.proceedsSol);
  const pnlSol = proceeds - sizeSol;
  const grossPct = sizeSol > 0 ? ((valuation.executableSol / sizeSol) - 1) * 100 : -100;
  const netPct = sizeSol > 0 ? (pnlSol / sizeSol) * 100 : -100;
  const now = new Date().toISOString();`,
`  const sizeSol = n(position.size_sol);
  const entryRaw = (position.entry_snapshot?.entryQuote ?? null) as Record<string, unknown> | null;
  const entryLeg = parseJupiterQuoteLeg(entryRaw);
  const exitLeg = parseJupiterQuoteLeg(
    valuation.rawQuote ?? null,
    valuation.quoteCallFailed ? (valuation.quoteError ?? "quote_failed") : null
  );
  const parity = modelRoundTrip({
    sizeSol,
    entry: entryLeg,
    exit: exitLeg,
    exitOutLamports: valuation.outLamports,
  });
  const proceeds = parity.status === "modeled"
    ? Math.max(0, valuation.executableSol - parity.cost.knownRoundTripFeeSol)
    : Math.max(0, valuation.proceedsSol);
  const pnlSol = proceeds - sizeSol;
  const grossPct = sizeSol > 0 ? ((valuation.executableSol / sizeSol) - 1) * 100 : -100;
  const netPct = sizeSol > 0 ? (pnlSol / sizeSol) * 100 : -100;
  const strategyEntryPrice = n(position.entry_price_usd);
  const executableEntryPrice = strategyEntryPrice > 0 && entryLeg.status === "available"
    ? strategyEntryPrice * (sizeSol / Math.max(sizeSol - PAPER_COST_MODEL.networkCostSolPerTransaction, Number.EPSILON))
    : null;
  const entryDisadvantagePct = executableEntryPrice && strategyEntryPrice > 0
    ? ((executableEntryPrice / strategyEntryPrice) - 1) * 100
    : null;
  const exitDisadvantagePct = strategyEntryPrice > 0 && valuation.impliedPriceUsd > 0
    ? ((strategyEntryPrice - valuation.impliedPriceUsd) / strategyEntryPrice) * 100
    : null;
  const now = new Date().toISOString();`,
  "close accounting"
);

replaceOnce(
`    gross_return_pct: grossPct,
    net_return_pct: netPct,
    pnl_sol: pnlSol,
    execution_source: valuation.source,`,
`    gross_return_pct: grossPct,
    net_return_pct: netPct,
    pnl_sol: pnlSol,
    modeled_executable_net_return_pct: parity.executableNetReturnPct,
    modeled_stress_net_return_pct: parity.stressNetReturnPct,
    modeled_executable_pnl_sol: parity.executablePnlSol,
    modeled_stress_pnl_sol: parity.stressPnlSol,
    execution_model_status: parity.status,
    execution_model_version: parity.modelVersion,
    entry_executable_price_usd: executableEntryPrice,
    exit_executable_price_usd: Math.max(0, valuation.impliedPriceUsd),
    entry_price_disadvantage_pct: entryDisadvantagePct,
    exit_price_disadvantage_pct: exitDisadvantagePct,
    entry_price_impact_pct: entryLeg.priceImpactPct,
    exit_price_impact_pct: exitLeg.priceImpactPct,
    execution_costs: parity.cost,
    execution_source: valuation.source,`,
  "trade parity columns"
);

replaceOnce(
`      quote: valuation.rawQuote ?? null,
      peakPriceUsd: n(position.peak_price_usd),`,
`      quote: valuation.rawQuote ?? null,
      entryExecutableQuote: entryLeg,
      exitExecutableQuote: exitLeg,
      executionParity: parity,
      assumptions: {
        shadowOnly: EXECUTION_PARITY_CONFIG.shadowOnly,
        execRiskBpsPerLeg: EXECUTION_PARITY_CONFIG.execRiskBpsPerLeg,
        routeImpactNotDoubleCounted: true,
        stressIsAssumptionNotMeasuredMev: true,
      },
      peakPriceUsd: n(position.peak_price_usd),`,
  "exit snapshot"
);

replaceOnce(
`          if (nextStreak >= MAX_QUOTE_FAIL_STREAK || heldMs >= MAX_HOLD_MS) {
            await closeTrade(position, valuation, "quote_unavailable_forced_exit");
            continue;
          }`,
`          if (nextStreak >= MAX_QUOTE_FAIL_STREAK || heldMs >= MAX_HOLD_MS) {
            const now = new Date().toISOString();
            await supabase.from("ai_discovery_state").update({
              halted: true,
              halt_reason: "paper_quote_unavailable_requires_review",
              updated_at: now,
            }).eq("id", 1);
            await supabase.from("ai_discovery_positions").update({
              quote_fail_streak: nextStreak,
              last_checked_at: now,
              updated_at: now,
              entry_snapshot: {
                ...(position.entry_snapshot ?? {}),
                executionModelStatus: "exit_quote_failed",
                executionModelError: valuation.quoteError ?? "quote_failed",
              },
            }).eq("position_id", position.position_id);
            console.error(
              \`[ai-discovery-trader] halted: executable exit quote unavailable for \${position.token_symbol}; no fill fabricated\`
            );
            continue;
          }`,
  "no fabricated forced exit"
);

fs.writeFileSync(path, source);
console.log("[real-readiness] patched aiDiscoveryTrader.ts");
