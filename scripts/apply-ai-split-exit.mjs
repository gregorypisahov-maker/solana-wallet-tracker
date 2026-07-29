import fs from "node:fs";
import path from "node:path";

const file = path.resolve(process.cwd(), "paper-trader/aiDiscoveryTrader.ts");
let source = fs.readFileSync(file, "utf8");
const marker = "ai_discovery_trader_v2_split_exit_2026_07_29";

if (source.includes(marker)) {
  console.log("[patch-ai-split-exit] already applied");
  process.exit(0);
}

function replaceOnce(from, to, label) {
  if (!source.includes(from)) {
    throw new Error(`[patch-ai-split-exit] missing anchor: ${label}`);
  }
  source = source.replace(from, to);
}

replaceOnce(
  'const VERSION = "ai_discovery_trader_v1_9_shared_entry_safety_2026_07_28";',
  `const VERSION = "${marker}";`,
  "version"
);

replaceOnce(
  `const TRAIL_DISTANCE_PCT = 4;\nconst MAX_HOLD_MS = 45 * 60_000;`,
  `const TRAIL_DISTANCE_PCT = 4;\nconst SPLIT_EXIT_ENABLED = process.env.AI_PAPER_SPLIT_EXIT_ENABLED !== "false";\nconst SPLIT_MIN_SCORE = Math.max(82, Number(process.env.AI_PAPER_SPLIT_MIN_SCORE) || 90);\nconst SPLIT_PARTIAL_FRACTION = 0.5;\nconst SPLIT_TRAIL_DISTANCE_PCT = Math.max(4, Number(process.env.AI_PAPER_SPLIT_TRAIL_PCT) || 6);\nconst MAX_HOLD_MS = 45 * 60_000;`,
  "split constants"
);

replaceOnce(
  `  size_sol: number | string;\n  token_amount: string | null;`,
  `  size_sol: number | string;\n  original_size_sol: number | string | null;\n  remaining_cost_sol: number | string | null;\n  remaining_fraction: number | string | null;\n  partial_tp_taken: boolean | null;\n  partial_tp_price_usd: number | string | null;\n  partial_tp_proceeds_sol: number | string | null;\n  partial_tp_pnl_sol: number | string | null;\n  partial_tp_at: string | null;\n  token_amount: string | null;`,
  "position fields"
);

replaceOnce(
  `    size_sol: sizeSol,\n    token_amount: entryQuote.tokenAmount,`,
  `    size_sol: sizeSol,\n    original_size_sol: sizeSol,\n    remaining_cost_sol: sizeSol,\n    remaining_fraction: 1,\n    partial_tp_taken: false,\n    partial_tp_proceeds_sol: 0,\n    partial_tp_pnl_sol: 0,\n    token_amount: entryQuote.tokenAmount,`,
  "open position split fields"
);

replaceOnce(
  `async function syncPositionTokenAmount(\n  position: Position,\n  mirror: LiveMirror | null\n): Promise<string | null> {\n  if (mirror?.token_amount && mirror.token_amount !== position.token_amount) {\n    await supabase\n      .from("ai_discovery_positions")\n      .update({ token_amount: mirror.token_amount, updated_at: new Date().toISOString() })\n      .eq("position_id", position.position_id);\n    position.token_amount = mirror.token_amount;\n  }\n  return position.token_amount;\n}`,
  `async function syncPositionTokenAmount(\n  position: Position,\n  mirror: LiveMirror | null\n): Promise<string | null> {\n  // Once the paper-only split exit has happened, never copy the full live token\n  // balance back into the half-sized paper remainder.\n  if (!position.partial_tp_taken && mirror?.token_amount && mirror.token_amount !== position.token_amount) {\n    await supabase\n      .from("ai_discovery_positions")\n      .update({ token_amount: mirror.token_amount, updated_at: new Date().toISOString() })\n      .eq("position_id", position.position_id);\n    position.token_amount = mirror.token_amount;\n  }\n  return position.token_amount;\n}`,
  "live token sync isolation"
);

replaceOnce(
  `async function quoteExitValuation(\n  position: Position,\n  mirror: LiveMirror | null\n): Promise<ExitValuation> {\n  const entryValueSol = Math.max(0, n(mirror?.spent_sol, n(position.size_sol)));\n  const tokenAmount = await syncPositionTokenAmount(position, mirror);`,
  `async function quoteExitValuation(\n  position: Position,\n  mirror: LiveMirror | null,\n  options?: { tokenAmount?: string; entryValueSol?: number; ignoreLiveMirror?: boolean }\n): Promise<ExitValuation> {\n  const paperEntryValue = n(position.remaining_cost_sol, n(position.size_sol));\n  const mirrorEntryValue = options?.ignoreLiveMirror || position.partial_tp_taken\n    ? paperEntryValue\n    : n(mirror?.spent_sol, paperEntryValue);\n  const entryValueSol = Math.max(0, options?.entryValueSol ?? mirrorEntryValue);\n  const tokenAmount = options?.tokenAmount ?? await syncPositionTokenAmount(position, mirror);`,
  "quote override support"
);

