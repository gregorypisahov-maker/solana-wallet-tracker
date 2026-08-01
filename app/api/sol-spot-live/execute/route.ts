import { NextRequest, NextResponse } from "next/server";
import { Connection, VersionedTransaction } from "@solana/web3.js";
import { getSupabaseAdmin } from "@/lib/supabase";
import { hasViewerAccess, unauthorized } from "@/lib/dashboardAuth";
import {
  JUPITER_SWAP_V2_BASE_URL,
  SOL_MINT,
  USDT_MINT,
  getLiveRpcUrl,
  jupiterHeaders,
} from "@/lib/solSpotLive";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

function positiveAtomic(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  try {
    return BigInt(text) > 0n ? text : null;
  } catch {
    return null;
  }
}

function atomicDelta(
  balances: any[] | null | undefined,
  walletPublicKey: string,
  mint: string
): bigint {
  return (balances ?? []).reduce((total, row) => {
    if (row?.owner !== walletPublicKey || row?.mint !== mint) return total;
    const amount = String(row?.uiTokenAmount?.amount ?? "0");
    return /^\d+$/.test(amount) ? total + BigInt(amount) : total;
  }, 0n);
}

async function executeManagedV2(input: {
  signedTransaction: string;
  requestId: string;
  lastValidBlockHeight: unknown;
}) {
  const executeBody: Record<string, unknown> = {
    signedTransaction: input.signedTransaction,
    requestId: input.requestId,
  };
  if (input.lastValidBlockHeight != null) {
    executeBody.lastValidBlockHeight = String(input.lastValidBlockHeight);
  }

  const response = await fetch(`${JUPITER_SWAP_V2_BASE_URL}/execute`, {
    method: "POST",
    headers: jupiterHeaders(true),
    body: JSON.stringify(executeBody),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result?.status !== "Success" || !result?.signature) {
    const detail = result?.error ?? result?.message ?? `Jupiter execute HTTP ${response.status}`;
    throw new Error(String(detail).slice(0, 500));
  }
  return result;
}

async function executeLiteRpc(input: {
  transaction: VersionedTransaction;
  transactionBinary: Uint8Array;
  walletPublicKey: string;
  side: "buy" | "sell";
  inputAmountAtomic: string;
  quotedOutputAmountAtomic: string | null;
  lastValidBlockHeight: unknown;
}) {
  const connection = new Connection(getLiveRpcUrl(), "confirmed");
  let signature = "";
  try {
    signature = await connection.sendRawTransaction(input.transactionBinary, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 3,
    });

    const lastValidBlockHeight = Number(input.lastValidBlockHeight);
    if (Number.isSafeInteger(lastValidBlockHeight) && lastValidBlockHeight > 0) {
      const confirmation = await connection.confirmTransaction(
        {
          signature,
          blockhash: input.transaction.message.recentBlockhash,
          lastValidBlockHeight,
        },
        "confirmed"
      );
      if (confirmation.value.err) {
        throw new Error(`Solana transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }
    } else {
      const confirmation = await connection.confirmTransaction(signature, "confirmed");
      if (confirmation.value.err) {
        throw new Error(`Solana transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }
    }

    const landed = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!landed?.meta || landed.meta.err) {
      throw new Error(
        landed?.meta?.err
          ? `Solana transaction failed: ${JSON.stringify(landed.meta.err)}`
          : "Confirmed transaction details are unavailable"
      );
    }

    const preUsdt = atomicDelta(landed.meta.preTokenBalances, input.walletPublicKey, USDT_MINT);
    const postUsdt = atomicDelta(landed.meta.postTokenBalances, input.walletPublicKey, USDT_MINT);
    const usdtDelta = postUsdt - preUsdt;
    const preLamports = BigInt(landed.meta.preBalances?.[0] ?? 0);
    const postLamports = BigInt(landed.meta.postBalances?.[0] ?? 0);
    const feeLamports = BigInt(landed.meta.fee ?? 0);
    const nativeDeltaExcludingFee = postLamports - preLamports + feeLamports;

    let actualInputAmountAtomic: string | null;
    let actualOutputAmountAtomic: string | null;
    if (input.side === "buy") {
      actualInputAmountAtomic = usdtDelta < 0n ? (-usdtDelta).toString() : input.inputAmountAtomic;
      actualOutputAmountAtomic =
        nativeDeltaExcludingFee > 0n
          ? nativeDeltaExcludingFee.toString()
          : input.quotedOutputAmountAtomic;
    } else {
      actualInputAmountAtomic = input.inputAmountAtomic;
      actualOutputAmountAtomic = usdtDelta > 0n ? usdtDelta.toString() : input.quotedOutputAmountAtomic;
    }

    if (!positiveAtomic(actualInputAmountAtomic) || !positiveAtomic(actualOutputAmountAtomic)) {
      throw new Error("Confirmed swap amounts could not be reconciled");
    }

    return {
      status: "Success",
      signature,
      inputAmountResult: actualInputAmountAtomic,
      outputAmountResult: actualOutputAmountAtomic,
      executionMode: "rpc_v1_lite",
      slot: landed.slot,
      feeLamports: Number(feeLamports),
      inputMint: input.side === "buy" ? USDT_MINT : SOL_MINT,
      outputMint: input.side === "buy" ? SOL_MINT : USDT_MINT,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(signature ? `Transaction ${signature} submitted but not reconciled: ${detail}` : detail);
  }
}

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

  let transaction: VersionedTransaction;
  let transactionBinary: Uint8Array;
  try {
    transactionBinary = Uint8Array.from(Buffer.from(signedTransaction, "base64"));
    transaction = VersionedTransaction.deserialize(transactionBinary);
    const payer = transaction.message.staticAccountKeys[0]?.toBase58();
    const signature = transaction.signatures[0];
    const hasSignature = Boolean(signature?.some((byte) => byte !== 0));
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

  const executionMode = String(order.result?.quote?.executionMode ?? "jupiter_v2_managed");
  let result: any;
  try {
    result = executionMode === "rpc_v1_lite"
      ? await executeLiteRpc({
          transaction,
          transactionBinary,
          walletPublicKey: order.wallet_public_key,
          side: order.side,
          inputAmountAtomic: String(order.input_amount_atomic),
          quotedOutputAmountAtomic: order.quoted_output_amount_atomic == null
            ? null
            : String(order.quoted_output_amount_atomic),
          lastValidBlockHeight: order.result?.quote?.lastValidBlockHeight,
        })
      : await executeManagedV2({
          signedTransaction,
          requestId,
          lastValidBlockHeight: order.result?.quote?.lastValidBlockHeight,
        });
  } catch (error) {
    const errorText = String(error instanceof Error ? error.message : error).slice(0, 500);
    const mayHaveLanded = /Transaction [1-9A-HJ-NP-Za-km-z]+ submitted but not reconciled/.test(errorText);
    if (!mayHaveLanded) {
      await supabase
        .from("sol_spot_live_orders")
        .update({
          status: "failed",
          error: errorText,
          result: { ...(order.result ?? {}), execution: { error: errorText, executionMode } },
          executed_at: new Date().toISOString(),
        })
        .eq("order_id", orderId);
    }
    return NextResponse.json(
      { error: `Real swap failed: ${errorText}`, reconciliationRequired: mayHaveLanded },
      { status: 502 }
    );
  }

  const actualInputAmountAtomic = positiveAtomic(
    result.inputAmountResult ?? result.totalInputAmount
  );
  const actualOutputAmountAtomic = positiveAtomic(
    result.outputAmountResult ?? result.totalOutputAmount
  );
  if (!actualInputAmountAtomic || !actualOutputAmountAtomic) {
    return NextResponse.json(
      {
        error: "Swap confirmed but execution amounts could not be reconciled; inspect the signature",
        signature: result.signature,
      },
      { status: 502 }
    );
  }

  const mergedResult = { ...(order.result ?? {}), execution: result };
  const { data: applied, error: applyError } = await supabase.rpc(
    "sol_spot_apply_live_execution",
    {
      p_order_id: orderId,
      p_signature: result.signature,
      p_actual_input_amount_atomic: actualInputAmountAtomic,
      p_actual_output_amount_atomic: actualOutputAmountAtomic,
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
