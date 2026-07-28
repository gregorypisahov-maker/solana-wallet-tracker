import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const supabase = getSupabaseAdmin({ noStore: true });
    const now = new Date().toISOString();

    const { error } = await supabase
      .from("live_executor_state")
      .update({
        enabled: true,
        halted: false,
        halt_reason: "manual_resume_button",
        consecutive_losses: 0,
        loss_streak_reset_at: now,
        updated_at: now,
      })
      .eq("id", 1);

    if (error) throw error;

    return NextResponse.redirect(new URL("/live?resumed=1", request.url), 303);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not resume live trading";
    return NextResponse.redirect(new URL(`/live?resume_error=${encodeURIComponent(message)}`, request.url), 303);
  }
}
