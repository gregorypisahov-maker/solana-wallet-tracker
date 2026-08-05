import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { hasViewerAccess, unauthorized } from "@/lib/dashboardAuth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

const BOT_ID = "xauusd-paper-v1";

const n = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const missingGoldSchema = (error: any) => {
  const text = `${error?.code ?? ""} ${error?.message ?? ""}`.toLowerCase();
  return text.includes("42p01") || text.includes("gold_bot_state") || text.includes("gold_paper_positions");
};

export async function GET(request: NextRequest) {
  if (!hasViewerAccess(request)) return unauthorized();

  const supabase = getSupabaseAdmin({ noStore: true });
  const [stateResult, positionsResult, eventsResult] = await Promise.all([
    supabase.from("gold_bot_state").select("*").eq("bot_id", BOT_ID).maybeSingle(),
    supabase
      .from("gold_paper_positions")
      .select("id,bot_id,instrument,side,units,entry_price,stop_loss,take_profit,entry_spread,opened_at,closed_at,exit_price,realized_pnl_usd,close_reason,status,strategy_version,signal_json")
      .eq("bot_id", BOT_ID)
      .order("opened_at", { ascending: false })
      .limit(1000),
    supabase
      .from("gold_bot_events")
      .select("id,event_type,payload,created_at")
      .eq("bot_id", BOT_ID)
      .order("created_at", { ascending: false })
      .limit(25),
  ]);

  const queryError = stateResult.error ?? positionsResult.error ?? eventsResult.error;
  if (queryError) {
    if (missingGoldSchema(queryError)) {
      return NextResponse.json(
        {
          configured: false,
          generatedAt: new Date().toISOString(),
          status: "setup_required",
          message: "Apply the Gold bot Supabase migration and start the paper service.",
        },
        { headers: { "Cache-Control": "no-store, max-age=0" } },
      );
    }

    console.error("[gold-dashboard] query failed", queryError);
    return NextResponse.json({ error: "Gold dashboard data is temporarily unavailable" }, { status: 500 });
  }

  const state = stateResult.data;
  if (!state) {
    return NextResponse.json(
      {
        configured: false,
        generatedAt: new Date().toISOString(),
        status: "setup_required",
        message: "The database is ready, but the Gold paper service has not initialized its state yet.",
      },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }

  const positions = positionsResult.data ?? [];
  const closedNewestFirst = positions.filter((position) => position.status === "closed");
  const closedChronological = [...closedNewestFirst].sort(
    (a, b) => Date.parse(a.closed_at ?? a.opened_at) - Date.parse(b.closed_at ?? b.opened_at),
  );
  const openPosition = positions.find((position) => position.status === "open") ?? null;
  const winners = closedNewestFirst.filter((position) => n(position.realized_pnl_usd) > 0);
  const losers = closedNewestFirst.filter((position) => n(position.realized_pnl_usd) < 0);
  const grossProfitUsd = winners.reduce((sum, position) => sum + n(position.realized_pnl_usd), 0);
  const grossLossUsd = Math.abs(losers.reduce((sum, position) => sum + n(position.realized_pnl_usd), 0));
  const totalPnlUsd = grossProfitUsd - grossLossUsd;
  const balanceUsd = n(state.balance_usd);
  const startingBalanceUsd = Math.max(0, balanceUsd - totalPnlUsd);
  const dailyDate = String(state.daily_date ?? "");
  const todayPnlUsd = closedNewestFirst
    .filter((position) => String(position.closed_at ?? "").slice(0, 10) === dailyDate)
    .reduce((sum, position) => sum + n(position.realized_pnl_usd), 0);

  let equity = startingBalanceUsd;
  let peak = startingBalanceUsd;
  let maxDrawdownUsd = 0;
  let maxDrawdownPct = 0;
  const equityCurve = closedChronological.map((position) => {
    equity += n(position.realized_pnl_usd);
    peak = Math.max(peak, equity);
    const drawdownUsd = Math.max(0, peak - equity);
    const drawdownPct = peak > 0 ? (drawdownUsd / peak) * 100 : 0;
    maxDrawdownUsd = Math.max(maxDrawdownUsd, drawdownUsd);
    maxDrawdownPct = Math.max(maxDrawdownPct, drawdownPct);
    return {
      time: position.closed_at ?? position.opened_at,
      equityUsd: Number(equity.toFixed(2)),
    };
  });

  const heartbeat = state.last_processed_candle_time ?? state.updated_at;
  const heartbeatMs = Date.parse(heartbeat ?? "");
  const heartbeatFresh = Number.isFinite(heartbeatMs) && Date.now() - heartbeatMs < 45 * 60 * 1000;
  const status = state.paused ? "paused" : heartbeatFresh ? "running" : "stale";

  return NextResponse.json(
    {
      configured: true,
      generatedAt: new Date().toISOString(),
      status,
      state,
      openPosition,
      recentTrades: closedNewestFirst.slice(0, 30),
      recentEvents: eventsResult.data ?? [],
      equityCurve,
      stats: {
        balanceUsd,
        startingBalanceUsd,
        totalPnlUsd,
        todayPnlUsd,
        returnPct: startingBalanceUsd > 0 ? (totalPnlUsd / startingBalanceUsd) * 100 : 0,
        completed: closedNewestFirst.length,
        wins: winners.length,
        losses: losers.length,
        winRate: closedNewestFirst.length ? winners.length / closedNewestFirst.length : 0,
        grossProfitUsd,
        grossLossUsd,
        profitFactor: grossLossUsd > 0 ? grossProfitUsd / grossLossUsd : grossProfitUsd > 0 ? null : 0,
        expectancyUsd: closedNewestFirst.length ? totalPnlUsd / closedNewestFirst.length : 0,
        maxDrawdownUsd,
        maxDrawdownPct,
      },
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
