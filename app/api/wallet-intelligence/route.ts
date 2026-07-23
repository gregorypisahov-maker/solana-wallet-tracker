import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { hasViewerAccess, unauthorized } from "@/lib/dashboardAuth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

type Row = Record<string, any>;

export async function GET(request: NextRequest) {
  if (!hasViewerAccess(request)) return unauthorized();
  const supabase = getSupabaseAdmin({ noStore: true });
  const [wallets, performance, transactions] = await Promise.all([
    supabase.from("wallets").select("*").order("active", { ascending: false }).order("management_updated_at", { ascending: false }),
    supabase.from("wallet_performance").select("*"),
    supabase.from("wallet_transactions").select("wallet_address,tx_time,side"),
  ]);

  const failed = [wallets, performance, transactions].find((result) => result.error);
  if (failed?.error) {
    console.error("[wallet-intelligence] query failed", failed.error);
    return NextResponse.json({ error: "Wallet intelligence is temporarily unavailable" }, { status: 500 });
  }

  const performanceByAddress = new Map<string, Row>();
  for (const row of performance.data ?? []) {
    const address = row.wallet_address ?? row.address;
    if (address) performanceByAddress.set(address, row);
  }

  const activity = new Map<string, { transactions: number; buys: number; sells: number; lastActivityAt: string | null }>();
  for (const row of transactions.data ?? []) {
    const current = activity.get(row.wallet_address) ?? { transactions: 0, buys: 0, sells: 0, lastActivityAt: null };
    current.transactions += 1;
    if (String(row.side).toLowerCase() === "buy") current.buys += 1;
    if (String(row.side).toLowerCase() === "sell") current.sells += 1;
    if (!current.lastActivityAt || Date.parse(row.tx_time) > Date.parse(current.lastActivityAt)) current.lastActivityAt = row.tx_time;
    activity.set(row.wallet_address, current);
  }

  const rows = (wallets.data ?? []).map((wallet: Row) => ({
    ...wallet,
    performance: performanceByAddress.get(wallet.address) ?? null,
    activity: activity.get(wallet.address) ?? { transactions: 0, buys: 0, sells: 0, lastActivityAt: null },
  }));

  const active = rows.filter((wallet: Row) => wallet.active);
  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    summary: {
      total: rows.length,
      active: active.length,
      proven: active.filter((wallet: Row) => wallet.management_status === "proven").length,
      trial: active.filter((wallet: Row) => wallet.management_status === "trial").length,
      disabled: rows.filter((wallet: Row) => !wallet.active).length,
      activeWithActivity: active.filter((wallet: Row) => wallet.activity.transactions > 0).length,
    },
    wallets: rows,
  }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
