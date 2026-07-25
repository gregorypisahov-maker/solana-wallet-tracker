import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { hasAdminAccess, hasViewerAccess, unauthorized } from "@/lib/dashboardAuth";
import { sendTelegramAlert } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

const DEX_URL = "https://api.dexscreener.com/tokens/v1/solana";
const REQUEST_TIMEOUT_MS = 12_000;

type SourcePosition = {
  position_id: string;
  mint: string;
  token_symbol: string;
  pair_address: string;
  entry_price_usd: number | string;
};

function n(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function exactMarket(position: SourcePosition) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${DEX_URL}/${encodeURIComponent(position.mint)}`, {
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const payload = await response.json();
    const pairs = Array.isArray(payload) ? payload : [];
    const pair = pairs.find(
      (item: any) =>
        item?.chainId === "solana" &&
        String(item?.pairAddress ?? "") === position.pair_address &&
        String(item?.baseToken?.address ?? "") === position.mint
    );
    if (!pair) return null;
    const priceUsd = n(pair?.priceUsd, NaN);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;
    return {
      priceUsd,
      pairAddress: position.pair_address,
      liquidityUsd: n(pair?.liquidity?.usd),
      marketCapUsd: n(pair?.marketCap ?? pair?.fdv),
      changeM5: n(pair?.priceChange?.m5),
      fetchedAt: new Date().toISOString(),
      source: "dexscreener_exact_pair",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function POST(request: NextRequest) {
  if (!hasViewerAccess(request)) return unauthorized("Viewer login required");
  if (!hasAdminAccess(request)) return unauthorized("Owner password required");

  const supabase = getSupabaseAdmin({ noStore: true });
  const { data: positions, error: positionError } = await supabase
    .from("ai_discovery_positions")
    .select("position_id,mint,token_symbol,pair_address,entry_price_usd")
    .order("opened_at", { ascending: true })
    .limit(1);

  if (positionError) {
    console.error("[ai-manual-close] position lookup failed", positionError);
    return NextResponse.json({ error: positionError.message }, { status: 500 });
  }
  const position = positions?.[0] as SourcePosition | undefined;
  if (!position) {
    return NextResponse.json({ error: "There is no open AI paper position to sell." }, { status: 409 });
  }

  let market;
  try {
    market = await exactMarket(position);
  } catch (error) {
    console.error("[ai-manual-close] live price request failed", error);
    return NextResponse.json(
      { error: "Live price is unavailable. Nothing was closed; try again in a few seconds." },
      { status: 503 }
    );
  }
  if (!market) {
    return NextResponse.json(
      { error: "The exact live trading pair could not be priced. Nothing was closed." },
      { status: 503 }
    );
  }

  const closedAt = new Date().toISOString();
  const { data, error } = await supabase.rpc("manual_close_ai_paper_positions", {
    p_exit_price_usd: market.priceUsd,
    p_market_snapshot: market,
    p_closed_at: closedAt,
  });

  if (error) {
    console.error("[ai-manual-close] database close failed", error);
    return NextResponse.json({ error: `Manual paper sell failed: ${error.message}` }, { status: 500 });
  }
  const result = (data ?? {}) as Record<string, any>;
  if (result.ok !== true) {
    return NextResponse.json(
      { error: result.error === "already_closed" ? "The trade was already closed." : "No open AI paper position was found." },
      { status: 409 }
    );
  }

  const sourcePnl = n(result.sourcePnlSol);
  const capitalPnl = result.capitalClosed ? n(result.capitalPnlSol) : null;
  await sendTelegramAlert([
    "🛑 <b>MANUAL AI PAPER SELL</b>",
    "",
    `Token: <b>${String(result.tokenSymbol ?? position.token_symbol)}</b>`,
    `Exit price: <b>$${market.priceUsd.toPrecision(7)}</b>`,
    `Net return: <b>${n(result.netReturnPct) >= 0 ? "+" : ""}${n(result.netReturnPct).toFixed(2)}%</b>`,
    `AI Discovery PnL: <b>${sourcePnl >= 0 ? "+" : ""}${sourcePnl.toFixed(5)} SOL</b>`,
    capitalPnl === null
      ? "AI Capital: no matching open mirror"
      : `AI Capital PnL: <b>${capitalPnl >= 0 ? "+" : ""}${capitalPnl.toFixed(5)} SOL</b>`,
    "",
    "🧪 Paper positions only — no real SOL was sold.",
  ].join("\n"));

  return NextResponse.json(
    { ok: true, ...result, exitPriceUsd: market.priceUsd, closedAt },
    { headers: { "Cache-Control": "no-store" } }
  );
}
