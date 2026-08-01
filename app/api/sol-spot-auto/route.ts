import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { hasAdminAccess, hasViewerAccess, unauthorized } from "@/lib/dashboardAuth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

const noStore = { headers: { "Cache-Control": "no-store, max-age=0" } };
const finite = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export async function GET(request: NextRequest) {
  if (!hasViewerAccess(request)) return unauthorized("Viewer login required");
  const supabase = getSupabaseAdmin({ noStore: true });
  const [stateResult, positionResult, paperResult, tradesResult, ordersResult] = await Promise.all([
    supabase.from("sol_spot_auto_state").select("*").eq("id", 1).single(),
    supabase.from("sol_spot_auto_positions").select("*").eq("id", 1).maybeSingle(),
    supabase.from("sol_spot_paper_positions").select("*").maybeSingle(),
    supabase.from("sol_spot_auto_trades").select("*").order("closed_at", { ascending: false }).limit(30),
    supabase
      .from("sol_spot_auto_orders")
      .select("order_id,side,status,signature,error,created_at,completed_at")
      .order("created_at", { ascending: false })
      .limit(20),
  ]);
  const failed = [stateResult, positionResult, paperResult, tradesResult, ordersResult].find((result) => result.error);
  if (failed?.error) {
    console.error("[sol-spot-auto-api] query failed", failed.error);
    return NextResponse.json({ error: "Automatic SOL bot state is unavailable" }, { status: 500 });
  }
  const state = stateResult.data;
  const heartbeatAgeSeconds = state.last_heartbeat_at
    ? Math.max(0, Math.floor((Date.now() - Date.parse(state.last_heartbeat_at)) / 1000))
    : null;
  const runtimeOnline = heartbeatAgeSeconds != null && heartbeatAgeSeconds < 45;
  return NextResponse.json(
    {
      generatedAt: new Date().toISOString(),
      state,
      position: positionResult.data ?? null,
      paperPosition: paperResult.data ?? null,
      trades: tradesResult.data ?? [],
      orders: ordersResult.data ?? [],
      derived: {
        runtimeOnline,
        heartbeatAgeSeconds,
        automatic: true,
        perTradeApprovalRequired: false,
        venue: "Jupiter on Solana",
        settlementAsset: "USDT",
        realizedPnlUsdt: finite(state.realized_pnl_usdt),
      },
    },
    noStore
  );
}

export async function POST(request: NextRequest) {
  if (!hasViewerAccess(request)) return unauthorized("Viewer login required");
  if (!hasAdminAccess(request)) return unauthorized("Owner password required");
  const body = await request.json().catch(() => ({}));
  const action = String(body.action ?? "");
  const supabase = getSupabaseAdmin({ noStore: true });
  const { data: state, error: stateError } = await supabase
    .from("sol_spot_auto_state")
    .select("*")
    .eq("id", 1)
    .single();
  if (stateError) return NextResponse.json({ error: stateError.message }, { status: 500 });

  let patch: Record<string, unknown> = {};
  if (action === "configure") {
    const maxPositionUsdt = finite(body.maxPositionUsdt);
    const bootstrapSolAmount = finite(body.bootstrapSolAmount);
    const slippageBps = Math.round(finite(body.slippageBps));
    if (maxPositionUsdt < 10 || maxPositionUsdt > 200) {
      return NextResponse.json({ error: "Trade size must be between 10 and 200 USDT" }, { status: 400 });
    }
    if (bootstrapSolAmount < 0 || bootstrapSolAmount > 100) {
      return NextResponse.json({ error: "Starting SOL amount must be between 0 and 100 SOL" }, { status: 400 });
    }
    if (slippageBps < 10 || slippageBps > 200) {
      return NextResponse.json({ error: "Slippage must be between 10 and 200 bps" }, { status: 400 });
    }
    patch = {
      max_position_usdt: Number(maxPositionUsdt.toFixed(2)),
      bootstrap_sol_amount: Number(bootstrapSolAmount.toFixed(9)),
      slippage_bps: slippageBps,
      armed: false,
      status: "disarmed",
      halt_reason: null,
      last_error: null,
    };
  } else if (action === "enable") {
    const { data: unresolved } = await supabase
      .from("sol_spot_auto_orders")
      .select("order_id")
      .eq("status", "reconciliation_required")
      .limit(1)
      .maybeSingle();
    if (unresolved) {
      return NextResponse.json({ error: "Resolve the pending execution reconciliation before enabling" }, { status: 409 });
    }
    patch = {
      enabled: true,
      armed: true,
      bootstrap_pending: finite(state.bootstrap_sol_amount) > 0,
      status: "starting",
      halt_reason: null,
      last_error: null,
    };
  } else if (action === "disable") {
    patch = { enabled: false, armed: false, status: "disabled", halt_reason: "manual_stop", bootstrap_pending: false };
  } else if (action === "emergency_stop") {
    patch = { armed: false, status: "halted", halt_reason: "manual_emergency_stop", bootstrap_pending: false };
  } else {
    return NextResponse.json({ error: "Unknown automatic-bot action" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("sol_spot_auto_state")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", 1)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, state: data }, noStore);
}
