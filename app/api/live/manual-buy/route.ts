import { randomUUID, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

function sameSecret(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function extractMint(value: string): string {
  const trimmed = value.trim();
  const matches = trimmed.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g);
  return matches?.at(-1) ?? "";
}

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const secret = String(form.get("secret") ?? "");
    const expectedSecret = process.env.LIVE_MANUAL_TRADE_KEY ?? "";
    if (!expectedSecret || !sameSecret(secret, expectedSecret)) {
      throw new Error("invalid_manual_trade_key");
    }

    const mint = extractMint(String(form.get("mint") ?? ""));
    const tokenSymbol = String(form.get("token_symbol") ?? "").trim().slice(0, 24) || null;
    const sizeSol = Number(form.get("size_sol"));
    const slippageBps = Number(form.get("slippage_bps") ?? 100);
    const confirmed = form.get("confirm_real_money") === "yes";

    if (!confirmed) throw new Error("real_money_confirmation_required");
    if (!mint || mint.length < 32) throw new Error("invalid_token_mint");
    if (!Number.isFinite(sizeSol) || sizeSol <= 0) throw new Error("invalid_position_size");
    if (!Number.isInteger(slippageBps) || slippageBps < 10 || slippageBps > 200) {
      throw new Error("slippage_out_of_bounds");
    }

    const supabase = getSupabaseAdmin({ noStore: true });
    const { data: state, error: stateError } = await supabase
      .from("live_executor_state")
      .select("enabled,halted,max_position_sol")
      .eq("id", 1)
      .single();
    if (stateError) throw stateError;
    if (!state.enabled || state.halted) throw new Error("live_executor_not_running");

    const maxPositionSol = Number(state.max_position_sol);
    if (sizeSol > maxPositionSol) {
      throw new Error(`position_size_above_live_limit:${maxPositionSol}`);
    }

    const signalId = randomUUID();
    const sourcePositionId = `manual:${signalId}`;
    const { error } = await supabase.from("live_trade_signals").insert({
      id: signalId,
      strategy: "ai_discovery",
      source_position_id: sourcePositionId,
      mint,
      token_symbol: tokenSymbol,
      side: "buy",
      requested_size_sol: sizeSol,
      max_slippage_bps: slippageBps,
      status: "pending",
      metadata: {
        source: "manual_live_dashboard",
        manual: true,
        requested_at: new Date().toISOString(),
      },
    });
    if (error) throw error;

    return NextResponse.redirect(new URL("/live?manual_buy_queued=1", request.url), 303);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not queue manual live buy";
    return NextResponse.redirect(
      new URL(`/live?manual_error=${encodeURIComponent(message)}`, request.url),
      303
    );
  }
}