replaceOnce(
  `async function closeTrade(\n  position: Position,`,
  `function entryScore(position: Position): number {\n  return n((position.entry_snapshot as any)?.opportunity?.score);\n}\n\nasync function currentMomentumM5(position: Position): Promise<number> {\n  const { data, error } = await supabase\n    .from("market_opportunities")\n    .select("price_change_m5")\n    .eq("mint", position.mint)\n    .maybeSingle();\n  if (error) {\n    console.warn(`[ai-discovery-trader] split momentum unavailable for ${position.token_symbol}: ${error.message}`);\n    return 0;\n  }\n  return n(data?.price_change_m5);\n}\n\nasync function takePartialProfit(position: Position, peakPriceUsd: number): Promise<boolean> {\n  const raw = position.token_amount;\n  if (!raw || !/^\\d+$/.test(raw)) return false;\n  const totalRaw = BigInt(raw);\n  const soldRaw = totalRaw / 2n;\n  const remainingRaw = totalRaw - soldRaw;\n  if (soldRaw <= 0n || remainingRaw <= 0n) return false;\n\n  const originalSize = n(position.original_size_sol, n(position.size_sol));\n  const partialCost = originalSize * SPLIT_PARTIAL_FRACTION;\n  const valuation = await quoteExitValuation(position, null, {\n    tokenAmount: soldRaw.toString(),\n    entryValueSol: partialCost,\n    ignoreLiveMirror: true,\n  });\n  if (valuation.quoteCallFailed || !valuation.route) return false;\n\n  const partialProceeds = Math.max(0, valuation.proceedsSol);\n  const partialPnl = partialProceeds - partialCost;\n  const partialNetPct = partialCost > 0 ? (partialPnl / partialCost) * 100 : 0;\n  const { data, error } = await supabase.rpc("apply_ai_discovery_partial_tp", {\n    p_position_id: position.position_id,\n    p_remaining_token_amount: remainingRaw.toString(),\n    p_partial_price_usd: valuation.impliedPriceUsd,\n    p_partial_proceeds_sol: partialProceeds,\n    p_partial_pnl_sol: partialPnl,\n    p_remaining_cost_sol: originalSize * (1 - SPLIT_PARTIAL_FRACTION),\n    p_peak_price_usd: peakPriceUsd,\n    p_last_executable_value_sol: valuation.executableSol,\n  });\n  if (error) throw new Error(error.message);\n  if (data !== true) return false;\n\n  await sendTelegramAlert([\n    "✅ <b>AI DISCOVERY PAPER PROFIT LOCKED</b>",\n    "",\n    `Token: <b>${position.token_symbol}</b>`,\n    "Sold: <b>50%</b>",\n    `Locked net: <b>${partialNetPct >= 0 ? "+" : ""}${partialNetPct.toFixed(2)}%</b>`,\n    `Locked PnL: <b>${partialPnl >= 0 ? "+" : ""}${partialPnl.toFixed(5)} SOL</b>`,\n    `Remainder: <b>50% trailing ${SPLIT_TRAIL_DISTANCE_PCT.toFixed(0)}% from peak</b>`,\n    "",\n    "🧪 Paper only — live execution exits fully at the first take-profit.",\n  ].join("\\n"));\n  return true;\n}\n\nasync function closeTrade(\n  position: Position,`,
  "partial take-profit helpers"
);

replaceOnce(
  `  const sizeSol = n(position.size_sol);\n  const proceeds = Math.max(0, valuation.proceedsSol);\n  const pnlSol = proceeds - sizeSol;\n  const grossPct = sizeSol > 0 ? ((valuation.executableSol / sizeSol) - 1) * 100 : -100;\n  const netPct = sizeSol > 0 ? (pnlSol / sizeSol) * 100 : -100;`,
  `  const partialTaken = Boolean(position.partial_tp_taken);\n  const sizeSol = n(position.original_size_sol, n(position.size_sol));\n  const remainingCost = n(position.remaining_cost_sol, sizeSol);\n  const lockedProceeds = n(position.partial_tp_proceeds_sol);\n  const lockedPnl = n(position.partial_tp_pnl_sol);\n  const finalProceeds = Math.max(0, valuation.proceedsSol);\n  const finalPnl = finalProceeds - remainingCost;\n  const proceeds = lockedProceeds + finalProceeds;\n  const pnlSol = proceeds - sizeSol;\n  const grossPct = sizeSol > 0 ? ((proceeds / sizeSol) - 1) * 100 : -100;\n  const netPct = sizeSol > 0 ? (pnlSol / sizeSol) * 100 : -100;`,
  "combined split accounting"
);

