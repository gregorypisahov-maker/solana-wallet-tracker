import fs from "node:fs";
import path from "node:path";

const file = path.resolve(process.cwd(), "paper-trader/aiDiscoveryTrader.ts");
let source = fs.readFileSync(file, "utf8");
const marker = "ai_discovery_trader_v2_split_exit_2026_07_29";
const L = (...lines) => lines.join("\n");

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
  L("const TRAIL_DISTANCE_PCT = 4;", "const MAX_HOLD_MS = 45 * 60_000;"),
  L(
    "const TRAIL_DISTANCE_PCT = 4;",
    'const SPLIT_EXIT_ENABLED = process.env.AI_PAPER_SPLIT_EXIT_ENABLED !== "false";',
    "const SPLIT_MIN_SCORE = Math.max(82, Number(process.env.AI_PAPER_SPLIT_MIN_SCORE) || 90);",
    "const SPLIT_PARTIAL_FRACTION = 0.5;",
    "const SPLIT_TRAIL_DISTANCE_PCT = Math.max(4, Number(process.env.AI_PAPER_SPLIT_TRAIL_PCT) || 6);",
    "const MAX_HOLD_MS = 45 * 60_000;"
  ),
  "split constants"
);

replaceOnce(
  L("  size_sol: number | string;", "  token_amount: string | null;"),
  L(
    "  size_sol: number | string;",
    "  original_size_sol: number | string | null;",
    "  remaining_cost_sol: number | string | null;",
    "  remaining_fraction: number | string | null;",
    "  partial_tp_taken: boolean | null;",
    "  partial_tp_price_usd: number | string | null;",
    "  partial_tp_proceeds_sol: number | string | null;",
    "  partial_tp_pnl_sol: number | string | null;",
    "  partial_tp_at: string | null;",
    "  token_amount: string | null;"
  ),
  "position fields"
);

replaceOnce(
  L("    size_sol: sizeSol,", "    token_amount: entryQuote.tokenAmount,"),
  L(
    "    size_sol: sizeSol,",
    "    original_size_sol: sizeSol,",
    "    remaining_cost_sol: sizeSol,",
    "    remaining_fraction: 1,",
    "    partial_tp_taken: false,",
    "    partial_tp_proceeds_sol: 0,",
    "    partial_tp_pnl_sol: 0,",
    "    token_amount: entryQuote.tokenAmount,"
  ),
  "open position split fields"
);

replaceOnce(
  L(
    "async function syncPositionTokenAmount(",
    "  position: Position,",
    "  mirror: LiveMirror | null",
    "): Promise<string | null> {",
    "  if (mirror?.token_amount && mirror.token_amount !== position.token_amount) {",
    "    await supabase",
    '      .from("ai_discovery_positions")',
    "      .update({ token_amount: mirror.token_amount, updated_at: new Date().toISOString() })",
    '      .eq("position_id", position.position_id);',
    "    position.token_amount = mirror.token_amount;",
    "  }",
    "  return position.token_amount;",
    "}"
  ),
  L(
    "async function syncPositionTokenAmount(",
    "  position: Position,",
    "  mirror: LiveMirror | null",
    "): Promise<string | null> {",
    "  // Once the paper-only split exit has happened, never copy the full live token",
    "  // balance back into the half-sized paper remainder.",
    "  if (!position.partial_tp_taken && mirror?.token_amount && mirror.token_amount !== position.token_amount) {",
    "    await supabase",
    '      .from("ai_discovery_positions")',
    "      .update({ token_amount: mirror.token_amount, updated_at: new Date().toISOString() })",
    '      .eq("position_id", position.position_id);',
    "    position.token_amount = mirror.token_amount;",
    "  }",
    "  return position.token_amount;",
    "}"
  ),
  "live token sync isolation"
);

replaceOnce(
  L(
    "async function quoteExitValuation(",
    "  position: Position,",
    "  mirror: LiveMirror | null",
    "): Promise<ExitValuation> {",
    "  const entryValueSol = Math.max(0, n(mirror?.spent_sol, n(position.size_sol)));",
    "  const tokenAmount = await syncPositionTokenAmount(position, mirror);"
  ),
  L(
    "async function quoteExitValuation(",
    "  position: Position,",
    "  mirror: LiveMirror | null,",
    "  options?: { tokenAmount?: string; entryValueSol?: number; ignoreLiveMirror?: boolean }",
    "): Promise<ExitValuation> {",
    "  const paperEntryValue = n(position.remaining_cost_sol, n(position.size_sol));",
    "  const mirrorEntryValue = options?.ignoreLiveMirror || position.partial_tp_taken",
    "    ? paperEntryValue",
    "    : n(mirror?.spent_sol, paperEntryValue);",
    "  const entryValueSol = Math.max(0, options?.entryValueSol ?? mirrorEntryValue);",
    "  const tokenAmount = options?.tokenAmount ?? await syncPositionTokenAmount(position, mirror);"
  ),
  "quote override support"
);

