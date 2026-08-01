import fs from "node:fs";

const target = "paper-trader/aiDiscoveryTrader.ts";
let source = fs.readFileSync(target, "utf8");
const original = source;

function replaceOnce(label, search, replacement) {
  if (source.includes(replacement)) return;
  const count = source.split(search).length - 1;
  if (count !== 1) {
    throw new Error(`[ai-early-exit-patch] ${label}: expected one anchor, found ${count}`);
  }
  source = source.replace(search, replacement);
}

replaceOnce(
  "version",
  'const VERSION = "ai_discovery_trader_v1_9_shared_entry_safety_2026_07_28";',
  'const VERSION = "ai_discovery_trader_v2_0_early_sellability_credit_budget_2026_08_01";'
);

replaceOnce(
  "quote fail threshold",
  'Math.min(10, Number(process.env.AI_MAX_QUOTE_FAIL_STREAK) || 3)',
  'Math.min(10, Number(process.env.AI_MAX_QUOTE_FAIL_STREAK) || 2)'
);

replaceOnce(
  "risk constants",
  `const EMERGENCY_EXIT_FLOOR_PCT = Math.min(
  100,
  Math.max(0, Number(process.env.EMERGENCY_EXIT_FLOOR_PCT) || 30)
);`,
  `const EMERGENCY_EXIT_FLOOR_PCT = Math.min(
  100,
  Math.max(0, Number(process.env.EMERGENCY_EXIT_FLOOR_PCT) || 30)
);
// Exit while a usable route still exists instead of waiting for an 80-100% collapse.
const EARLY_RECOVERY_FLOOR_PCT = Math.min(
  100,
  Math.max(50, Number(process.env.AI_EARLY_RECOVERY_FLOOR_PCT) || 88)
);
const EXECUTABLE_DRAWDOWN_EXIT_PCT = Math.min(
  50,
  Math.max(3, Number(process.env.AI_EXECUTABLE_DRAWDOWN_EXIT_PCT) || 12)
);
const SMALL_PROFIT_ARM_PCT = Math.min(
  10,
  Math.max(0.25, Number(process.env.AI_SMALL_PROFIT_ARM_PCT) || 1)
);
const SMALL_PROFIT_FLOOR_PCT = Math.min(
  SMALL_PROFIT_ARM_PCT,
  Math.max(0, Number(process.env.AI_SMALL_PROFIT_FLOOR_PCT) || 0.15)
);
const MAX_EXPENSIVE_CANDIDATES_PER_SCAN = Math.min(
  20,
  Math.max(1, Number(process.env.AI_MAX_EXPENSIVE_CANDIDATES_PER_SCAN) || 6)
);`
);

replaceOnce(
  "candidate budget",
  `for (const opportunity of opportunities.filter(
      (item: any) => ruleAssessment(item).passed
    )) {`,
  `for (const opportunity of opportunities
      .filter((item: any) => ruleAssessment(item).passed)
      .sort((a: any, b: any) => n(b.score) - n(a.score))
      .slice(0, MAX_EXPENSIVE_CANDIDATES_PER_SCAN)) {`
);

replaceOnce(
  "outcome price source",
  `const market = await pairFor(
          observation.mint,
          observation.pair_address,
          0
        );`,
  `// Historical outcome sampling is useful for learning, but it must not spend
        // Helius credits. A positive liquidity floor bypasses the Helius-first
        // branch and uses the rate-limited DexScreener queue instead.
        const market = await pairFor(
          observation.mint,
          observation.pair_address,
          1
        );`
);

replaceOnce(
  "early exit logic",
  `if (recoveryPct < EMERGENCY_EXIT_FLOOR_PCT) {
          await closeTrade(position, valuation, "emergency_liquidity_drop");
          continue;
        }

        const entry = n(position.entry_price_usd);`,
  `if (recoveryPct < EMERGENCY_EXIT_FLOOR_PCT) {
          await closeTrade(position, valuation, "emergency_liquidity_drop");
          continue;
        }

        const previousExecutable = Math.max(
          n(position.last_executable_value_sol, valuation.entryValueSol),
          Number.EPSILON
        );
        const executablePeak = Math.max(
          n(position.quote_peak_value_sol, valuation.entryValueSol),
          previousExecutable,
          valuation.executableSol
        );
        const executableDrawdownPct =
          executablePeak > 0
            ? ((executablePeak - valuation.executableSol) / executablePeak) * 100
            : 0;
        const netExecutablePct =
          entryValue > 0 ? ((valuation.proceedsSol / entryValue) - 1) * 100 : -100;
        const peakNetExecutablePct =
          entryValue > 0 ? ((executablePeak / entryValue) - 1) * 100 : -100;

        // The old engine waited until recovery was below the emergency floor.
        // By then an LP pull could already be almost total. Leave while Jupiter
        // still returns a route if executable value is deteriorating sharply.
        if (
          recoveryPct < EARLY_RECOVERY_FLOOR_PCT ||
          (executableDrawdownPct >= EXECUTABLE_DRAWDOWN_EXIT_PCT &&
            valuation.executableSol < previousExecutable)
        ) {
          await closeTrade(position, valuation, "sellability_deterioration");
          continue;
        }

        // Once a small executable profit existed, protect it. This directly
        // handles the case where a token briefly offered a small profit before
        // liquidity and route quality weakened.
        if (
          peakNetExecutablePct >= SMALL_PROFIT_ARM_PCT &&
          netExecutablePct <= SMALL_PROFIT_FLOOR_PCT
        ) {
          await closeTrade(position, valuation, "small_profit_protected");
          continue;
        }

        const entry = n(position.entry_price_usd);`
);

replaceOnce(
  "startup diagnostics",
  '`outcomeBatch=${OUTCOME_BATCH_SIZE}; ` +',
  '`outcomeBatch=${OUTCOME_BATCH_SIZE}; expensiveCandidates=${MAX_EXPENSIVE_CANDIDATES_PER_SCAN}; ` +\n      `earlyRecoveryFloor=${EARLY_RECOVERY_FLOOR_PCT}% executableDrawdown=${EXECUTABLE_DRAWDOWN_EXIT_PCT}%; ` +'
);

if (source === original) {
  console.log("[ai-early-exit-patch] already applied");
} else {
  fs.writeFileSync(target, source);
  console.log("[ai-early-exit-patch] applied early sellability exits and Helius budget");
}
