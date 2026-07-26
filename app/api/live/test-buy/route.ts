import { NextRequest, NextResponse } from "next/server";
import { hasAdminAccess, unauthorized } from "@/lib/dashboardAuth";
import { executeJupiterBuy, getLiveWalletHealth } from "@/lib/liveWallet";
import { getSupabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!hasAdminAccess(request)) return unauthorized("Owner password required");
  const body = await request.json().catch(() => null);
  const outputMint = typeof body?.outputMint === "string" ? body.outputMint.trim() : "";
  const amountSol = Number(body?.amountSol);
  const slippageBps = Number(body?.slippageBps ?? 100);
  const confirmation = typeof body?.confirmation === "string" ? body.confirmation : "";
  if (confirmation !== "EXECUTE SMALL LIVE TEST") {
    return NextResponse.json({ error: "Exact live-test confirmation phrase required" }, { status: 400 });
  }
  if (!outputMint || !Number.isFinite(amountSol) || amountSol <= 0 || amountSol > 0.1) {
    return NextResponse.json({ error: "Test amount must be greater than 0 and at most 0.1 SOL" }, { status: 400 });
  }

  const health = await getLiveWalletHealth();
  if (health.balanceSol == null || health.balanceSol - amountSol < 0.02) {
    return NextResponse.json({ error: "Wallet must keep at least 0.02 SOL after the test buy" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin({ noStore: true });
  const { data: config } = await supabase.from("live_trading_config").select("*").eq("id", 1).maybeSingle();
  if (!config || !config.execution_enabled || config.emergency_stop) {
    return NextResponse.json({ error: "Database live controls are not enabled or emergency stop is active" }, { status: 409 });
  }
  const { count } = await supabase.from("live_positions").select("id", { count: "exact", head: true }).in("status", ["pending", "open", "closing"]);
  if ((count ?? 0) >= Number(config.max_open_positions ?? 1)) {
    return NextResponse.json({ error: "Maximum open live positions reached" }, { status: 409 });
  }

  try {
    const result = await executeJupiterBuy({ outputMint, lamports: Math.round(amountSol * 1_000_000_000), slippageBps });
    await supabase.from("live_audit_log").insert({ actor: "owner", action: "live_test_buy_confirmed", details: { outputMint, amountSol, slippageBps, signature: result.signature } });
    return NextResponse.json({ ok: true, signature: result.signature });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Live execution failed";
    await supabase.from("live_audit_log").insert({ actor: "owner", action: "live_test_buy_failed", details: { outputMint, amountSol, slippageBps, error: message } });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
