import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { hasAdminAccess, hasViewerAccess, unauthorized } from "@/lib/dashboardAuth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

type BotId = "legion" | "scalper" | "shadow";
type Action = "resume" | "pause";

export async function POST(request: NextRequest) {
  if (!hasViewerAccess(request)) return unauthorized("Viewer login required");
  if (!hasAdminAccess(request)) return unauthorized("Owner password required");

  const body = await request.json().catch(() => ({}));
  const bot = body.bot as BotId;
  const action = body.action as Action;
  if (!["legion", "scalper", "shadow"].includes(bot) || !["resume", "pause"].includes(action)) {
    return NextResponse.json({ error: "Invalid bot control request" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin({ noStore: true });
  const now = new Date().toISOString();
  let query;

  if (bot === "legion") {
    query = supabase
      .from("paper_state")
      .update(action === "resume"
        ? { halted: false, halt_reason: null, consecutive_losses: 0, updated_at: now }
        : { halted: true, halt_reason: "manual_dashboard_pause", updated_at: now })
      .eq("id", 1);
  } else if (bot === "scalper") {
    query = supabase
      .from("scalp_state")
      .update(action === "resume"
        ? { enabled: true, halted: false, halt_reason: null, consecutive_losses: 0, updated_at: now }
        : { halted: true, halt_reason: "manual_dashboard_pause", updated_at: now })
      .eq("id", 1);
  } else {
    query = supabase
      .from("shadow_strategy_state")
      .update({ enabled: action === "resume", updated_at: now })
      .eq("id", 1);
  }

  const { error } = await query;
  if (error) {
    console.error(`[bot-control] ${bot} ${action} failed`, error);
    return NextResponse.json({ error: "Could not update bot state" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, bot, action, updatedAt: now }, { headers: { "Cache-Control": "no-store" } });
}
