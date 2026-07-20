import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { hasViewerAccess, unauthorized } from "@/lib/dashboardAuth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

type TradeRow = Record<string, any>;

function summarize(rows: TradeRow[], pnlKey: string, timeKey: string) {
  const trades = rows.map((row) => ({
    ...row,
    pnl: Number(row[pnlKey] ?? 0),
    happenedAt: row[timeKey] ?? null,
  }));
  const wins = trades.filter((row) => row.pnl > 0).length;
  const losses = trades.filter((row) => row.pnl < 0).length;
  const grossProfit = trades.filter((row) => row.pnl > 0).reduce((sum, row) => sum + row.pnl, 0);
  const grossLoss = Math.abs(trades.filter((row) => row.pnl < 0).reduce((sum, row) => sum + row.pnl, 0));
  const totalPnlSol = trades.reduce((sum, row) => sum + row.pnl, 0);
  return {
    completedTrades: trades.length,
    wins,
    losses,
    winRate: trades.length ? wins / trades.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    totalPnlSol,
    recentTrades: trades.slice(0, 6),
  };
}

function summarizeRegular(rows: TradeRow[]) {
  const grouped = new Map<string, { pnl: number; soldPct: number; row: TradeRow }>();
  for (const row of rows) {
    const key = row.position_id ?? `${row.mint}:${row.entry_price}`;
    const current = grouped.get(key) ?? { pnl: 0, soldPct: 0, row };
    current.pnl += Number(row.pnl_sol ?? 0);
    current.soldPct += Number(row.sold_pct ?? 0);
    current.row = row;
    grouped.set(key, current);
  }
  const completed = [...grouped.values()]
    .filter((item) => item.soldPct >= 0.999)
    .map((item) => ({ ...item.row, pnl_sol: item.pnl }));
  return summarize(completed, "pnl_sol", "happened_at");
}

export async function GET(request: NextRequest) {
  if (!hasViewerAccess(request)) return unauthorized();
  const supabase = getSupabaseAdmin({ noStore: true });

  const [paperState, paperPositions, paperTrades, scalpState, scalpPositions, scalpTrades, shadowState, shadowPositions, shadowTrades] = await Promise.all([
    supabase.from("paper_state").select("*").eq("id", 1).maybeSingle(),
    supabase.from("paper_positions").select("*").order("entry_time", { ascending: false }),
    supabase.from("paper_trades").select("*").order("happened_at", { ascending: false }).limit(1000),
    supabase.from("scalp_state").select("*").eq("id", 1).maybeSingle(),
    supabase.from("scalp_positions").select("*").order("entry_time", { ascending: false }),
    supabase.from("scalp_trades").select("*").order("closed_at", { ascending: false }).limit(500),
    supabase.from("shadow_strategy_state").select("*").eq("id", 1).maybeSingle(),
    supabase.from("shadow_positions").select("*").order("entry_time", { ascending: false }),
    supabase.from("shadow_trades").select("*").order("happened_at", { ascending: false }).limit(500),
  ]);

  const results = { paperState, paperPositions, paperTrades, scalpState, scalpPositions, scalpTrades, shadowState, shadowPositions, shadowTrades };
  const failed = Object.entries(results).find(([, result]) => result.error);
  if (failed) {
    console.error(`[compact-dashboard] ${failed[0]} query failed`, failed[1].error);
    return NextResponse.json({ error: "Dashboard data is temporarily unavailable" }, { status: 500 });
  }

  const legion = summarizeRegular(paperTrades.data ?? []);
  const scalper = summarize(scalpTrades.data ?? [], "pnl_sol", "closed_at");
  const shadow = summarize(shadowTrades.data ?? [], "pnl_sol", "happened_at");

  const bots = [
    {
      id: "legion",
      name: "Legion Bot",
      subtitle: "Wallet consensus strategy",
      state: paperState.data,
      openPositions: (paperPositions.data ?? []).length,
      ...legion,
    },
    {
      id: "scalper",
      name: "Scalper Bot",
      subtitle: "Momentum v6",
      state: scalpState.data,
      openPositions: (scalpPositions.data ?? []).length,
      ...scalper,
    },
    {
      id: "shadow",
      name: "Shadow Bot",
      subtitle: "Research strategy",
      state: shadowState.data,
      openPositions: (shadowPositions.data ?? []).length,
      ...shadow,
    },
  ];

  const allRecent = bots
    .flatMap((bot) => bot.recentTrades.map((trade: any) => ({ ...trade, botId: bot.id, botName: bot.name })))
    .sort((a, b) => Date.parse(b.happenedAt ?? 0) - Date.parse(a.happenedAt ?? 0))
    .slice(0, 8);

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    bots,
    overview: {
      totalPnlSol: bots.reduce((sum, bot) => sum + bot.totalPnlSol, 0),
      completedTrades: bots.reduce((sum, bot) => sum + bot.completedTrades, 0),
      wins: bots.reduce((sum, bot) => sum + bot.wins, 0),
      losses: bots.reduce((sum, bot) => sum + bot.losses, 0),
      openPositions: bots.reduce((sum, bot) => sum + bot.openPositions, 0),
    },
    recentActivity: allRecent,
  });
}
