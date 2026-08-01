import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { hasAdminAccess, hasViewerAccess, unauthorized } from "@/lib/dashboardAuth";
import {
  JUPITER_SWAP_BASE_URL,
  LIVE_ORDER_TTL_SECONDS,
  SOL_DECIMALS,
  SOL_MINT,
  USDT_DECIMALS,
  USDT_MINT,
  finite,
  isValidSolanaAddress,
  jupiterHeaders,
  toAtomic,
} from "@/lib/solSpotLive";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export async function POST(request: NextRequest) {
  if (!hasViewerAccess(request)) return unauthorized("Viewer login required");
  if (!hasAdminAccess(request)) return unauthorized("Owner password required");

  const body = await request.json().catch(() => ({}));
  const side = String(body.side ?? "").toLowerCase();
  const walletPublicKey = String(body.walletPublicKey ?? "").trim();
  if (!['buy', 'sell'].includes(side)) {
    return NextResponse.json({ error: "Side must be buy or sell" }, { status: 400 });
  }
  if (!isValidSolanaAddress(walletPublicKey)) {
    return NextResponse.json({ error: "Invalid connected wallet" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin({ noStore: true });
  const [settingsResult, livePositionResult, paperPositionResult, pendingResult] = await Promise.all([
    supabase.from("sol_spot_live_settings").select("*").eq("id", 1).single(),
    supabase.from("sol_spot_live_positions").select("*").eq("id", 1).maybeSingle(),
    supabase.from("sol_spot_paper_positions").select("position_id").maybeSingle(),
    supabase
      .from("sol_spot_live_orders")
      .select("order_id,expires_at")
      .eq("wallet_public_key", walletPublicKey)
      .eq("side", side)
      .eq("status", "pending_signature")
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const failed = [settingsResult, livePositionResult, paperPositionResult, pendingResult]
    .find((result) => result.error);
  if (failed?.error) {
    console.error("[sol-spot-live-order] state query failed", failed.error);
    return NextResponse.json({ error: "Could not validate live order state" }, { status: 500 });
  }

  const settings = settingsResult.data;
  const livePosition = livePositionResult.data ?? null;
  const paperPosition = paperPositionResult.data ?? null;
  if (!settings.wallet_public_key || settings.wallet_public_key !== walletPublicKey) {
    return NextResponse.json({ error: "Connected wallet is not the linked wallet" }, { status: 409 });
  }
  if (pendingResult.data) {
    return NextResponse.json(
      { error: "A wallet approval is already pending. Refresh the dashboard and try again." },
      { status: 409 }
    );
  }

  const armed =
    settings.armed === true &&
    settings.armed_until &&
    Date.parse(settings.armed_until) > Date.now();

  let inputMint: string;
  let outputMint: string;
  let inputAmountAtomic: string;
  let paperPositionId: string | null = paperPosition?.position_id ?? null;

  if (side === "buy") {
    if (!armed) {
      return NextResponse.json({ error: "Real execution is not armed" }, { status: 409 });
    }
    if (!paperPosition) {
      return NextResponse.json(
        { error: "The SOL paper strategy has no open entry to mirror" },
        { status: 409 }
      );
    }
    if (livePosition) {
      return NextResponse.json({ error: "A real SOL position is already tracked" }, { status: 409 });
    }
    inputMint = USDT_MINT;
    outputMint = SOL_MINT;
    inputAmountAtomic = toAtomic(finite(settings.max_position_usdt), USDT_DECIMALS);
  } else {
    if (!livePosition) {
      return NextResponse.json({ error: "No tracked real SOL position to sell" }, { status: 409 });
    }
    if (livePosition.wallet_public_key !== walletPublicKey) {
      return NextResponse.json({ error: "Tracked position belongs to another wallet" }, { status: 409 });
    }
    inputMint = SOL_MINT;
    outputMint = USDT_MINT;
    inputAmountAtomic = toAtomic(finite(livePosition.quantity_sol), SOL_DECIMALS);
    paperPositionId = livePosition.paper_position_id ?? paperPositionId;
  }

  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: inputAmountAtomic,
    taker: walletPublicKey,
  });

  let jupiterResponse: Response;
  try {
    jupiterResponse = await fetch(`${JUPITER_SWAP_BASE_URL}/order?${params.toString()}`, {
      headers: jupiterHeaders(),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    console.error("[sol-spot-live-order] Jupiter request failed", error);
    return NextResponse.json({ error: "Jupiter market route is unavailable" }, { status: 502 });
  }

  const order = await jupiterResponse.json().catch(() => ({}));
  if (!jupiterResponse.ok || !order?.transaction || !order?.requestId) {
    console.error("[sol-spot-live-order] Jupiter rejected order", jupiterResponse.status, order);
    const detail = order?.error ?? order?.message ?? `Jupiter HTTP ${jupiterResponse.status}`;
    return NextResponse.json(
      { error: `Could not prepare real swap: ${String(detail).slice(0, 240)}` },
      { status: 502 }
    );
  }

  const priceImpactPct = finite(order.priceImpactPct ?? order.priceImpact);
  const maximumImpactPct = finite(settings.max_price_impact_pct);
  if (priceImpactPct > maximumImpactPct) {
    return NextResponse.json(
      {
        error: `Price impact ${priceImpactPct.toFixed(4)}% exceeds the ${maximumImpactPct.toFixed(2)}% safety cap`,
      },
      { status: 409 }
    );
  }

  const orderId = randomUUID();
  const expiresAt = new Date(Date.now() + LIVE_ORDER_TTL_SECONDS * 1000).toISOString();
  const safeQuote = {
    inAmount: order.inAmount ?? inputAmountAtomic,
    outAmount: order.outAmount ?? null,
    otherAmountThreshold: order.otherAmountThreshold ?? null,
    priceImpactPct,
    router: order.router ?? null,
    mode: order.mode ?? null,
    feeBps: order.feeBps ?? order.platformFee?.feeBps ?? null,
    feeMint: order.feeMint ?? order.platformFee?.feeMint ?? null,
    lastValidBlockHeight: order.lastValidBlockHeight ?? null,
  };

  const { error: insertError } = await supabase.from("sol_spot_live_orders").insert({
    order_id: orderId,
    request_id: order.requestId,
    wallet_public_key: walletPublicKey,
    side,
    status: "pending_signature",
    input_mint: inputMint,
    output_mint: outputMint,
    input_amount_atomic: inputAmountAtomic,
    quoted_output_amount_atomic: order.outAmount ?? null,
    price_impact_pct: priceImpactPct,
    paper_position_id: paperPositionId,
    expires_at: expiresAt,
    result: { quote: safeQuote },
  });
  if (insertError) {
    console.error("[sol-spot-live-order] order insert failed", insertError);
    return NextResponse.json({ error: "Could not reserve the live order" }, { status: 500 });
  }

  return NextResponse.json(
    {
      ok: true,
      orderId,
      requestId: order.requestId,
      transaction: order.transaction,
      side,
      expiresAt,
      quote: safeQuote,
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}