const helperCode = L(
  "function entryScore(position: Position): number {",
  "  return n((position.entry_snapshot as any)?.opportunity?.score);",
  "}",
  "",
  "async function currentMomentumM5(position: Position): Promise<number> {",
  "  const { data, error } = await supabase",
  '    .from("market_opportunities")',
  '    .select("price_change_m5")',
  '    .eq("mint", position.mint)',
  "    .maybeSingle();",
  "  if (error) {",
  "    console.warn(`[ai-discovery-trader] split momentum unavailable for ${position.token_symbol}: ${error.message}`);",
  "    return 0;",
  "  }",
  "  return n(data?.price_change_m5);",
  "}",
  "",
  "async function takePartialProfit(position: Position, peakPriceUsd: number): Promise<boolean> {",
  "  const raw = position.token_amount;",
  "  if (!raw || !/^\\d+$/.test(raw)) return false;",
  "  const totalRaw = BigInt(raw);",
  "  const soldRaw = totalRaw / 2n;",
  "  const remainingRaw = totalRaw - soldRaw;",
  "  if (soldRaw <= 0n || remainingRaw <= 0n) return false;",
  "",
  "  const originalSize = n(position.original_size_sol, n(position.size_sol));",
  "  const partialCost = originalSize * SPLIT_PARTIAL_FRACTION;",
  "  const valuation = await quoteExitValuation(position, null, {",
  "    tokenAmount: soldRaw.toString(),",
  "    entryValueSol: partialCost,",
  "    ignoreLiveMirror: true,",
  "  });",
  "  if (valuation.quoteCallFailed || !valuation.route) return false;",
  "",
  "  const partialProceeds = Math.max(0, valuation.proceedsSol);",
  "  const partialPnl = partialProceeds - partialCost;",
  "  const partialNetPct = partialCost > 0 ? (partialPnl / partialCost) * 100 : 0;",
  '  const { data, error } = await supabase.rpc("apply_ai_discovery_partial_tp", {',
  "    p_position_id: position.position_id,",
  "    p_remaining_token_amount: remainingRaw.toString(),",
  "    p_partial_price_usd: valuation.impliedPriceUsd,",
  "    p_partial_proceeds_sol: partialProceeds,",
  "    p_partial_pnl_sol: partialPnl,",
  "    p_remaining_cost_sol: originalSize * (1 - SPLIT_PARTIAL_FRACTION),",
  "    p_peak_price_usd: peakPriceUsd,",
  "    p_last_executable_value_sol: valuation.executableSol,",
  "  });",
  "  if (error) throw new Error(error.message);",
  "  if (data !== true) return false;",
  "",
  "  await sendTelegramAlert([",
  '    "✅ <b>AI DISCOVERY PAPER PROFIT LOCKED</b>",',
  '    "",',
  "    `Token: <b>${position.token_symbol}</b>`,",
  '    "Sold: <b>50%</b>",',
  "    `Locked net: <b>${partialNetPct >= 0 ? \"+\" : \"\"}${partialNetPct.toFixed(2)}%</b>`,",
  "    `Locked PnL: <b>${partialPnl >= 0 ? \"+\" : \"\"}${partialPnl.toFixed(5)} SOL</b>`,",
  "    `Remainder: <b>50% trailing ${SPLIT_TRAIL_DISTANCE_PCT.toFixed(0)}% from peak</b>`,",
  '    "",',
  '    "🧪 Paper only — live execution exits fully at the first take-profit.",',
  '  ].join("\\n"));',
  "  return true;",
  "}",
  "",
  "async function closeTrade(",
  "  position: Position,"
);

replaceOnce(
  L("async function closeTrade(", "  position: Position,"),
  helperCode,
  "partial take-profit helpers"
);

replaceOnce(
  L(
    "  const sizeSol = n(position.size_sol);",
    "  const proceeds = Math.max(0, valuation.proceedsSol);",
    "  const pnlSol = proceeds - sizeSol;",
    "  const grossPct = sizeSol > 0 ? ((valuation.executableSol / sizeSol) - 1) * 100 : -100;",
    "  const netPct = sizeSol > 0 ? (pnlSol / sizeSol) * 100 : -100;"
  ),
  L(
    "  const partialTaken = Boolean(position.partial_tp_taken);",
    "  const sizeSol = n(position.original_size_sol, n(position.size_sol));",
    "  const remainingCost = n(position.remaining_cost_sol, sizeSol);",
    "  const lockedProceeds = n(position.partial_tp_proceeds_sol);",
    "  const lockedPnl = n(position.partial_tp_pnl_sol);",
    "  const finalProceeds = Math.max(0, valuation.proceedsSol);",
    "  const finalPnl = finalProceeds - remainingCost;",
    "  const proceeds = lockedProceeds + finalProceeds;",
    "  const pnlSol = proceeds - sizeSol;",
    "  const grossPct = sizeSol > 0 ? ((proceeds / sizeSol) - 1) * 100 : -100;",
    "  const netPct = sizeSol > 0 ? (pnlSol / sizeSol) * 100 : -100;"
  ),
  "combined split accounting"
);

