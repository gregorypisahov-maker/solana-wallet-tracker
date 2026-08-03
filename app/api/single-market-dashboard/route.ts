import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { hasViewerAccess, unauthorized } from "@/lib/dashboardAuth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export async function GET(request: NextRequest) {
  if (!hasViewerAccess(request)) return unauthorized();
  const supabase = getSupabaseAdmin({ noStore: true });

  const [stateResult, tradesResult] = await Promise.all([
    supabase.from("single_market_bot_state").select("*").eq("id", "main").maybeSingle(),
    supabase
      .from("single_market_bot_trades")
      .select("id,created_at,updated_at,status,mode,mint,symbol,name,score,entry_price_usd,exit_price_usd,size_usdc,high_water_price_usd,exit_reason,pnl_usdc,pnl_pct,metadata")
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  if (stateResult.error || tradesResult.error) {
    console.error("[single-market-dashboard] query failed", stateResult.error ?? tradesResult.error);
    return NextResponse.json({ error: "Dashboard data is temporarily unavailable" }, { status: 500 });
  }

  const state = stateResult.data ?? {};
  const trades = tradesResult.data ?? [];
  const closed = trades.filter((trade) => String(trade.status).includes("closed"));
  const wins = closed.filter((trade) => Number(trade.pnl_usdc ?? 0) > 0).length;
  const losses = closed.filter((trade) => Number(trade.pnl_usdc ?? 0) < 0).length;
  const totalPnlUsdc = closed.reduce((sum, trade) => sum + Number(trade.pnl_usdc ?? 0), 0);

  return NextResponse.json(
    {
      generatedAt: new Date().toISOString(),
      state,
      openPosition: state.open_position ?? null,
      trades,
      stats: {
        completed: closed.length,
        wins,
        losses,
        winRate: closed.length ? wins / closed.length : 0,
        totalPnlUsdc,
        cashUsdc: Number(state.cash_usdc ?? 0),
        startingCashUsdc: Number(state.starting_cash_usdc ?? 0),
      },
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
