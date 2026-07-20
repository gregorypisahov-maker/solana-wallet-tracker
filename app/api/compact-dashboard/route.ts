import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { hasViewerAccess, unauthorized } from "@/lib/dashboardAuth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

type Row = Record<string, any>;

function summarize(rows: Row[], pnlKey: string, timeKey: string) {
  const trades = rows.map((row) => ({ ...row, pnl: Number(row[pnlKey] ?? 0), happenedAt: row[timeKey] ?? null }));
  const wins = trades.filter((row) => row.pnl > 0).length;
  const losses = trades.filter((row) => row.pnl < 0).length;
  const grossProfit = trades.filter((row) => row.pnl > 0).reduce((sum, row) => sum + row.pnl, 0);
  const grossLoss = Math.abs(trades.filter((row) => row.pnl < 0).reduce((sum, row) => sum + row.pnl, 0));
  return {
    completedTrades: trades.length,
    wins,
    losses,
    winRate: trades.length ? wins / trades.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    totalPnlSol: trades.reduce((sum, row) => sum + row.pnl, 0),
    recentTrades: trades.slice(0, 100),
  };
}

function summarizeRegular(rows: Row[]) {
  const grouped = new Map<string, { pnl: number; soldPct: number; row: Row }>();
  for (const row of rows) {
    const key = row.position_id ?? `${row.mint}:${row.entry_price}`;
    const current = grouped.get(key) ?? { pnl: 0, soldPct: 0, row };
    current.pnl += Number(row.pnl_sol ?? 0);
    current.soldPct += Number(row.sold_pct ?? 0);
    current.row = row;
    grouped.set(key, current);
  }
  const completed = [...grouped.values()].filter((item) => item.soldPct >= 0.999).map((item) => ({ ...item.row, pnl_sol: item.pnl }));
  return summarize(completed, "pnl_sol", "happened_at");
}

function newest(...values: Array<string | null | undefined>): string | null {
  const valid = values.filter((value): value is string => Boolean(value) && Number.isFinite(Date.parse(value as string)));
  return valid.length ? valid.sort((a, b) => Date.parse(b) - Date.parse(a))[0] : null;
}

