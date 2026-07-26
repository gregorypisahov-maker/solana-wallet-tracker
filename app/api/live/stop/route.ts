import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
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
