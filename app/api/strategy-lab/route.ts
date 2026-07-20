import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { hasAdminAccess, unauthorized } from "@/lib/dashboardAuth";

export const dynamic = "force-dynamic";

const numericFields = [
  "min_liquidity_usd","min_market_cap_usd","max_market_cap_usd","min_liquidity_to_mcap",
  "min_five_minute_change_pct","max_five_minute_change_pct","min_fifteen_minute_change_pct",
  "max_fifteen_minute_change_pct","min_volume_usd","min_buyers","min_buy_sell_ratio",
  "min_pool_age_minutes","max_pool_age_minutes","hard_stop_loss_pct","target_profit_pct",
  "trailing_activation_pct","trailing_giveback_pct","max_hold_seconds","fixed_size_sol",
  "max_concurrent_positions"
] as const;

export async function POST(request: NextRequest) {
  if (!hasAdminAccess(request)) return unauthorized("Owner password required");
  const body = await request.json().catch(() => null);
  if (!body || body.strategy !== "scalper-shadow" || typeof body.config !== "object") {
    return NextResponse.json({ error: "Invalid Strategy Lab request" }, { status: 400 });
  }
  const config: Record<string, number | boolean | string> = { updated_at: new Date().toISOString() };
  for (const field of numericFields) {
    const value = Number(body.config[field]);
    if (!Number.isFinite(value)) return NextResponse.json({ error: `Invalid ${field}` }, { status: 400 });
    config[field] = value;
  }
  config.enabled = body.config.enabled !== false;
  config.strategy_version = String(body.config.strategy_version || `scalper_shadow_${new Date().toISOString().slice(0,10)}`);
  if (Number(config.min_market_cap_usd) >= Number(config.max_market_cap_usd)) return NextResponse.json({ error: "Maximum market cap must exceed minimum" }, { status: 400 });
  if (Number(config.min_five_minute_change_pct) >= Number(config.max_five_minute_change_pct)) return NextResponse.json({ error: "5m maximum must exceed minimum" }, { status: 400 });
  if (Number(config.min_fifteen_minute_change_pct) >= Number(config.max_fifteen_minute_change_pct)) return NextResponse.json({ error: "15m maximum must exceed minimum" }, { status: 400 });
  const supabase = getSupabaseAdmin({ noStore: true });
  const { data, error } = await supabase.from("scalper_shadow_config").update(config).eq("id",1).select("*").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (body.savePreset) {
    await supabase.from("strategy_lab_presets").insert({ strategy_id:"scalper-shadow", name:String(body.presetName || "Scalper Shadow experiment"), config:data, status:"testing" });
  }
  return NextResponse.json({ ok:true, config:data });
}
