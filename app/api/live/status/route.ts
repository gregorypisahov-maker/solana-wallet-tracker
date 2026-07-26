import { NextRequest, NextResponse } from "next/server";
import { hasViewerAccess, unauthorized } from "@/lib/dashboardAuth";
import { getLiveWalletHealth } from "@/lib/liveWallet";
import { getSupabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!hasViewerAccess(request)) return unauthorized();
  const health = await getLiveWalletHealth();
  const supabase = getSupabaseAdmin({ noStore: true });
  const [{ data: config }, { data: positions }, { data: trades }] = await Promise.all([
    supabase.from("live_trading_config").select("*").eq("id", 1).maybeSingle(),
    supabase.from("live_positions").select("*").order("opened_at", { ascending: false }).limit(20),
    supabase.from("live_trades").select("*").order("created_at", { ascending: false }).limit(30),
  ]);
  return NextResponse.json({ health, config, positions: positions ?? [], trades: trades ?? [] }, { headers: { "Cache-Control": "no-store" } });
}
