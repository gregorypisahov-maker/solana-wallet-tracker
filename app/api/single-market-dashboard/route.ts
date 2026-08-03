import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { hasViewerAccess, unauthorized } from "@/lib/dashboardAuth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

const n = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export async function GET(request: NextRequest) {
  if (!hasViewerAccess(request)) return unauthorized();
  const supabase = getSupabaseAdmin({ noStore: true });

  const [stateResult, tradesResult] = await Promise.all([
    supabase.from("single_market_bot_state").select("*").eq("id", "main").maybeSingle(),
    supabase
      .from("single_market_bot_trades")
      .select("id,created_at,updated_at,status,mode,mint,symbol,name,score,entry_price_usd,exit_price_usd,size_usdc,high_water_price_usd,exit_reason,pnl_usdc,pnl_pct,metadata")
      .order("created_at", { ascending: false })
      .limit(250),
  ]);

  if (stateResult.error || tradesResult.error) {
    console.error("[single-market-dashboard] query failed", stateResult.error ?? tradesResult.error);
    return NextResponse.json({ error: "Dashboard data is temporarily unavailable" }, { status: 500 });
  }

  const state = stateResult.data ?? {};
  const trades = tradesResult.data ?? [];
  const closed = trades.filter((trade) => String(trade.status).includes("closed"));
  const winners = closed.filter((trade) => n(trade.pnl_usdc) > 0);
  const losers = closed.filter((trade) => n(trade.pnl_usdc) < 0);
  const wins = winners.length;
  const losses = losers.length;
  const grossProfit = winners.reduce((sum, trade) => sum + n(trade.pnl_usdc), 0);
  const grossLoss = Math.abs(losers.reduce((sum, trade) => sum + n(trade.pnl_usdc), 0));
  const totalPnlUsdc = grossProfit - grossLoss;
  const averageWinUsdc = wins ? grossProfit / wins : 0;
  const averageLossUsdc = losses ? grossLoss / losses : 0;
  const bestTrade = closed.reduce<any | null>((best, trade) => !best || n(trade.pnl_usdc) > n(best.pnl_usdc) ? trade : best, null);
  const worstTrade = closed.reduce<any | null>((worst, trade) => !worst || n(trade.pnl_usdc) < n(worst.pnl_usdc) ? trade : worst, null);
  const startingCashUsdc = n(state.starting_cash_usdc);
  const cashUsdc = n(state.cash_usdc);
  const returnPct = startingCashUsdc > 0 ? (totalPnlUsdc / startingCashUsdc) * 100 : 0;

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
        cashUsdc,
        startingCashUsdc,
        returnPct,
        grossProfit,
        grossLoss,
        profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
        averageWinUsdc,
        averageLossUsdc,
        expectancyUsdc: closed.length ? totalPnlUsdc / closed.length : 0,
        bestTrade: bestTrade ? { symbol: bestTrade.symbol, pnlUsdc: n(bestTrade.pnl_usdc), pnlPct: n(bestTrade.pnl_pct) } : null,
        worstTrade: worstTrade ? { symbol: worstTrade.symbol, pnlUsdc: n(worstTrade.pnl_usdc), pnlPct: n(worstTrade.pnl_pct) } : null,
      },
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
