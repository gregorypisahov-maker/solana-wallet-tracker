import { getSupabaseAdmin } from "../lib/supabase";

const supabase = getSupabaseAdmin();
const MODEL_VERSION = "autopsy_v1_2026_07_26";
let running = false;

function n(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function pctChange(current: number, previous: number): number | null {
  if (!(previous > 0)) return null;
  return ((current / previous) - 1) * 100;
}

function round(value: number | null, digits = 2): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function analyze(trade: any) {
  const entry = trade.entry_snapshot ?? {};
  const exit = trade.exit_snapshot ?? {};
  const opportunity = entry.opportunity ?? {};
  const entryMarket = entry.market ?? {};
  const exitMarket = exit.market ?? {};

  const entryPrice = n(trade.entry_price_usd);
  const exitPrice = n(trade.exit_price_usd);
  const peakPrice = n(exit.peakPriceUsd, Math.max(entryPrice, exitPrice));
  const entryLiquidity = n(entryMarket.liquidityUsd, n(opportunity.liquidity_usd));
  const exitLiquidity = n(exitMarket.liquidityUsd);
  const entryMomentum = n(entryMarket.changeM5, n(opportunity.price_change_m5));
  const exitMomentum = n(exitMarket.changeM5);
  const netPct = n(trade.net_return_pct);
  const peakReturnPct = entryPrice > 0 ? ((peakPrice / entryPrice) - 1) * 100 : 0;
  const givebackPct = peakPrice > 0 ? ((exitPrice / peakPrice) - 1) * 100 : 0;
  const liquidityChangePct = pctChange(exitLiquidity, entryLiquidity);
  const heldSeconds = Math.max(0, Math.round((Date.parse(trade.closed_at) - Date.parse(trade.opened_at)) / 1000));

  const positives: string[] = [];
  const negatives: string[] = [];
  if (n(opportunity.score) >= 88) positives.push("high_entry_score");
  if (entryLiquidity >= 100_000) positives.push("healthy_entry_liquidity");
  if (entryMomentum > 0) positives.push("positive_entry_momentum");
  if ((opportunity.reasons ?? []).includes("positive_buy_pressure")) positives.push("positive_buy_pressure");
  if ((opportunity.reasons ?? []).includes("rising_short_term_volume")) positives.push("rising_short_term_volume");

  if (exitMomentum <= -5) negatives.push("momentum_reversed_sharply");
  else if (exitMomentum < 0) negatives.push("momentum_turned_negative");
  if (liquidityChangePct != null && liquidityChangePct <= -10) negatives.push("liquidity_deteriorated");
  if (givebackPct <= -6) negatives.push("large_giveback_from_peak");
  if (heldSeconds <= 360 && netPct <= -6) negatives.push("failed_immediately_after_entry");
  if (trade.exit_reason === "hard_stop" && netPct < -8) negatives.push("stop_overshoot_or_fast_move");

  let verdict = "normal_strategy_variance";
  let preventable = false;
  let estimatedBetterExitPct: number | null = null;
  let confidence = 64;

  if (trade.exit_reason === "hard_stop" && heldSeconds <= 360) {
    verdict = "fast_momentum_failure";
    preventable = exitMomentum < 0;
    estimatedBetterExitPct = preventable ? Math.max(-6, netPct + 4) : null;
    confidence = preventable ? 78 : 70;
  } else if (givebackPct <= -6 && peakReturnPct > 1) {
    verdict = "profit_giveback";
    preventable = true;
    estimatedBetterExitPct = Math.max(0, peakReturnPct - 3);
    confidence = 82;
  } else if (liquidityChangePct != null && liquidityChangePct <= -15) {
    verdict = "liquidity_deterioration";
    preventable = true;
    estimatedBetterExitPct = Math.max(-5, netPct + 3);
    confidence = 80;
  } else if (netPct > 0) {
    verdict = "successful_exit";
    confidence = 85;
  }

  const explanationParts = [
    `Held ${Math.round(heldSeconds / 60)} minute(s) and closed via ${String(trade.exit_reason).replaceAll("_", " ")}.`,
    `Net result ${netPct >= 0 ? "+" : ""}${netPct.toFixed(2)}%.`,
    `Entry score ${n(opportunity.score, 0).toFixed(0)} with $${Math.round(entryLiquidity).toLocaleString()} liquidity.`,
  ];
  if (exitMomentum !== 0) explanationParts.push(`Exit 5m momentum was ${exitMomentum.toFixed(2)}%.`);
  if (liquidityChangePct != null) explanationParts.push(`Liquidity changed ${liquidityChangePct >= 0 ? "+" : ""}${liquidityChangePct.toFixed(1)}%.`);
  if (preventable) explanationParts.push("The autopsy found evidence that a deterioration exit could potentially have reduced the loss; this must be validated across many trades before changing rules.");
  else explanationParts.push("No reliable earlier-exit signal was proven from the stored snapshots alone.");

  return {
    trade_id: trade.id,
    position_id: trade.position_id,
    mint: trade.mint,
    token_symbol: trade.token_symbol,
    exit_reason: trade.exit_reason,
    net_return_pct: netPct,
    pnl_sol: n(trade.pnl_sol),
    held_seconds: heldSeconds,
    entry_score: n(opportunity.score, null as any),
    entry_liquidity_usd: round(entryLiquidity),
    exit_liquidity_usd: round(exitLiquidity),
    liquidity_change_pct: round(liquidityChangePct),
    entry_momentum_m5: round(entryMomentum),
    exit_momentum_m5: round(exitMomentum),
    peak_return_pct: round(peakReturnPct),
    giveback_from_peak_pct: round(givebackPct),
    verdict,
    preventable,
    estimated_better_exit_pct: round(estimatedBetterExitPct),
    confidence,
    positive_signals: positives,
    negative_signals: negatives,
    explanation: explanationParts.join(" "),
    model_version: MODEL_VERSION,
    updated_at: new Date().toISOString(),
  };
}

export async function runAiTradeAutopsies(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const { data: trades, error } = await supabase
      .from("ai_discovery_trades")
      .select("*")
      .order("closed_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    if (!trades?.length) return;

    const ids = trades.map((trade: any) => trade.id);
    const { data: existing, error: existingError } = await supabase
      .from("ai_trade_autopsies")
      .select("trade_id")
      .in("trade_id", ids);
    if (existingError) throw new Error(existingError.message);
    const done = new Set((existing ?? []).map((row: any) => row.trade_id));
    const pending = trades.filter((trade: any) => !done.has(trade.id));
    if (!pending.length) return;

    const reports = pending.map(analyze);
    const { error: insertError } = await supabase.from("ai_trade_autopsies").upsert(reports, { onConflict: "trade_id" });
    if (insertError) throw new Error(insertError.message);
    console.log(`[ai-trade-autopsy] generated ${reports.length} report(s)`);
  } finally {
    running = false;
  }
}

export function startAiTradeAutopsyEngine(): void {
  console.log(`[ai-trade-autopsy] ${MODEL_VERSION} enabled`);
  void runAiTradeAutopsies().catch((error) => console.error("[ai-trade-autopsy] initial run failed", error));
  setInterval(() => void runAiTradeAutopsies().catch((error) => console.error("[ai-trade-autopsy] run failed", error)), 60_000);
}
