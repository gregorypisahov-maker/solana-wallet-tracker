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

  let table: "paper_state" | "scalp_state" | "shadow_strategy_state";
  let update: Record<string, unknown>;

  if (bot === "legion") {
    table = "paper_state";
    update = action === "resume"
      ? { halted: false, halt_reason: null, consecutive_losses: 0, updated_at: now }
      : { halted: true, halt_reason: "manual_dashboard_pause", updated_at: now };
  } else if (bot === "scalper") {
    table = "scalp_state";
    update = action === "resume"
      ? {
          enabled: true,
          halted: false,
          halt_reason: null,
          consecutive_losses: 0,
          // A scalper halted at the daily-entry guard otherwise re-halts on the
          // very next scan. A deliberate owner resume starts a fresh manual
          // entry allowance while leaving bankroll and PnL untouched.
          entries_today: 0,
          daily_date: now.slice(0, 10),
          updated_at: now,
        }
      : { halted: true, halt_reason: "manual_dashboard_pause", updated_at: now };
  } else {
    table = "shadow_strategy_state";
    update = { enabled: action === "resume", updated_at: now };
  }

  const { data, error } = await supabase
    .from(table)
    .update(update)
    .eq("id", 1)
    .select("*")
    .single();

  if (error) {
    console.error(`[bot-control] ${bot} ${action} failed`, error);
    return NextResponse.json({ error: `Could not ${action} ${bot}: ${error.message}` }, { status: 500 });
  }

  const resumed = action !== "resume" || (
    bot === "shadow"
      ? data?.enabled === true
      : data?.halted === false && (bot !== "scalper" || data?.enabled === true)
  );

  if (!resumed) {
    console.error(`[bot-control] ${bot} resume did not persist`, data);
    return NextResponse.json({ error: "Resume did not persist in the database" }, { status: 409 });
  }

  return NextResponse.json(
    { ok: true, bot, action, state: data, updatedAt: now },
    { headers: { "Cache-Control": "no-store" } }
  );
}
