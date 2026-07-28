import { randomUUID, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

function sameSecret(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const secret = String(form.get("secret") ?? "");
    const expectedSecret = process.env.LIVE_MANUAL_TRADE_KEY ?? "";
    if (!expectedSecret || !sameSecret(secret, expectedSecret)) {
      throw new Error("invalid_manual_trade_key");
    }

    const positionId = String(form.get("position_id") ?? "");
    const confirmed = form.get("confirm_real_money") === "yes";
    if (!confirmed) throw new Error("real_money_confirmation_required");
    if (!positionId) throw new Error("missing_position_id");

    const supabase = getSupabaseAdmin({ noStore: true });
    const { data: position, error: positionError } = await supabase
      .from("live_positions")
      .select("id,source_position_id,mint,token_symbol,token_amount,status")
      .eq("id", positionId)
      .eq("status", "open")
      .single();
    if (positionError) throw positionError;

    const signalId = randomUUID();
    const { error } = await supabase.from("live_trade_signals").insert({
      id: signalId,
      strategy: "ai_discovery",
      source_position_id: position.source_position_id,
      mint: position.mint,
      token_symbol: position.token_symbol,
      side: "sell",
      requested_token_amount: position.token_amount,
      max_slippage_bps: 100,
      status: "pending",
      metadata: {
        source: "manual_live_dashboard",
        manual: true,
        exit_reason: "manual_dashboard_exit",
        requested_at: new Date().toISOString(),
      },
    });
    if (error) throw error;

    return NextResponse.redirect(new URL("/live?manual_sell_queued=1", request.url), 303);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not queue manual live sell";
    return NextResponse.redirect(
      new URL(`/live?manual_error=${encodeURIComponent(message)}`, request.url),
      303
    );
  }
}
