import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  extractTradesFromEnhancedTransaction,
  HeliusEnhancedTransaction,
  isValidHeliusWebhookAuthorization,
} from "@/lib/heliusWebhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

function boundedNumber(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, parsed))
    : fallback;
}

const MAX_TRADE_AGE_MS =
  boundedNumber(process.env.MAX_TRADE_AGE_SECONDS, 120, 30, 3_600) * 1_000;
const MIN_TRACKED_TRADE_SOL = boundedNumber(
  process.env.MIN_TRACKED_TRADE_SOL,
  0.01,
  0,
  100
);
const SCALP_WINDOW_MINUTES = Math.floor(
  boundedNumber(process.env.SCALP_WINDOW_MINUTES, 5, 1, 60)
);

export async function POST(request: NextRequest) {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (
    !serviceRoleKey ||
    !isValidHeliusWebhookAuthorization(
      request.headers.get("authorization"),
      serviceRoleKey
    )
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!Array.isArray(payload) || payload.length > 500) {
    return NextResponse.json({ error: "Invalid webhook batch" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin({ noStore: true });
  const { data: wallets, error: walletError } = await supabase
    .from("wallets")
    .select("address")
    .eq("active", true);
  if (walletError) {
    console.error("[helius-webhook] Failed to load active wallets", walletError);
    return NextResponse.json({ error: "Database unavailable" }, { status: 500 });
  }

  const activeWallets = new Set((wallets ?? []).map((wallet) => wallet.address));
  const candidates = (payload as HeliusEnhancedTransaction[])
    .flatMap((transaction) =>
      extractTradesFromEnhancedTransaction(transaction, activeWallets)
    )
    .filter(({ trade }) => {
      const ageMs = Date.now() - trade.txTime.getTime();
      return (
        ageMs >= -30_000 &&
        ageMs <= MAX_TRADE_AGE_MS &&
        trade.solAmount >= MIN_TRACKED_TRADE_SOL
      );
    })
    .sort((left, right) => left.trade.txTime.getTime() - right.trade.txTime.getTime());

  let storedTrades = 0;
  for (const { walletAddress, trade } of candidates) {
    const { data, error } = await supabase.rpc("ingest_wallet_trade", {
      p_wallet_address: walletAddress,
      p_signature: trade.signature,
      p_token_mint: trade.tokenMint,
      p_side: trade.side,
      p_sol_amount: trade.solAmount,
      p_token_amount: trade.tokenAmount,
      p_tx_time: trade.txTime.toISOString(),
      p_scalp_window_minutes: SCALP_WINDOW_MINUTES,
    });
    if (error) {
      console.error("[helius-webhook] Failed to ingest trade", error);
      return NextResponse.json({ error: "Trade ingest failed" }, { status: 500 });
    }

    const result = Array.isArray(data) ? data[0] : data;
    if (result?.inserted) storedTrades += 1;
  }

  const { error: usageError } = await supabase.rpc(
    "record_helius_webhook_batch",
    {
      p_events: payload.length,
      p_stored_trades: storedTrades,
    }
  );
  if (usageError) {
    // A telemetry failure must not make Helius redeliver successfully stored
    // swaps. The trade upsert is already idempotent, but retries still cost.
    console.error("[helius-webhook] Failed to record usage", usageError);
  }

  return NextResponse.json({ received: payload.length, storedTrades });
}

export async function GET() {
  return NextResponse.json({ ok: true, mode: "enhanced-swap-webhook" });
}
