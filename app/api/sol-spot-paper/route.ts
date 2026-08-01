import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { hasViewerAccess, unauthorized } from "@/lib/dashboardAuth";
import { SOL_SPOT_PAPER_CONFIG, calculateSpotExit } from "@/paper-trader/solSpotPaper";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

const finite = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export async function GET(request: NextRequest) {
  if (!hasViewerAccess(request)) return unauthorized();

  const supabase = getSupabaseAdmin({ noStore: true });
  const [stateResult, positionResult, scansResult, tradesResult] = await Promise.all([
    supabase.from("sol_spot_paper_state").select("*").eq("id", 1).maybeSingle(),
    supabase.from("sol_spot_paper_positions").select("*").maybeSingle(),
    supabase
      .from("sol_spot_paper_scan_runs")
      .select("*")
      .order("candle_close_time", { ascending: false })
      .limit(60),
    supabase
      .from("sol_spot_paper_trades")
      .select("*")
      .order("closed_at", { ascending: false })
      .limit(50),
  ]);

  const failed = [stateResult, positionResult, scansResult, tradesResult].find(
    (result) => result.error
  );
  if (failed?.error) {
    console.error("[sol-spot-paper-api] query failed", failed.error);
    return NextResponse.json(
      { error: "SOL/USDT paper-bot data is temporarily unavailable" },
      { status: 500 }
    );
  }

  const state = stateResult.data ?? null;
  const position = positionResult.data ?? null;
  const trades = tradesResult.data ?? [];
  const scans = scansResult.data ?? [];
  const currentPrice = finite(state?.last_market_price ?? position?.last_market_price);
  const cashUsdt = finite(state?.bankroll_usdt);

  let openValueUsdt = 0;
  let openPnlUsdt = 0;
  let openReturnPct = 0;
  if (position && currentPrice > 0) {
    const exit = calculateSpotExit({
      quantity: finite(position.quantity),
      entryFillPrice: finite(position.entry_fill_price),
      entryFeeUsdt: finite(position.entry_fee_usdt),
      quoteSpentUsdt: finite(position.quote_spent_usdt),
      marketExitPrice: currentPrice,
    });
    openValueUsdt = exit.proceedsUsdt;
    openPnlUsdt = exit.netPnlUsdt;
    openReturnPct = exit.netReturnPct;
  }

  const wins = trades.filter((trade: any) => finite(trade.net_pnl_usdt) > 0).length;
  const losses = trades.filter((trade: any) => finite(trade.net_pnl_usdt) < 0).length;
  const grossProfit = trades.reduce(
    (sum: number, trade: any) => sum + Math.max(0, finite(trade.net_pnl_usdt)),
    0
  );
  const grossLoss = Math.abs(
    trades.reduce(
      (sum: number, trade: any) => sum + Math.min(0, finite(trade.net_pnl_usdt)),
      0
    )
  );
  const heartbeatAt = state?.last_heartbeat_at ?? state?.updated_at ?? null;
  const heartbeatAgeSeconds = heartbeatAt
    ? Math.max(0, (Date.now() - Date.parse(heartbeatAt)) / 1000)
    : null;

  return NextResponse.json(
    {
      generatedAt: new Date().toISOString(),
      config: {
        symbol: SOL_SPOT_PAPER_CONFIG.symbol,
        mode: "spot_paper",
        leverage: 1,
        entryScoreThreshold: SOL_SPOT_PAPER_CONFIG.entryScoreThreshold,
        riskPctPerTrade: SOL_SPOT_PAPER_CONFIG.riskPctPerTrade,
        maxPositionPct: SOL_SPOT_PAPER_CONFIG.maxPositionPct,
        maxPositionUsdt: SOL_SPOT_PAPER_CONFIG.maxPositionUsdt,
        rewardRiskMultiple: SOL_SPOT_PAPER_CONFIG.rewardRiskMultiple,
        maxDailyEntries: SOL_SPOT_PAPER_CONFIG.maxDailyEntries,
        dailyLossLimitUsdt: SOL_SPOT_PAPER_CONFIG.dailyLossLimitUsdt,
      },
      state,
      position,
      scans,
      trades,
      derived: {
        status:
          state?.enabled === false
            ? "disabled"
            : state?.halted
              ? "halted"
              : position
                ? "position_open"
                : "waiting",
        currentPrice,
        cashUsdt,
        openValueUsdt,
        equityUsdt: cashUsdt + openValueUsdt,
        openPnlUsdt,
        openReturnPct,
        completedTrades: trades.length,
        wins,
        losses,
        winRatePct: trades.length ? (wins / trades.length) * 100 : 0,
        profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
        realizedPnlUsdt: finite(state?.realized_pnl_usdt),
        dailyRealizedPnlUsdt: finite(state?.daily_realized_pnl_usdt),
        heartbeatAt,
        heartbeatAgeSeconds,
        feedHealthy: heartbeatAgeSeconds != null && heartbeatAgeSeconds < 60,
        latestScanAt: scans[0]?.candle_close_time ?? null,
      },
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}
