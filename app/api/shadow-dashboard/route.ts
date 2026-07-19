import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { hasViewerAccess, unauthorized } from "@/lib/dashboardAuth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export async function GET(request: NextRequest) {
  if (!hasViewerAccess(request)) return unauthorized();

  const supabase = getSupabaseAdmin({ noStore: true });
  const [state, positions, trades] = await Promise.all([
    supabase.from("shadow_strategy_state").select("*").eq("id", 1).maybeSingle(),
    supabase.from("shadow_positions").select("*").order("entry_time", { ascending: false }),
    supabase.from("shadow_trades").select("*").order("happened_at", { ascending: false }).limit(500),
  ]);

  const failed = [state, positions, trades].find((result) => result.error);
  if (failed?.error) {
    console.error("[shadow-dashboard] query failed", failed.error);
    return NextResponse.json({ error: "Shadow strategy data is temporarily unavailable" }, { status: 500 });
  }

  const tradeRows = trades.data ?? [];
  const positionRows = positions.data ?? [];
  const wins = tradeRows.filter((trade) => Number(trade.pnl_sol) > 0);
  const grossProfit = wins.reduce((sum, trade) => sum + Number(trade.pnl_sol), 0);
  const grossLoss = Math.abs(
    tradeRows
      .filter((trade) => Number(trade.pnl_sol) < 0)
      .reduce((sum, trade) => sum + Number(trade.pnl_sol), 0)
  );
  const totalPnlSol = tradeRows.reduce(
    (sum, trade) => sum + Number(trade.pnl_sol),
    0
  );
  const cashSol = Number(state.data?.bankroll_sol ?? 0);
  const startingBankrollSol = Number(state.data?.starting_bankroll_sol ?? 0);
  const openPositionValueSol = positionRows.reduce(
    (sum, position) =>
      sum + Number(position.size_sol) * Number(position.remaining_pct ?? 1),
    0
  );

  return NextResponse.json(
    {
      generatedAt: new Date().toISOString(),
      state: state.data,
      positions: positionRows,
      trades: tradeRows.slice(0, 10),
      summary: {
        enabled: Boolean(state.data?.enabled),
        cashSol: Number.isFinite(cashSol) ? cashSol : 0,
        startingBankrollSol: Number.isFinite(startingBankrollSol)
          ? startingBankrollSol
          : 0,
        openPositionValueSol,
        equitySol: (Number.isFinite(cashSol) ? cashSol : 0) + openPositionValueSol,
        totalPnlSol,
        returnPct:
          startingBankrollSol > 0 ? (totalPnlSol / startingBankrollSol) * 100 : 0,
        completedTrades: tradeRows.length,
        openPositions: positionRows.length,
        wins: wins.length,
        losses: tradeRows.length - wins.length,
        winRate: tradeRows.length ? wins.length / tradeRows.length : 0,
        profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
      },
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
