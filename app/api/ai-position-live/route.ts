import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { hasViewerAccess, unauthorized } from "@/lib/dashboardAuth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

const DEX_URL = "https://api.dexscreener.com/tokens/v1/solana";
const ENTRY_FRICTION_PCT = 0.6;
const EXIT_FRICTION_PCT = 0.6;
const HARD_STOP_PCT = -6;
const TAKE_PROFIT_PCT = 10;
const TRAIL_ARM_PCT = 6;
const TRAIL_DISTANCE_PCT = 4;
const MAX_HOLD_MS = 45 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;

function n(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function fetchExactPair(mint: string, pairAddress: string): Promise<any | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${DEX_URL}/${encodeURIComponent(mint)}`, {
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    const body = await response.json();
    const pairs = Array.isArray(body) ? body : [];
    return pairs.find(
      (item: any) =>
        item?.chainId === "solana" &&
        String(item?.pairAddress ?? "") === pairAddress &&
        String(item?.baseToken?.address ?? "") === mint
    ) ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET(request: NextRequest) {
  if (!hasViewerAccess(request)) return unauthorized("Viewer login required");

  const supabase = getSupabaseAdmin({ noStore: true });
  const { data: position, error: positionError } = await supabase
    .from("ai_discovery_positions")
    .select("*")
    .order("opened_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (positionError) {
    return NextResponse.json({ error: positionError.message }, { status: 500 });
  }

  if (!position) {
    return NextResponse.json(
      { open: false, generatedAt: new Date().toISOString() },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  const entryPrice = n(position.entry_price_usd);
  const pair = await fetchExactPair(String(position.mint), String(position.pair_address));
  const fetchedPrice = n(pair?.priceUsd, NaN);
  const currentPrice = Number.isFinite(fetchedPrice) && fetchedPrice > 0
    ? fetchedPrice
    : n(position.last_price_usd, entryPrice);
  const peakPrice = Math.max(n(position.peak_price_usd, entryPrice), currentPrice);
  const grossReturnPct = entryPrice > 0 ? ((currentPrice / entryPrice) - 1) * 100 : 0;
  const netReturnPct = grossReturnPct - ENTRY_FRICTION_PCT - EXIT_FRICTION_PCT;
  const peakReturnPct = entryPrice > 0 ? ((peakPrice / entryPrice) - 1) * 100 : 0;
  const trailingArmed = peakReturnPct >= TRAIL_ARM_PCT;
  const trailingFloorPrice = trailingArmed ? peakPrice * (1 - TRAIL_DISTANCE_PCT / 100) : null;
  const hardStopPrice = entryPrice * (1 + HARD_STOP_PCT / 100);
  const takeProfitPrice = entryPrice * (1 + TAKE_PROFIT_PCT / 100);
  const trailArmPrice = entryPrice * (1 + TRAIL_ARM_PCT / 100);
  const openedAtMs = Date.parse(String(position.opened_at));
  const maxHoldAt = new Date(openedAtMs + MAX_HOLD_MS).toISOString();
  const timeRemainingMs = Math.max(0, openedAtMs + MAX_HOLD_MS - Date.now());

  let exitStatus = "Waiting for the first automatic exit rule";
  if (grossReturnPct <= HARD_STOP_PCT) exitStatus = "Hard stop should execute";
  else if (grossReturnPct >= TAKE_PROFIT_PCT) exitStatus = "Take profit should execute";
  else if (trailingArmed && trailingFloorPrice !== null && currentPrice <= trailingFloorPrice) exitStatus = "Trailing stop should execute";
  else if (timeRemainingMs <= 0) exitStatus = "Maximum hold exit should execute";
  else if (trailingArmed) exitStatus = "Trailing stop is armed";

  const { data: rows, error: sampleError } = await supabase
    .from("ai_position_price_samples")
    .select("sampled_at,price_usd,peak_price_usd,gross_return_pct,net_return_pct,trailing_armed,trailing_floor_price_usd,source")
    .eq("position_id", position.position_id)
    .order("sampled_at", { ascending: true })
    .limit(400);

  const history = (sampleError ? [] : rows ?? []).map((row: any) => ({
    sampledAt: row.sampled_at,
    priceUsd: n(row.price_usd),
    peakPriceUsd: n(row.peak_price_usd),
    grossReturnPct: n(row.gross_return_pct),
    netReturnPct: n(row.net_return_pct),
    trailingArmed: Boolean(row.trailing_armed),
    trailingFloorPriceUsd: row.trailing_floor_price_usd == null ? null : n(row.trailing_floor_price_usd),
    source: row.source,
  }));

  if (!history.length || Math.abs(Date.parse(history[0].sampledAt) - openedAtMs) > 2_000) {
    history.unshift({
      sampledAt: position.opened_at,
      priceUsd: entryPrice,
      peakPriceUsd: entryPrice,
      grossReturnPct: 0,
      netReturnPct: -(ENTRY_FRICTION_PCT + EXIT_FRICTION_PCT),
      trailingArmed: false,
      trailingFloorPriceUsd: null,
      source: "entry",
    });
  }

  history.push({
    sampledAt: new Date().toISOString(),
    priceUsd: currentPrice,
    peakPriceUsd: peakPrice,
    grossReturnPct,
    netReturnPct,
    trailingArmed,
    trailingFloorPriceUsd: trailingFloorPrice,
    source: pair ? "dexscreener_live" : "database_fallback",
  });

  return NextResponse.json(
    {
      open: true,
      generatedAt: new Date().toISOString(),
      tokenSymbol: position.token_symbol,
      mint: position.mint,
      pairAddress: position.pair_address,
      positionId: position.position_id,
      openedAt: position.opened_at,
      entryPriceUsd: entryPrice,
      currentPriceUsd: currentPrice,
      peakPriceUsd: peakPrice,
      grossReturnPct,
      netReturnPct,
      sourcePnlSol: 0.2 * netReturnPct / 100,
      capitalPnlSol: 1 * netReturnPct / 100,
      liquidityUsd: n(pair?.liquidity?.usd),
      marketCapUsd: n(pair?.marketCap ?? pair?.fdv),
      priceChangeM5: n(pair?.priceChange?.m5),
      priceSource: pair ? "DexScreener live" : "Last worker price",
      links: {
        dexscreener: `https://dexscreener.com/solana/${encodeURIComponent(String(position.pair_address))}`,
        gmgn: `https://gmgn.ai/sol/token/${encodeURIComponent(String(position.mint))}`,
      },
      rules: {
        entryFrictionPct: ENTRY_FRICTION_PCT,
        exitFrictionPct: EXIT_FRICTION_PCT,
        hardStopPct: HARD_STOP_PCT,
        hardStopPriceUsd: hardStopPrice,
        takeProfitPct: TAKE_PROFIT_PCT,
        takeProfitPriceUsd: takeProfitPrice,
        trailArmPct: TRAIL_ARM_PCT,
        trailArmPriceUsd: trailArmPrice,
        trailDistancePct: TRAIL_DISTANCE_PCT,
        trailingArmed,
        trailingFloorPriceUsd: trailingFloorPrice,
        maxHoldMinutes: MAX_HOLD_MS / 60_000,
        maxHoldAt,
        timeRemainingMs,
        exitStatus,
      },
      history,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