function drawdown(trades: Row[]) {
  let equity = 0, peak = 0, maxDd = 0;
  for (const trade of [...trades].reverse()) {
    equity += Number(trade.pnl ?? trade.pnl_sol ?? 0);
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  return maxDd;
}

function windowStats(trades: Row[], fromMs: number, toMs = Date.now()) {
  const filtered = trades.filter((trade) => {
    const time = Date.parse(trade.happenedAt ?? trade.closed_at ?? trade.happened_at ?? 0);
    return time >= fromMs && time < toMs;
  });
  const pnlSol = filtered.reduce((sum, trade) => sum + Number(trade.pnl ?? trade.pnl_sol ?? 0), 0);
  return { trades: filtered.length, wins: filtered.filter((t) => Number(t.pnl ?? t.pnl_sol) > 0).length, losses: filtered.filter((t) => Number(t.pnl ?? t.pnl_sol) < 0).length, pnlSol };
}

export async function GET(request: NextRequest) {
  if (!hasViewerAccess(request)) return unauthorized();
  const supabase = getSupabaseAdmin({ noStore: true });

  const [
    paperState, paperPositions, paperTrades,
    scalpState, scalpPositions, scalpTrades, scalpScans,
    shadowState, shadowPositions, shadowTrades,
    scalpShadowState, scalpShadowPositions, scalpShadowTrades, scalpShadowConfig,
    wallets, walletPerformance, tokenScores, readiness, adaptive, usage, discoveryRuns, presets,
  ] = await Promise.all([
    supabase.from("paper_state").select("*").eq("id", 1).maybeSingle(),
    supabase.from("paper_positions").select("*").order("entry_time", { ascending: false }),
    supabase.from("paper_trades").select("*").order("happened_at", { ascending: false }).limit(1000),
    supabase.from("scalp_state").select("*").eq("id", 1).maybeSingle(),
    supabase.from("scalp_positions").select("*").order("entry_time", { ascending: false }),
    supabase.from("scalp_trades").select("*").order("closed_at", { ascending: false }).limit(500),
    supabase.from("scalp_scan_runs").select("id,started_at,finished_at,status,scanned_count,qualified_count,top_symbol,top_score,message").order("started_at", { ascending: false }).limit(12),
    supabase.from("shadow_strategy_state").select("*").eq("id", 1).maybeSingle(),
    supabase.from("shadow_positions").select("*").order("entry_time", { ascending: false }),
    supabase.from("shadow_trades").select("*").order("happened_at", { ascending: false }).limit(500),
    supabase.from("scalper_shadow_state").select("*").eq("id", 1).maybeSingle(),
    supabase.from("scalper_shadow_positions").select("*").order("entry_time", { ascending: false }),
    supabase.from("scalper_shadow_trades").select("*").order("closed_at", { ascending: false }).limit(500),
    supabase.from("scalper_shadow_config").select("*").eq("id", 1).maybeSingle(),
    supabase.from("wallets").select("address,label,active,management_status,discovery_source,last_signature,management_updated_at").order("management_updated_at", { ascending: false }).limit(100),
    supabase.from("wallet_performance").select("*").order("trust_score", { ascending: false }).limit(25),
    supabase.from("token_scores").select("token_symbol,token_mint,score,wallets_count,total_sol_bought,market_cap,liquidity_usd,updated_at").order("updated_at", { ascending: false }).limit(50),
    supabase.from("live_readiness_state").select("*").eq("id", 1).maybeSingle(),
    supabase.from("adaptive_strategy_state").select("*").eq("id", 1).maybeSingle(),
    supabase.from("monitor_usage_samples").select("*").order("recorded_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("wallet_discovery_runs").select("*").order("ran_at", { ascending: false }).limit(5),
    supabase.from("strategy_lab_presets").select("*").order("updated_at", { ascending: false }).limit(20),
  ]);

  const results = { paperState, paperPositions, paperTrades, scalpState, scalpPositions, scalpTrades, scalpScans, shadowState, shadowPositions, shadowTrades, scalpShadowState, scalpShadowPositions, scalpShadowTrades, scalpShadowConfig, wallets, walletPerformance, tokenScores, readiness, adaptive, usage, discoveryRuns, presets };
  const failed = Object.entries(results).find(([, result]) => result.error);
  if (failed) {
    console.error(`[compact-dashboard] ${failed[0]} query failed`, failed[1].error);
    return NextResponse.json({ error: "Dashboard data is temporarily unavailable" }, { status: 500 });
  }

  const legion = summarizeRegular(paperTrades.data ?? []);
  const scalper = summarize(scalpTrades.data ?? [], "pnl_sol", "closed_at");
  const shadow = summarize(shadowTrades.data ?? [], "pnl_sol", "happened_at");
  const scalperShadow = summarize(scalpShadowTrades.data ?? [], "pnl_sol", "closed_at");
  const now = Date.now(), h24 = 86_400_000, h48 = 2 * h24;

  const bots = [
    { id: "legion", name: "Legion Bot", subtitle: "Wallet consensus strategy", version: "regular_hybrid_v2_2026_07_20", state: { ...(paperState.data ?? {}), enabled: true }, bankrollSol: Number(paperState.data?.bankroll_sol ?? 0), startingBankrollSol: 10, lastScanAt: newest(paperState.data?.updated_at, legion.recentTrades[0]?.happenedAt), positions: paperPositions.data ?? [], openPositions: (paperPositions.data ?? []).length, ...legion, maxDrawdownSol: drawdown(legion.recentTrades) },
    { id: "scalper", name: "Scalper Bot", subtitle: "Momentum scalper", version: "momentum_expanded_profile_v6_2026_07_20", state: scalpState.data, bankrollSol: Number(scalpState.data?.bankroll_sol ?? 0), startingBankrollSol: Number(scalpState.data?.starting_bankroll_sol ?? 1), lastScanAt: newest(scalpState.data?.last_scan_at, scalpState.data?.updated_at, scalper.recentTrades[0]?.happenedAt), positions: scalpPositions.data ?? [], openPositions: (scalpPositions.data ?? []).length, scans: scalpScans.data ?? [], ...scalper, maxDrawdownSol: drawdown(scalper.recentTrades) },
    { id: "shadow", name: "Shadow Bot", subtitle: "Legion forward test", version: "shadow_forward_test", state: shadowState.data, bankrollSol: Number(shadowState.data?.bankroll_sol ?? 0), startingBankrollSol: Number(shadowState.data?.starting_bankroll_sol ?? 10), lastScanAt: newest(shadowState.data?.updated_at, shadow.recentTrades[0]?.happenedAt), positions: shadowPositions.data ?? [], openPositions: (shadowPositions.data ?? []).length, ...shadow, maxDrawdownSol: drawdown(shadow.recentTrades) },
    { id: "scalper-shadow", name: "Scalper Shadow", subtitle: "Scalper forward test", version: scalpShadowConfig.data?.strategy_version ?? "scalper_shadow_v1", state: scalpShadowState.data, bankrollSol: Number(scalpShadowState.data?.bankroll_sol ?? 1), startingBankrollSol: Number(scalpShadowState.data?.starting_bankroll_sol ?? 1), lastScanAt: newest(scalpShadowState.data?.last_scan_at, scalpShadowState.data?.updated_at, scalperShadow.recentTrades[0]?.happenedAt), positions: scalpShadowPositions.data ?? [], openPositions: (scalpShadowPositions.data ?? []).length, config: scalpShadowConfig.data, ...scalperShadow, maxDrawdownSol: drawdown(scalperShadow.recentTrades) },
  ].map((bot) => ({ ...bot, recent24h: windowStats(bot.recentTrades, now - h24), recent48h: windowStats(bot.recentTrades, now - h48), previous48h: windowStats(bot.recentTrades, now - h48 * 2, now - h48) }));

  const allRecent = bots.flatMap((bot) => bot.recentTrades.map((trade: any) => ({ ...trade, botId: bot.id, botName: bot.name }))).sort((a, b) => Date.parse(b.happenedAt ?? 0) - Date.parse(a.happenedAt ?? 0));
  const profit = allRecent.filter((t) => Number(t.pnl) > 0).reduce((s, t) => s + Number(t.pnl), 0);
  const loss = Math.abs(allRecent.filter((t) => Number(t.pnl) < 0).reduce((s, t) => s + Number(t.pnl), 0));
  const overview = {
    totalPnlSol: bots.reduce((sum, bot) => sum + bot.totalPnlSol, 0),
    totalEquitySol: bots.reduce((sum, bot) => sum + bot.bankrollSol, 0),
    completedTrades: bots.reduce((sum, bot) => sum + bot.completedTrades, 0),
    wins: bots.reduce((sum, bot) => sum + bot.wins, 0), losses: bots.reduce((sum, bot) => sum + bot.losses, 0),
    openPositions: bots.reduce((sum, bot) => sum + bot.openPositions, 0), profitFactor: loss > 0 ? profit / loss : null,
    recent24hPnlSol: bots.reduce((sum, bot) => sum + bot.recent24h.pnlSol, 0),
    recent48hPnlSol: bots.reduce((sum, bot) => sum + bot.recent48h.pnlSol, 0),
    previous48hPnlSol: bots.reduce((sum, bot) => sum + bot.previous48h.pnlSol, 0),
  };

  return NextResponse.json({ generatedAt: new Date().toISOString(), bots, overview, recentActivity: allRecent.slice(0, 50), wallets: wallets.data ?? [], walletPerformance: walletPerformance.data ?? [], tokenScores: tokenScores.data ?? [], readiness: readiness.data, adaptive: adaptive.data, usage: usage.data, discoveryRuns: discoveryRuns.data ?? [], strategyLab: { scalperShadowConfig: scalpShadowConfig.data, presets: presets.data ?? [] } }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
