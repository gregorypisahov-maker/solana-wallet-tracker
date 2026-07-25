import { getSupabaseAdmin } from "../lib/supabase";

function n(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function signedSol(value: number, digits = 4): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)} SOL`;
}

function signedPct(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export async function handleAiStats(): Promise<string> {
  const supabase = getSupabaseAdmin();
  const [stateResult, positionsResult, tradesResult] = await Promise.all([
    supabase.from("ai_discovery_state").select("*").eq("id", 1).maybeSingle(),
    supabase.from("ai_discovery_positions").select("*").order("opened_at", { ascending: true }),
    supabase.from("ai_discovery_trades").select("*").order("closed_at", { ascending: true }).limit(1000),
  ]);

  const lookupError = stateResult.error ?? positionsResult.error ?? tradesResult.error;
  if (lookupError) throw new Error(`AI discovery stats lookup failed: ${lookupError.message}`);

  const state = stateResult.data;
  const positions = positionsResult.data ?? [];
  const trades = tradesResult.data ?? [];
  const completed = trades.length;
  const wins = trades.filter((trade) => n(trade.pnl_sol) > 0).length;
  const losses = trades.filter((trade) => n(trade.pnl_sol) < 0).length;
  const breakeven = completed - wins - losses;
  const pnl = trades.reduce((sum, trade) => sum + n(trade.pnl_sol), 0);
  const grossProfit = trades.filter((trade) => n(trade.pnl_sol) > 0).reduce((sum, trade) => sum + n(trade.pnl_sol), 0);
  const grossLoss = Math.abs(trades.filter((trade) => n(trade.pnl_sol) < 0).reduce((sum, trade) => sum + n(trade.pnl_sol), 0));
  const averageWin = wins ? grossProfit / wins : 0;
  const averageLoss = losses ? grossLoss / losses : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const trade of trades) {
    cumulative += n(trade.pnl_sol);
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }

  const exitCounts = trades.reduce<Record<string, number>>((counts, trade) => {
    const reason = String(trade.exit_reason ?? "unknown");
    counts[reason] = (counts[reason] ?? 0) + 1;
    return counts;
  }, {});

  const openValue = positions.reduce((sum, position) => {
    const entry = n(position.entry_price_usd);
    const current = n(position.last_price_usd, entry);
    const size = n(position.size_sol);
    return sum + (entry > 0 ? size * (current / entry) : size);
  }, 0);
  const reservedCapital = positions.reduce((sum, position) => sum + n(position.size_sol), 0);
  const startingBankroll = n(state?.starting_bankroll_sol, 1);
  const cash = n(state?.bankroll_sol);
  const equity = cash + openValue;
  const expectedCash = startingBankroll + pnl - reservedCapital;
  const accountingDelta = cash - expectedCash;
  const accountingHealthy = Math.abs(accountingDelta) < 0.00001;
  const winRate = completed ? (wins / completed) * 100 : 0;
  const sampleReady = completed >= 200;
  const edgeReady = profitFactor >= 1.3 && winRate >= 45;
  const drawdownReady = maxDrawdown <= Math.max(0.1, Math.abs(pnl) * 0.75);
  const sizeRecommendation = sampleReady && edgeReady && drawdownReady
    ? "🟢 Conditions support testing 0.250 SOL in paper mode"
    : "🟡 Keep 0.200 SOL until all conditions pass";

  const latest = completed ? trades[trades.length - 1] : null;
  const status = state?.enabled && !state?.halted
    ? "🟢 AI discovery paper trader: ACTIVE"
    : `🔴 AI discovery: ${escapeHtml(state?.halt_reason ?? "disabled")}`;

  const lines = [
    "🧠⚡ <b>AI DISCOVERY PAPER STATS</b>",
    "",
    status,
    `Starting bankroll: ${startingBankroll.toFixed(4)} SOL`,
    `Equity: <b>${equity.toFixed(4)} SOL</b>`,
    `Cash: ${cash.toFixed(4)} SOL`,
    `Total PnL: <b>${signedSol(pnl)}</b>`,
    accountingHealthy
      ? "Accounting check: ✅ balanced"
      : `Accounting check: ⚠️ mismatch ${signedSol(accountingDelta, 5)}`,
    "",
    `Completed trades: <b>${completed}</b>`,
    `Wins / losses: <b>${wins}W / ${losses}L</b>${breakeven ? ` / ${breakeven} flat` : ""}`,
    `Win rate: <b>${winRate.toFixed(1)}%</b>`,
    `Profit factor: <b>${Number.isFinite(profitFactor) ? profitFactor.toFixed(2) : "∞"}</b>`,
    `Average winner: ${signedSol(averageWin, 5)}`,
    `Average loser: -${averageLoss.toFixed(5)} SOL`,
    `Max realized drawdown: ${maxDrawdown.toFixed(4)} SOL`,
    `Open positions: ${positions.length}/1`,
    `Entries today: ${state?.entries_today ?? 0}`,
    `Consecutive losses: ${state?.consecutive_losses ?? 0}/3`,
    "",
    "<b>Exit reasons</b>",
    `Take profit: ${exitCounts.take_profit ?? 0}`,
    `Trailing stop: ${exitCounts.trailing_stop ?? 0}`,
    `Hard stop: ${exitCounts.hard_stop ?? 0}`,
    `Max hold: ${(exitCounts.max_hold ?? 0) + (exitCounts.max_hold_price_unavailable ?? 0)}`,
    "",
    "<b>Position-size check</b>",
    `${sampleReady ? "✅" : "❌"} At least 200 completed trades (${completed}/200)`,
    `${profitFactor >= 1.3 ? "✅" : "❌"} Profit factor at least 1.30`,
    `${winRate >= 45 ? "✅" : "❌"} Win rate at least 45%`,
    `${drawdownReady ? "✅" : "❌"} Drawdown within current safety threshold`,
    `<b>${sizeRecommendation}</b>`,
  ];

  if (positions[0]) {
    const position = positions[0];
    const entry = n(position.entry_price_usd);
    const current = n(position.last_price_usd, entry);
    const currentPct = entry > 0 ? ((current / entry) - 1) * 100 - 1.2 : 0;
    lines.push("", `<b>OPEN:</b> ${escapeHtml(position.token_symbol)} — ${n(position.size_sol).toFixed(3)} SOL`, `Current net: ${signedPct(currentPct)}`);
  }

  if (latest) {
    lines.push("", `Last close: ${escapeHtml(latest.token_symbol)} • ${escapeHtml(String(latest.exit_reason).replaceAll("_", " "))} • ${signedSol(n(latest.pnl_sol), 5)}`);
  }

  lines.push("", "🧪 Paper only — no real SOL used.");
  return lines.join("\n");
}
