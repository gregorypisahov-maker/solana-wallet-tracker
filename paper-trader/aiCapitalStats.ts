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

export async function handleAiCapitalStats(): Promise<string> {
  const supabase = getSupabaseAdmin();
  const [stateResult, positionsResult, tradesResult] = await Promise.all([
    supabase.from("ai_capital_state").select("*").eq("id", 1).maybeSingle(),
    supabase.from("ai_capital_positions").select("*").order("opened_at", { ascending: true }),
    supabase.from("ai_capital_trades").select("*").order("closed_at", { ascending: true }).limit(1000),
  ]);

  const lookupError = stateResult.error ?? positionsResult.error ?? tradesResult.error;
  if (lookupError) throw new Error(`AI capital stats lookup failed: ${lookupError.message}`);

  const state = stateResult.data;
  const positions = positionsResult.data ?? [];
  const trades = tradesResult.data ?? [];
  const completed = trades.length;
  const wins = trades.filter((trade) => n(trade.pnl_sol) > 0).length;
  const losses = trades.filter((trade) => n(trade.pnl_sol) < 0).length;
  const pnl = trades.reduce((sum, trade) => sum + n(trade.pnl_sol), 0);
  const grossProfit = trades.filter((trade) => n(trade.pnl_sol) > 0).reduce((sum, trade) => sum + n(trade.pnl_sol), 0);
  const grossLoss = Math.abs(trades.filter((trade) => n(trade.pnl_sol) < 0).reduce((sum, trade) => sum + n(trade.pnl_sol), 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const winRate = completed ? (wins / completed) * 100 : 0;

  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const trade of trades) {
    cumulative += n(trade.pnl_sol);
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }

  const openValue = positions.reduce((sum, position) => {
    const entry = n(position.entry_price_usd);
    const current = n(position.last_price_usd, entry);
    const size = n(position.size_sol);
    return sum + (entry > 0 ? size * (current / entry) : size);
  }, 0);
  const cash = n(state?.bankroll_sol);
  const startingBankroll = n(state?.starting_bankroll_sol, 5);
  const equity = cash + openValue;
  const status = state?.enabled && !state?.halted
    ? "🟢 AI capital paper mirror: ACTIVE"
    : `🔴 AI capital mirror: ${escapeHtml(state?.halt_reason ?? "disabled")}`;

  const lines = [
    "🧠💰 <b>AI CAPITAL PAPER STATS</b>",
    "",
    status,
    "Mirrors the existing AI bot at 5× paper size",
    `Starting bankroll: ${startingBankroll.toFixed(3)} SOL`,
    `Position size: <b>1.000 SOL</b>`,
    `Equity: <b>${equity.toFixed(4)} SOL</b>`,
    `Cash: ${cash.toFixed(4)} SOL`,
    `Total PnL: <b>${signedSol(pnl)}</b>`,
    `Today's PnL: <b>${signedSol(n(state?.daily_realized_pnl_sol))}</b>`,
    "",
    `Completed trades: <b>${completed}</b>`,
    `Wins / losses: <b>${wins}W / ${losses}L</b>`,
    `Win rate: <b>${winRate.toFixed(1)}%</b>`,
    `Profit factor: <b>${Number.isFinite(profitFactor) ? profitFactor.toFixed(2) : "∞"}</b>`,
    `Max realized drawdown: ${maxDrawdown.toFixed(4)} SOL`,
    `Open positions: ${positions.length}/1`,
    `Entries today: ${state?.entries_today ?? 0}`,
    `Consecutive losses: ${state?.consecutive_losses ?? 0}/3`,
  ];

  if (positions[0]) {
    const position = positions[0];
    const entry = n(position.entry_price_usd);
    const current = n(position.last_price_usd, entry);
    const currentPct = entry > 0 ? ((current / entry) - 1) * 100 - 1.2 : 0;
    lines.push(
      "",
      `<b>OPEN:</b> ${escapeHtml(position.token_symbol)} — ${n(position.size_sol).toFixed(3)} SOL`,
      `Current estimated net: ${signedPct(currentPct)}`,
    );
  }

  const latest = completed ? trades[trades.length - 1] : null;
  if (latest) {
    lines.push(
      "",
      `Last close: ${escapeHtml(latest.token_symbol)} • ${escapeHtml(String(latest.exit_reason).replaceAll("_", " "))} • ${signedSol(n(latest.pnl_sol), 5)}`,
    );
  }

  lines.push("", "🧪 Paper-only mirror — no real SOL used.");
  return lines.join("\n");
}
