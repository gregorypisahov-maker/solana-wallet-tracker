import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

function isSamePublicOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;

  try {
    const originHost = new URL(origin).host.toLowerCase();
    const forwardedHost = (request.headers.get("x-forwarded-host") || request.headers.get("host") || "")
      .split(",")[0]
      .trim()
      .toLowerCase();
    return Boolean(forwardedHost) && originHost === forwardedHost;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  if (!isSamePublicOrigin(request)) {
    return NextResponse.json({ error: "Cross-site stop request rejected" }, { status: 403 });
  }

  try {
    const supabase = getSupabaseAdmin({ noStore: true });
    const now = new Date().toISOString();

    const { error: stateError } = await supabase
      .from("live_executor_state")
      .update({
        enabled: false,
        halted: true,
        halt_reason: "manual_stop_button",
        updated_at: now,
      })
      .eq("id", 1);

    if (stateError) throw stateError;

    const { error: pendingError } = await supabase
      .from("live_trade_signals")
      .update({
        status: "rejected",
        rejection_reason: "manual_stop_button",
        completed_at: now,
      })
      .eq("status", "pending");

    if (pendingError) throw pendingError;

    return NextResponse.redirect(new URL("/live?stopped=1", request.url), 303);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not stop live trading";
    return NextResponse.redirect(new URL(`/live?stop_error=${encodeURIComponent(message)}`, request.url), 303);
  }
}
