import { getSupabaseAdmin } from "../lib/supabase";

function signedSol(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(3)} SOL`;
}

export async function handleTieredStats(): Promise<string> {
  const supabase = getSupabaseAdmin();
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);

  const [stateResult, positionsResult, tradesResult, entriesTodayResult] = await Promise.all([
    supabase.from("tiered_state").select("*").eq("id", 1).single(),
    supabase.from("tiered_positions").select("position_id"),
    supabase.from("tiered_trades").select("position_id,pnl_sol,sold_pct"),
    supabase.from("tiered_processed_signals").select("id", { count: "exact", head: true }).eq("entered", true).gte("seen_at", dayStart.toISOString()),
  ]);

  const error = stateResult.error ?? positionsResult.error ?? tradesResult.error ?? entriesTodayResult.error;
  if (error) throw new Error(`Tiered stats lookup failed: ${error.message}`);

  const grouped = new Map<string, { pnl: number; soldPct: number }>();
  for (const row of tradesResult.data ?? []) {
    const current = grouped.get(row.position_id) ?? { pnl: 0, soldPct: 0 };
    current.pnl += Number(row.pnl_sol ?? 0);
    current.soldPct += Number(row.sold_pct ?? 0);
    grouped.set(row.position_id, current);
  }
  const completed = [...grouped.values()].filter((row) => row.soldPct >= 0.999);
  const totalPnl = completed.reduce((sum, row) => sum + row.pnl, 0);
  const wins = completed.filter((row) => row.pnl > 0).length;
  const grossProfit = completed.filter((row) => row.pnl > 0).reduce((sum, row) => sum + row.pnl, 0);
  const grossLoss = Math.abs(completed.filter((row) => row.pnl < 0).reduce((sum, row) => sum + row.pnl, 0));
  const state = stateResult.data;

  return [
    "🪜 <b>TIERED ENTRY SHADOW V1</b>",
    "",
    state.halted ? `🔴 HALTED — ${state.halt_reason ?? "unknown"}` : "🟢 Silent paper strategy: ACTIVE",
    `Bankroll (cash): <b>${Number(state.bankroll_sol).toFixed(3)} SOL</b>`,
    `Starting bankroll: ${Number(state.starting_bankroll_sol).toFixed(3)} SOL`,
    `Total PnL: <b>${signedSol(totalPnl)}</b>`,
    "",
    `Completed positions: ${completed.length}`,
    `Win rate: ${completed.length ? ((wins / completed.length) * 100).toFixed(1) : "0.0"}%`,
    `Profit factor: ${grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : "N/A"}`,
    `Open positions: ${(positionsResult.data ?? []).length}/3`,
    `Entries today: ${entriesTodayResult.count ?? 0}`,
    "",
    "First-buy entries from proven wallets with trust 65+.",
    "No per-trade Telegram messages. Paper only.",
  ].join("\n");
}
