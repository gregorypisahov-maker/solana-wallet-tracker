import { getSupabaseAdmin } from "../lib/supabase";

function n(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function signedSol(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(3)} SOL`;
}

export async function handleTieredStats(): Promise<string> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("tiered_ledger_snapshot");
  if (error) throw new Error(`Tiered ledger lookup failed: ${error.message}`);

  const snapshot = data ?? {};
  const completed = n(snapshot.completed_positions);
  const wins = n(snapshot.wins);
  const winRate = completed > 0 ? (wins / completed) * 100 : 0;
  const profitFactor = snapshot.profit_factor == null ? "N/A" : n(snapshot.profit_factor).toFixed(2);
  const discrepancy = n(snapshot.accounting_discrepancy_sol);
  const accountingLine = snapshot.accounting_ok
    ? "✅ Accounting: ledger and state agree"
    : `🔴 Accounting mismatch: ${signedSol(discrepancy)}`;

  return [
    "🪜 <b>TIERED ENTRY SHADOW V3</b>",
    "",
    snapshot.halted
      ? `🔴 HALTED — ${snapshot.halt_reason ?? "unknown"}`
      : "🟢 Silent paper strategy: ACTIVE",
    `Cash (ledger): <b>${n(snapshot.expected_cash_sol).toFixed(3)} SOL</b>`,
    `State cash: ${n(snapshot.reported_cash_sol).toFixed(3)} SOL`,
    `Open-position cost: ${n(snapshot.open_position_cost_sol).toFixed(3)} SOL`,
    `Equity at cost: <b>${n(snapshot.equity_at_cost_sol).toFixed(3)} SOL</b>`,
    accountingLine,
    "",
    `Realized PnL: <b>${signedSol(n(snapshot.total_realized_pnl_sol))}</b>`,
    `Today realized: ${signedSol(n(snapshot.daily_realized_pnl_sol))}`,
    `Completed positions: ${completed}`,
    `Win rate: ${winRate.toFixed(1)}% (${wins}W / ${n(snapshot.losses)}L)`,
    `Profit factor: ${profitFactor}`,
    `Open positions: ${n(snapshot.open_positions)}/3`,
    "",
    `Recorded entries today: ${n(snapshot.entries_today)}`,
    `Risk entry counter: ${n(snapshot.risk_entries_today)}/12`,
    `Consecutive hard stops: ${n(snapshot.consecutive_hard_stops)}/3`,
    "",
    "Entry rules: proven wallet trust 65+, two-price confirmation, fresh same-pair liquidity.",
    "Circuit breakers: 12 entries/day, -0.20 SOL daily risk loss, or 3 consecutive hard stops.",
    "No per-trade Telegram messages. Paper only.",
  ].join("\n");
}

export async function handleResumeTiered(): Promise<string> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("tiered_resume");
  if (error) throw new Error(`Tiered resume failed: ${error.message}`);
  if (!data?.resumed) throw new Error("Tiered resume did not complete");

  return [
    "▶️ <b>TIERED SHADOW RESUMED</b>",
    "",
    `Cash: ${n(data.bankroll_sol).toFixed(3)} SOL`,
    "New entries: ENABLED",
    "Entry counter and circuit-breaker counters: RESET",
    "Trust floor: 65+",
  ].join("\n");
}
