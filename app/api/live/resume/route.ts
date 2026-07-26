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
    return NextResponse.json({ error: "Cross-site resume request rejected" }, { status: 403 });
  }

  try {
    const supabase = getSupabaseAdmin({ noStore: true });
    const now = new Date().toISOString();

    const { error } = await supabase
      .from("live_executor_state")
      .update({
        enabled: true,
        halted: false,
        halt_reason: "manual_resume_button",
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
