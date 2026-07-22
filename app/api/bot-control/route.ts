import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { hasAdminAccess, hasViewerAccess, unauthorized } from "@/lib/dashboardAuth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

type BotId = "legion" | "shadow";
type Action = "resume" | "pause";

export async function POST(request: NextRequest) {
  if (!hasViewerAccess(request)) return unauthorized("Viewer login required");
  if (!hasAdminAccess(request)) return unauthorized("Owner password required");

  const body = await request.json().catch(() => ({}));
  const bot = body.bot as BotId;
  const action = body.action as Action;
  if (!['legion', 'shadow'].includes(bot) || !['resume', 'pause'].includes(action)) {
    return NextResponse.json({ error: "Invalid bot control request" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin({ noStore: true });
  const now = new Date().toISOString();

  let data: Record<string, unknown> | null = null;
  let error: { message: string } | null = null;

  if (bot === "legion") {
    const result = await supabase
      .from("paper_state")
      .update(
        action === "resume"
          ? { halted: false, halt_reason: null, consecutive_losses: 0, updated_at: now }
          : { halted: true, halt_reason: "manual_dashboard_pause", updated_at: now }
      )
      .eq("id", 1)
      .select("*")
      .single();
    data = result.data;
    error = result.error;
  } else {
    const result = await supabase
      .from("shadow_strategy_state")
      .update({ enabled: action === "resume", updated_at: now })
      .eq("id", 1)
      .select("*")
      .single();
    data = result.data;
    error = result.error;
  }

  if (error) {
    console.error(`[bot-control] ${bot} ${action} failed`, error);
    return NextResponse.json(
      { error: `Could not ${action} ${bot}: ${error.message}` },
      { status: 500 }
    );
  }

  const resumed =
    action !== "resume" ||
    (bot === "legion" ? data?.halted === false : data?.enabled === true);
  if (!resumed) {
    console.error(`[bot-control] ${bot} resume did not persist`, data);
    return NextResponse.json({ error: "Resume did not persist in the database" }, { status: 409 });
  }

  return NextResponse.json(
    { ok: true, bot, action, state: data, updatedAt: now },
    { headers: { "Cache-Control": "no-store" } }
  );
}