replaceOnce(
  "    execution_source: valuation.source,",
  '    execution_source: partialTaken ? "quote_split" : valuation.source,',
  "split execution source"
);

replaceOnce(
  L("      peakPriceUsd: n(position.peak_price_usd),", "    },"),
  L(
    "      peakPriceUsd: n(position.peak_price_usd),",
    "      splitExit: {",
    "        enabled: SPLIT_EXIT_ENABLED,",
    "        partialTaken,",
    "        partialFraction: partialTaken ? SPLIT_PARTIAL_FRACTION : 0,",
    "        partialPriceUsd: n(position.partial_tp_price_usd),",
    "        partialProceedsSol: lockedProceeds,",
    "        partialPnlSol: lockedPnl,",
    "        partialTakenAt: position.partial_tp_at ?? null,",
    "        finalProceedsSol: finalProceeds,",
    "        trailDistancePct: partialTaken ? SPLIT_TRAIL_DISTANCE_PCT : null,",
    "      },",
    "    },"
  ),
  "split exit snapshot"
);

replaceOnce(
  L(
    "      bankroll_sol: n(state.bankroll_sol) + proceeds,",
    "      daily_realized_pnl_sol: n(state.daily_realized_pnl_sol) + pnlSol,"
  ),
  L(
    "      // The first half was already credited atomically when profit was locked.",
    "      bankroll_sol: n(state.bankroll_sol) + finalProceeds,",
    "      daily_realized_pnl_sol: n(state.daily_realized_pnl_sol) + finalPnl,"
  ),
  "final-leg state accounting"
);

replaceOnce(
  '    if (!trade || trade.execution_source === "live_mirror") continue;',
  L(
    "    if (",
    "      !trade ||",
    '      trade.execution_source === "live_mirror" ||',
    '      trade.execution_source === "quote_split" ||',
    "      Boolean(trade.exit_snapshot?.splitExit?.partialTaken)",
    "    ) continue;"
  ),
  "live mirror split isolation"
);

replaceOnce(
  L(
    "        let reason: string | null = null;",
    '        if (grossPct <= HARD_STOP_PCT) reason = "hard_stop";',
    '        else if (grossPct >= TAKE_PROFIT_PCT) reason = "take_profit";',
    "        else if (",
    "          peakPct >= TRAIL_ARM_PCT &&",
    "          pullbackPct <= -TRAIL_DISTANCE_PCT",
    "        ) {",
    '          reason = "trailing_stop";',
    "        } else if (heldMs >= MAX_HOLD_MS) {",
    '          reason = "max_hold";',
    "        }"
  ),
  L(
    "        const partialTaken = Boolean(position.partial_tp_taken);",
    "        let reason: string | null = null;",
    "        if (grossPct <= HARD_STOP_PCT) {",
    '          reason = "hard_stop";',
    "        } else if (!partialTaken && grossPct >= TAKE_PROFIT_PCT) {",
    "          const strongEnough = SPLIT_EXIT_ENABLED && entryScore(position) >= SPLIT_MIN_SCORE;",
    "          const momentumM5 = strongEnough ? await currentMomentumM5(position) : 0;",
    "          if (strongEnough && momentumM5 > 0) {",
    "            const partialDone = await takePartialProfit(position, peak);",
    "            if (partialDone) continue;",
    "          }",
    "          // If the split quote cannot execute, preserve the original safe full exit.",
    '          reason = "take_profit";',
    "        } else if (",
    "          partialTaken &&",
    "          peakPct >= TAKE_PROFIT_PCT &&",
    "          pullbackPct <= -SPLIT_TRAIL_DISTANCE_PCT",
    "        ) {",
    '          reason = "trailing_stop";',
    "        } else if (",
    "          !partialTaken &&",
    "          peakPct >= TRAIL_ARM_PCT &&",
    "          pullbackPct <= -TRAIL_DISTANCE_PCT",
    "        ) {",
    '          reason = "trailing_stop";',
    "        } else if (heldMs >= MAX_HOLD_MS) {",
    '          reason = "max_hold";',
    "        }"
  ),
  "split exit decision"
);

replaceOnce(
  "      `size ${FIXED_SIZE_SOL.toFixed(2)} SOL; score ${MIN_SCORE}+`",
  "      `size ${FIXED_SIZE_SOL.toFixed(2)} SOL; score ${MIN_SCORE}+; splitExit=${SPLIT_EXIT_ENABLED} minScore=${SPLIT_MIN_SCORE} trail=${SPLIT_TRAIL_DISTANCE_PCT}%`",
  "startup split status"
);

fs.writeFileSync(file, source);
console.log("[patch-ai-split-exit] applied: strong score 90+ locks 50% at +10%, trails 50% by 6%; paper-only rollback flag AI_PAPER_SPLIT_EXIT_ENABLED=false");
