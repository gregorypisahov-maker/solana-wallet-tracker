import { NextRequest, NextResponse } from "next/server";
import { VersionedTransaction } from "@solana/web3.js";
import { getSupabaseAdmin } from "@/lib/supabase";
import { hasViewerAccess, unauthorized } from "@/lib/dashboardAuth";
import { JUPITER_SWAP_BASE_URL, finite, jupiterHeaders } from "@/lib/solSpotLive";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export async function POST(request: NextRequest) {
  if (!hasViewerAccess(request)) return unauthorized("Viewer login required");

  const body = await request.json().catch(() => ({}));
  const orderId = String(body.orderId ?? "").trim();
  const requestId = String(body.requestId ?? "").trim();
  const signedTransaction = String(body.signedTransaction ?? "").trim();
  if (!orderId || !requestId || !signedTransaction || signedTransaction.length > 100_000) {
    return NextResponse.json({ error: "Invalid signed live order" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin({ noStore: true });
  const { data: order, error: orderError } = await supabase
    .from("sol_spot_live_orders")
    .select("*")
    .eq("order_id", orderId)
    .single();
  if (orderError || !order) {
    return NextResponse.json({ error: "Live order was not found" }, { status: 404 });
  }
  if (order.request_id !== requestId) {
    return NextResponse.json({ error: "Live order request mismatch" }, { status: 409 });
  }
  if (order.status === "success") {
    return NextResponse.json({ ok: true, idempotent: true, result: order.result });
  }
  if (order.status !== "pending_signature") {
    return NextResponse.json({ error: `Live order is ${order.status}` }, { status: 409 });
  }
  if (Date.parse(order.expires_at) <= Date.now()) {
    await supabase
      .from("sol_spot_live_orders")
      .update({ status: "expired", error: "wallet_approval_expired", executed_at: new Date().toISOString() })
      .eq("order_id", orderId);
    return NextResponse.json({ error: "Wallet approval expired; prepare a new order" }, { status: 409 });
  }

  try {
    const transaction = VersionedTransaction.deserialize(Buffer.from(signedTransaction, "base64"));
    const payer = transaction.message.staticAccountKeys[0]?.toBase58();
    const signature = transaction.signatures[0];
    const hasSignature = signature && signature.some((byte) => byte !== 0);
    if (payer !== order.wallet_public_key || !hasSignature) {
      return NextResponse.json(
        { error: "Transaction was not signed by the linked wallet" },
        { status: 409 }
      );
    }
  } catch (error) {
    console.error("[sol-spot-live-execute] signed transaction decode failed", error);
    return NextResponse.json({ error: "Wallet returned an invalid transaction" }, { status: 400 });
  }

  const executeBody: Record<string, unknown> = { signedTransaction, requestId };
  const lastValidBlockHeight = order.result?.quote?.lastValidBlockHeight;
  if (lastValidBlockHeight != null) executeBody.lastValidBlockHeight = String(lastValidBlockHeight);

  let response: Response;
  try {
    response = await fetch(`${JUPITER_SWAP_BASE_URL}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...jupiterHeaders() },
      body: JSON.stringify(executeBody),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    console.error("[sol-spot-live-execute] Jupiter execute request failed", error);
    return NextResponse.json(
      { error: "Jupiter could not submit the signed transaction; check the wallet before retrying" },
      { status: 502 }
    );
  }

  const result = await response.json().catch(() => ({}));
  const success = response.ok && result?.status === "Success" && result?.signature;
  if (!success) {
    const errorText = String(
      result?.error ?? result?.message ?? `Jupiter execute HTTP ${response.status}`
    ).slice(0, 500);
    await supabase
      .from("sol_spot_live_orders")
      .update({
        status: "failed",
        error: errorText,
        result: { ...(order.result ?? {}), execution: result },
        executed_at: new Date().toISOString(),
      })
      .eq("order_id", orderId);
    return NextResponse.json({ error: `Real swap failed: ${errorText}`, result }, { status: 502 });
  }

  const actualInputAmountAtomic = finite(result.inputAmountResult ?? result.totalInputAmount);
  const actualOutputAmountAtomic = finite(result.outputAmountResult ?? result.totalOutputAmount);
  if (actualInputAmountAtomic <= 0 || actualOutputAmountAtomic <= 0) {
    return NextResponse.json(
      { error: "Swap confirmed but Jupiter returned invalid execution amounts; inspect the signature" },
      { status: 502 }
    );
  }

  const mergedResult = { ...(order.result ?? {}), execution: result };
  const { data: applied, error: applyError } = await supabase.rpc(
    "sol_spot_apply_live_execution",
    {
      p_order_id: orderId,
      p_signature: result.signature,
      p_actual_input_amount_atomic: String(actualInputAmountAtomic),
      p_actual_output_amount_atomic: String(actualOutputAmountAtomic),
      p_result: mergedResult,
    }
  );
  if (applyError) {
    console.error("[sol-spot-live-execute] ledger apply failed", applyError);
    return NextResponse.json(
      {
        error: "Swap succeeded on-chain but the local ledger needs reconciliation",
        signature: result.signature,
      },
      { status: 500 }
    );
  }

  return NextResponse.json(
    {
      ok: true,
      side: order.side,
      signature: result.signature,
      explorerUrl: `https://solscan.io/tx/${result.signature}`,
      execution: result,
      ledger: applied,
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}
