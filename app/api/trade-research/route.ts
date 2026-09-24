import { NextRequest, NextResponse } from "next/server";
import { hasViewerAccess, unauthorized } from "@/lib/dashboardAuth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getResearchWallet, reconstructTrades, scanResearchEvents } from "@/lib/tradeResearch";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!hasViewerAccess(request)) return unauthorized();
  const wallet = getResearchWallet();
  const supabase = getSupabaseAdmin({ noStore: true });

  const { data: trades, error } = await supabase
    .from("trade_research_trades")
    .select("*")
    .eq("wallet_address", wallet)
    .order("exit_time", { ascending: false })
    .limit(1000);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = trades ?? [];
  const wins = rows.filter((x) => Number(x.pnl_sol) > 0);
  const losses = rows.filter((x) => Number(x.pnl_sol) < 0);
  const avg = (items: any[], key: string) =>
    items.length ? items.reduce((s, x) => s + Number(x[key] ?? 0), 0) / items.length : 0;

  const byMc = (max: number | null, min = 0) => {
    const items = rows.filter((x) => {
      const mc = Number(x.entry_market_cap_usd);
      return Number.isFinite(mc) && mc >= min && (max == null || mc < max);
    });
    return {
      min,
      max,
      trades: items.length,
      wins: items.filter((x) => Number(x.pnl_sol) > 0).length,
      winRate: items.length ? items.filter((x) => Number(x.pnl_sol) > 0).length / items.length : 0,
      avgRoi: avg(items, "roi_pct"),
      pnlSol: items.reduce((s, x) => s + Number(x.pnl_sol ?? 0), 0),
    };
  };

  return NextResponse.json({
    wallet,
    count: rows.length,
    stats: {
      wins: wins.length,
      losses: losses.length,
      winRate: rows.length ? wins.length / rows.length : 0,
      pnlSol: rows.reduce((s, x) => s + Number(x.pnl_sol ?? 0), 0),
      avgWinRoi: avg(wins, "roi_pct"),
      avgLossRoi: avg(losses, "roi_pct"),
      avgHoldMinutes: avg(rows, "hold_seconds") / 60,
    },
    mcBuckets: [
      byMc(50_000),
      byMc(100_000, 50_000),
      byMc(250_000, 100_000),
      byMc(500_000, 250_000),
      byMc(1_000_000, 500_000),
      byMc(null, 1_000_000),
    ],
    trades: rows,
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  if (!hasViewerAccess(request)) return unauthorized();
  const wallet = getResearchWallet();
  let maxSignatures = Number(process.env.TRADE_RESEARCH_BATCH_SIZE ?? 500);

  try {
    const body = await request.json();
    if (Number.isFinite(Number(body?.maxSignatures))) {
      maxSignatures = Math.min(1000, Math.max(50, Number(body.maxSignatures)));
    }
  } catch {}

  const supabase = getSupabaseAdmin({ noStore: true });
  const scan = await scanResearchEvents(wallet, maxSignatures);
  const trades = reconstructTrades(wallet, scan.events);

  if (trades.length) {
    const payload = trades.map((t) => ({
      wallet_address: t.walletAddress,
      token_mint: t.tokenMint,
      entry_time: t.entryTime.toISOString(),
      exit_time: t.exitTime.toISOString(),
      hold_seconds: t.holdSeconds,
      entry_sol: t.entrySol,
      exit_sol: t.exitSol,
      pnl_sol: t.pnlSol,
      roi_pct: t.roiPct,
      initial_position_usd: t.initialPositionUsd,
      entry_market_cap_usd: t.entryMarketCapUsd,
      exit_market_cap_usd: t.exitMarketCapUsd,
      max_drawdown_pct: t.maxDrawdownPct,
      max_runup_pct: t.maxRunupPct,
      outcome: t.outcome,
      source: "solana_rpc",
      metadata: t.metadata,
    }));
    const { error } = await supabase
      .from("trade_research_trades")
      .upsert(payload, { onConflict: "wallet_address,token_mint,entry_time,exit_time" });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await supabase.from("trade_research_scans").insert({
    wallet_address: wallet,
    finished_at: new Date().toISOString(),
    signatures_scanned: scan.signaturesScanned,
    trades_detected: scan.events.length,
    positions_closed: trades.length,
    status: "completed",
  });

  return NextResponse.json({
    ok: true,
    wallet,
    signaturesScanned: scan.signaturesScanned,
    events: scan.events.length,
    closedTrades: trades.length,
    note: "This first pass records exact on-chain entries/exits. Historical market-cap and social enrichment are the next enrichment stage.",
  });
}