replaceOnce(
  `    execution_source: valuation.source,`,
  `    execution_source: partialTaken ? "quote_split" : valuation.source,`,
  "split execution source"
);

replaceOnce(
  `      peakPriceUsd: n(position.peak_price_usd),\n    },`,
  `      peakPriceUsd: n(position.peak_price_usd),\n      splitExit: {\n        enabled: SPLIT_EXIT_ENABLED,\n        partialTaken,\n        partialFraction: partialTaken ? SPLIT_PARTIAL_FRACTION : 0,\n        partialPriceUsd: n(position.partial_tp_price_usd),\n        partialProceedsSol: lockedProceeds,\n        partialPnlSol: lockedPnl,\n        partialTakenAt: position.partial_tp_at ?? null,\n        finalProceedsSol: finalProceeds,\n        trailDistancePct: partialTaken ? SPLIT_TRAIL_DISTANCE_PCT : null,\n      },\n    },`,
  "split exit snapshot"
);

replaceOnce(
  `      bankroll_sol: n(state.bankroll_sol) + proceeds,\n      daily_realized_pnl_sol: n(state.daily_realized_pnl_sol) + pnlSol,`,
  `      // The first half was already credited atomically when profit was locked.\n      bankroll_sol: n(state.bankroll_sol) + finalProceeds,\n      daily_realized_pnl_sol: n(state.daily_realized_pnl_sol) + finalPnl,`,
  "final-leg state accounting"
);

replaceOnce(
  `    if (!trade || trade.execution_source === "live_mirror") continue;`,
  `    if (\n      !trade ||\n      trade.execution_source === "live_mirror" ||\n      trade.execution_source === "quote_split" ||\n      Boolean(trade.exit_snapshot?.splitExit?.partialTaken)\n    ) continue;`,
  "live mirror split isolation"
);

replaceOnce(
  `        let reason: string | null = null;\n        if (grossPct <= HARD_STOP_PCT) reason = "hard_stop";\n        else if (grossPct >= TAKE_PROFIT_PCT) reason = "take_profit";\n        else if (\n          peakPct >= TRAIL_ARM_PCT &&\n          pullbackPct <= -TRAIL_DISTANCE_PCT\n        ) {\n          reason = "trailing_stop";\n        } else if (heldMs >= MAX_HOLD_MS) {\n          reason = "max_hold";\n        }`,
  `        const partialTaken = Boolean(position.partial_tp_taken);\n        let reason: string | null = null;\n        if (grossPct <= HARD_STOP_PCT) {\n          reason = "hard_stop";\n        } else if (!partialTaken && grossPct >= TAKE_PROFIT_PCT) {\n          const strongEnough = SPLIT_EXIT_ENABLED && entryScore(position) >= SPLIT_MIN_SCORE;\n          const momentumM5 = strongEnough ? await currentMomentumM5(position) : 0;\n          if (strongEnough && momentumM5 > 0) {\n            const partialDone = await takePartialProfit(position, peak);\n            if (partialDone) continue;\n          }\n          // If the split quote cannot execute, preserve the original safe full exit.\n          reason = "take_profit";\n        } else if (\n          partialTaken &&\n          peakPct >= TAKE_PROFIT_PCT &&\n          pullbackPct <= -SPLIT_TRAIL_DISTANCE_PCT\n        ) {\n          reason = "trailing_stop";\n        } else if (\n          !partialTaken &&\n          peakPct >= TRAIL_ARM_PCT &&\n          pullbackPct <= -TRAIL_DISTANCE_PCT\n        ) {\n          reason = "trailing_stop";\n        } else if (heldMs >= MAX_HOLD_MS) {\n          reason = "max_hold";\n        }`,
  "split exit decision"
);

replaceOnce(
  `      \`size ${FIXED_SIZE_SOL.toFixed(2)} SOL; score ${MIN_SCORE}+\``,
  `      \`size ${FIXED_SIZE_SOL.toFixed(2)} SOL; score ${MIN_SCORE}+; splitExit=${SPLIT_EXIT_ENABLED} minScore=${SPLIT_MIN_SCORE} trail=${SPLIT_TRAIL_DISTANCE_PCT}%\``,
  "startup split status"
);

fs.writeFileSync(file, source);
console.log("[patch-ai-split-exit] applied: strong score 90+ locks 50% at +10%, trails 50% by 6%; paper-only rollback flag AI_PAPER_SPLIT_EXIT_ENABLED=false");
