import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { hasViewerAccess, unauthorized } from "@/lib/dashboardAuth";

export const dynamic = "force-dynamic";

const maskAddress = (value: string) => `${value.slice(0, 4)}…${value.slice(-4)}`;

export async function GET(request: NextRequest) {
  if (!hasViewerAccess(request)) return unauthorized();

  const supabase = getSupabaseAdmin();
  const [state, positions, trades, tokens, wallets, performance, transactions] =
    await Promise.all([
      supabase.from("paper_state").select("*").eq("id", 1).maybeSingle(),
      supabase.from("paper_positions").select("*").order("entry_time", { ascending: false }),
      supabase.from("paper_trades").select("*").order("happened_at", { ascending: false }).limit(1000),
      supabase.from("token_scores").select("*").order("updated_at", { ascending: false }).limit(50),
      supabase.from("wallets").select("address,label,active,created_at").order("created_at"),
      supabase.from("wallet_performance").select("*").order("trust_score", { ascending: false }).limit(20),
      supabase.from("wallet_transactions").select("wallet_address,token_mint,side,sol_amount,tx_time,is_scalp").order("tx_time", { ascending: false }).limit(50),
    ]);

  const queries = { state, positions, trades, tokens, wallets, performance, transactions };
  const failed = Object.entries(queries).find(([, result]) => result.error);
  if (failed) {
    console.error(`[dashboard] ${failed[0]} query failed`, failed[1].error);
    return NextResponse.json({ error: "Dashboard data is temporarily unavailable" }, { status: 500 });
  }

  const tradeRows = trades.data ?? [];
  const grouped = new Map<string, { pnl: number; cost: number; soldPct: number }>();
  for (const row of tradeRows) {
    const key = row.position_id ?? `${row.mint}:${row.entry_price}`;
    const current = grouped.get(key) ?? { pnl: 0, cost: 0, soldPct: 0 };
    current.pnl += Number(row.pnl_sol);
    current.cost += Number(row.sold_size_sol);
    current.soldPct += Number(row.sold_pct);
    grouped.set(key, current);
  }
  // A ladder sale is not a completed trade. Count a position only after
  // all of its original size has been sold.
  const closed = [...grouped.values()].filter((item) => item.soldPct >= 0.999);
  const wins = closed.filter((item) => item.pnl > 0).length;
  const grossProfit = closed.filter((item) => item.pnl > 0).reduce((sum, item) => sum + item.pnl, 0);
  const grossLoss = Math.abs(closed.filter((item) => item.pnl < 0).reduce((sum, item) => sum + item.pnl, 0));

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    state: state.data,
    positions: positions.data ?? [],
    trades: tradeRows.slice(0, 100),
    tokens: tokens.data ?? [],
    summary: {
      completedPositions: closed.length,
      wins,
      losses: closed.length - wins,
      winRate: closed.length ? wins / closed.length : 0,
      totalPnlSol: closed.reduce((sum, item) => sum + item.pnl, 0),
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
      openPositions: positions.data?.length ?? 0,
      activeWallets: (wallets.data ?? []).filter((wallet) => wallet.active).length,
      configuredWallets: wallets.data?.length ?? 0,
    },
    // A viewer can follow performance without receiving the private source
    // list of complete wallet addresses.
    performance: (performance.data ?? []).map((row) => ({
      ...row,
      wallet_address: maskAddress(row.wallet_address),
    })),
    transactions: (transactions.data ?? []).map((row) => ({
      ...row,
      wallet_address: maskAddress(row.wallet_address),
    })),
  }, { headers: { "Cache-Control": "no-store" } });
}
