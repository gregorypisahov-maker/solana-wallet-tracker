import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { hasAdminAccess, hasViewerAccess, unauthorized } from "@/lib/dashboardAuth";
import {
  JUPITER_LITE_V1_BASE_URL,
  JUPITER_SWAP_V2_BASE_URL,
  LIVE_ORDER_TTL_SECONDS,
  SOL_DECIMALS,
  SOL_MINT,
  USDT_DECIMALS,
  USDT_MINT,
  finite,
  hasJupiterApiKey,
  isValidSolanaAddress,
  jupiterHeaders,
  toAtomic,
} from "@/lib/solSpotLive";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

async function fetchJson(url: string, init: RequestInit, timeoutMs = 15_000): Promise<{ response: Response; body: any }> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { response, body: await response.json().catch(() => ({})) };
}

async function buildManagedV2(input: {
  inputMint: string;
  outputMint: string;
  inputAmountAtomic: string;
  walletPublicKey: string;
}) {
  const params = new URLSearchParams({
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    amount: input.inputAmountAtomic,
    taker: input.walletPublicKey,
  });
  const { response, body } = await fetchJson(
    `${JUPITER_SWAP_V2_BASE_URL}/order?${params.toString()}`,
    { headers: jupiterHeaders() }
  );
  if (!response.ok || !body?.transaction || !body?.requestId) {
    const detail = body?.error ?? body?.message ?? `Jupiter HTTP ${response.status}`;
    throw new Error(String(detail).slice(0, 240));
  }
  return {
    transaction: body.transaction as string,
    requestId: String(body.requestId),
    inAmount: String(body.inAmount ?? input.inputAmountAtomic),
    outAmount: body.outAmount == null ? null : String(body.outAmount),
    otherAmountThreshold: body.otherAmountThreshold == null ? null : String(body.otherAmountThreshold),
    priceImpactPct: finite(body.priceImpactPct ?? body.priceImpact),
    router: body.router ?? null,
    mode: body.mode ?? null,
    feeBps: body.feeBps ?? body.platformFee?.feeBps ?? null,
    feeMint: body.feeMint ?? body.platformFee?.feeMint ?? null,
    lastValidBlockHeight: body.lastValidBlockHeight ?? null,
    executionMode: "jupiter_v2_managed",
  };
}

async function buildLiteV1(input: {
  inputMint: string;
  outputMint: string;
  inputAmountAtomic: string;
  walletPublicKey: string;
}) {
  const quoteParams = new URLSearchParams({
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    amount: input.inputAmountAtomic,
    slippageBps: "50",
    restrictIntermediateTokens: "true",
  });
  const quoteResult = await fetchJson(
    `${JUPITER_LITE_V1_BASE_URL}/quote?${quoteParams.toString()}`,
    { headers: {} }
  );
  const quote = quoteResult.body;
  if (!quoteResult.response.ok || !quote?.outAmount) {
    const detail = quote?.error ?? quote?.message ?? `Jupiter Lite quote HTTP ${quoteResult.response.status}`;
    throw new Error(String(detail).slice(0, 240));
  }

  const swapResult = await fetchJson(
    `${JUPITER_LITE_V1_BASE_URL}/swap`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: input.walletPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: {
          priorityLevelWithMaxLamports: {
            priorityLevel: "high",
            maxLamports: 500_000,
            global: false,
          },
        },
      }),
    }
  );
  const swap = swapResult.body;
  if (!swapResult.response.ok || !swap?.swapTransaction) {
    const detail = swap?.error ?? swap?.message ?? `Jupiter Lite swap HTTP ${swapResult.response.status}`;
    throw new Error(String(detail).slice(0, 240));
  }
  if (swap?.simulationError) {
    throw new Error(`Jupiter Lite simulation failed: ${JSON.stringify(swap.simulationError).slice(0, 180)}`);
  }

  return {
    transaction: String(swap.swapTransaction),
    requestId: `lite-${randomUUID()}`,
    inAmount: String(quote.inAmount ?? input.inputAmountAtomic),
    outAmount: String(quote.outAmount),
    otherAmountThreshold: quote.otherAmountThreshold == null ? null : String(quote.otherAmountThreshold),
    priceImpactPct: finite(quote.priceImpactPct),
    router: "metis_lite_v1",
    mode: quote.swapMode ?? "ExactIn",
    feeBps: quote.platformFee?.feeBps ?? null,
    feeMint: null,
    lastValidBlockHeight: swap.lastValidBlockHeight ?? null,
    executionMode: "rpc_v1_lite",
  };
}

export async function POST(request: NextRequest) {
  if (!hasViewerAccess(request)) return unauthorized("Viewer login required");
  if (!hasAdminAccess(request)) return unauthorized("Owner password required");

  const body = await request.json().catch(() => ({}));
  const side = String(body.side ?? "").toLowerCase();
  const walletPublicKey = String(body.walletPublicKey ?? "").trim();
  if (!["buy", "sell"].includes(side)) {
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

  let prepared: Awaited<ReturnType<typeof buildManagedV2>>;
  try {
    prepared = hasJupiterApiKey()
      ? await buildManagedV2({ inputMint, outputMint, inputAmountAtomic, walletPublicKey })
      : await buildLiteV1({ inputMint, outputMint, inputAmountAtomic, walletPublicKey });
  } catch (error) {
    console.error("[sol-spot-live-order] Jupiter build failed", error);
    return NextResponse.json(
      { error: `Could not prepare real swap: ${error instanceof Error ? error.message : String(error)}` },
      { status: 502 }
    );
  }

  const maximumImpactPct = finite(settings.max_price_impact_pct);
  if (prepared.priceImpactPct > maximumImpactPct) {
    return NextResponse.json(
      {
        error: `Price impact ${prepared.priceImpactPct.toFixed(4)}% exceeds the ${maximumImpactPct.toFixed(2)}% safety cap`,
      },
      { status: 409 }
    );
  }

  const orderId = randomUUID();
  const expiresAt = new Date(Date.now() + LIVE_ORDER_TTL_SECONDS * 1000).toISOString();
  const safeQuote = {
    inAmount: prepared.inAmount,
    outAmount: prepared.outAmount,
    otherAmountThreshold: prepared.otherAmountThreshold,
    priceImpactPct: prepared.priceImpactPct,
    router: prepared.router,
    mode: prepared.mode,
    feeBps: prepared.feeBps,
    feeMint: prepared.feeMint,
    lastValidBlockHeight: prepared.lastValidBlockHeight,
    executionMode: prepared.executionMode,
  };

  const { error: insertError } = await supabase.from("sol_spot_live_orders").insert({
    order_id: orderId,
    request_id: prepared.requestId,
    wallet_public_key: walletPublicKey,
    side,
    status: "pending_signature",
    input_mint: inputMint,
    output_mint: outputMint,
    input_amount_atomic: inputAmountAtomic,
    quoted_output_amount_atomic: prepared.outAmount,
    price_impact_pct: prepared.priceImpactPct,
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
      requestId: prepared.requestId,
      transaction: prepared.transaction,
      side,
      expiresAt,
      quote: safeQuote,
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}
