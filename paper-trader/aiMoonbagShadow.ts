import { getSupabaseAdmin } from "../lib/supabase";
import { sendTelegramAlert } from "../lib/telegram";

// Completely isolated paper-only experiment. It observes completed AI discovery
// trades and calculates what an 85% normal exit + 15% uncapped moonbag would
// have produced. It never changes source positions, source trades, bankrolls,
// live_positions, or wallet execution.
const supabase = getSupabaseAdmin();
const VERSION = "ai_moonbag_shadow_v1_2026_07_28";
const ENABLED = process.env.PAPER_MOONBAG_SHADOW_ENABLED === "true";
const RETAINED_FRACTION = Math.min(
  0.25,
  Math.max(0.05, Number(process.env.PAPER_MOONBAG_RETAINED_FRACTION) || 0.15)
);
const TRAIL_ARM_MULTIPLE = Math.max(
  1.25,
  Number(process.env.PAPER_MOONBAG_TRAIL_ARM_MULTIPLE) || 2
);
const TRAIL_DISTANCE_PCT = Math.min(
  80,
  Math.max(10, Number(process.env.PAPER_MOONBAG_TRAIL_DISTANCE_PCT) || 35)
);
const RETENTION_FLOOR_PCT = Math.min(
  95,
  Math.max(30, Number(process.env.PAPER_MOONBAG_RETENTION_FLOOR_PCT) || 70)
);
const MAX_HOLD_MS = Math.max(
  60 * 60_000,
  Number(process.env.PAPER_MOONBAG_MAX_HOLD_MS) || 7 * 24 * 60 * 60_000
);
const LOOP_MS = Math.max(30_000, Number(process.env.PAPER_MOONBAG_LOOP_MS) || 60_000);
const DEX_URL = "https://api.dexscreener.com/tokens/v1/solana";
let running = false;

type SourceTrade = {
  id: string;
  position_id: string;
  mint: string;
  token_symbol: string;
  pair_address: string;
  entry_price_usd: number | string;
  exit_price_usd: number | string;
  size_sol: number | string;
  proceeds_sol: number | string;
  net_return_pct: number | string;
  exit_reason: string;
  opened_at: string;
  closed_at: string;
};

type ShadowPosition = {
  id: string;
  source_trade_id: string;
  source_position_id: string;
  mint: string;
  token_symbol: string;
  pair_address: string;
  original_entry_price_usd: number | string;
  retention_started_price_usd: number | string;
  last_price_usd: number | string;
  peak_price_usd: number | string;
  source_size_sol: number | string;
  retained_fraction: number | string;
  retained_cost_sol: number | string;
  main_locked_proceeds_sol: number | string;
  source_closed_at: string;
  opened_at: string;
};

function n(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function marketPrice(position: ShadowPosition): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`${DEX_URL}/${encodeURIComponent(position.mint)}`, {
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const body = await response.json();
    const pairs = Array.isArray(body) ? body : [];
    const pair = pairs.find(
      (item: any) =>
        item?.chainId === "solana" &&
        String(item?.pairAddress ?? "") === position.pair_address &&
        item?.baseToken?.address === position.mint
    );
    const price = n(pair?.priceUsd, Number.NaN);
    return Number.isFinite(price) && price > 0 ? price : null;
  } finally {
    clearTimeout(timer);
  }
}

async function seedNewPositions(): Promise<void> {
  const { data, error } = await supabase
    .from("ai_discovery_trades")
    .select("id,position_id,mint,token_symbol,pair_address,entry_price_usd,exit_price_usd,size_sol,proceeds_sol,net_return_pct,exit_reason,opened_at,closed_at")
    .gt("net_return_pct", 0)
    .in("exit_reason", ["take_profit", "trailing_stop"])
    .order("closed_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);

  for (const trade of (data ?? []) as SourceTrade[]) {
    const entryPrice = n(trade.entry_price_usd);
    const exitPrice = n(trade.exit_price_usd);
    const sourceSize = n(trade.size_sol);
    if (entryPrice <= 0 || exitPrice <= 0 || sourceSize <= 0) continue;

    const { error: insertError } = await supabase
      .from("ai_moonbag_shadow_positions")
      .upsert(
        {
          source_trade_id: trade.id,
          source_position_id: trade.position_id,
          mint: trade.mint,
          token_symbol: trade.token_symbol,
          pair_address: trade.pair_address,
          original_entry_price_usd: entryPrice,
          retention_started_price_usd: exitPrice,
          last_price_usd: exitPrice,
          peak_price_usd: exitPrice,
          source_size_sol: sourceSize,
          retained_fraction: RETAINED_FRACTION,
          retained_cost_sol: sourceSize * RETAINED_FRACTION,
          main_locked_proceeds_sol: n(trade.proceeds_sol) * (1 - RETAINED_FRACTION),
          source_closed_at: trade.closed_at,
          opened_at: trade.opened_at,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "source_trade_id", ignoreDuplicates: true }
      );
    if (insertError) throw new Error(insertError.message);
  }
}

async function closeShadow(
  position: ShadowPosition,
  exitPrice: number,
  peakPrice: number,
  reason: string
): Promise<void> {
  const entryPrice = n(position.original_entry_price_usd);
  const sourceSize = n(position.source_size_sol);
  const retainedCost = n(position.retained_cost_sol);
  const exitMultiple = entryPrice > 0 ? exitPrice / entryPrice : 0;
  const peakMultiple = entryPrice > 0 ? peakPrice / entryPrice : 0;
  const moonbagProceeds = Math.max(0, retainedCost * exitMultiple);
  const combinedProceeds = n(position.main_locked_proceeds_sol) + moonbagProceeds;
  const combinedPnl = combinedProceeds - sourceSize;
  const combinedReturnPct = sourceSize > 0 ? (combinedPnl / sourceSize) * 100 : -100;
  const now = new Date().toISOString();

  const { error } = await supabase.from("ai_moonbag_shadow_trades").insert({
    source_trade_id: position.source_trade_id,
    source_position_id: position.source_position_id,
    mint: position.mint,
    token_symbol: position.token_symbol,
    pair_address: position.pair_address,
    source_size_sol: sourceSize,
    retained_fraction: n(position.retained_fraction),
    retained_cost_sol: retainedCost,
    main_locked_proceeds_sol: n(position.main_locked_proceeds_sol),
    moonbag_proceeds_sol: moonbagProceeds,
    combined_proceeds_sol: combinedProceeds,
    combined_pnl_sol: combinedPnl,
    combined_return_pct: combinedReturnPct,
    original_entry_price_usd: entryPrice,
    retention_started_price_usd: n(position.retention_started_price_usd),
    exit_price_usd: exitPrice,
    peak_price_usd: peakPrice,
    peak_multiple: peakMultiple,
    exit_multiple: exitMultiple,
    exit_reason: reason,
    source_closed_at: position.source_closed_at,
    opened_at: position.opened_at,
    closed_at: now,
    snapshot: {
      version: VERSION,
      retainedFraction: n(position.retained_fraction),
      trailArmMultiple: TRAIL_ARM_MULTIPLE,
      trailDistancePct: TRAIL_DISTANCE_PCT,
      retentionFloorPct: RETENTION_FLOOR_PCT,
      maxHoldMs: MAX_HOLD_MS,
      uncappedUpside: true,
    },
  });
  if (error && error.code !== "23505") throw new Error(error.message);

  await supabase
    .from("ai_moonbag_shadow_positions")
    .delete()
    .eq("id", position.id);

  await sendTelegramAlert([
    "🌙 <b>MOONBAG SHADOW CLOSED</b>",
    "",
    `Token: <b>${position.token_symbol}</b>`,
    `Exit: <b>${reason.replaceAll("_", " ")}</b>`,
    `Peak: <b>${peakMultiple.toFixed(2)}×</b>`,
    `Moonbag exit: <b>${exitMultiple.toFixed(2)}×</b>`,
    `Combined return: <b>${combinedReturnPct >= 0 ? "+" : ""}${combinedReturnPct.toFixed(2)}%</b>`,
    `Combined PnL: <b>${combinedPnl >= 0 ? "+" : ""}${combinedPnl.toFixed(5)} SOL</b>`,
    "",
    "🧪 Isolated shadow result — source paper and live trades were unchanged.",
  ].join("\n"));
}

async function managePositions(): Promise<void> {
  const { data, error } = await supabase
    .from("ai_moonbag_shadow_positions")
    .select("*")
    .order("opened_at", { ascending: true })
    .limit(25);
  if (error) throw new Error(error.message);

  for (const position of (data ?? []) as ShadowPosition[]) {
    try {
      const price = await marketPrice(position);
      const heldMs = Date.now() - Date.parse(position.source_closed_at);
      const previousPeak = n(position.peak_price_usd);
      const peak = price ? Math.max(previousPeak, price) : previousPeak;
      const armPrice = n(position.original_entry_price_usd) * TRAIL_ARM_MULTIPLE;
      const floorPrice = n(position.retention_started_price_usd) * (RETENTION_FLOOR_PCT / 100);
      const trailPrice = peak * (1 - TRAIL_DISTANCE_PCT / 100);

      let reason: string | null = null;
      if (!price && heldMs >= MAX_HOLD_MS) reason = "market_unavailable_max_hold";
      else if (price && price <= floorPrice) reason = "retention_floor";
      else if (price && peak >= armPrice && price <= trailPrice) reason = "wide_trailing_stop";
      else if (heldMs >= MAX_HOLD_MS) reason = "seven_day_max_hold";

      if (reason) {
        await closeShadow(position, price ?? 0, peak, reason);
      } else if (price) {
        const now = new Date().toISOString();
        await supabase
          .from("ai_moonbag_shadow_positions")
          .update({
            last_price_usd: price,
            peak_price_usd: peak,
            last_checked_at: now,
            updated_at: now,
          })
          .eq("id", position.id);
      }
    } catch (error) {
      console.warn(`[moonbag-shadow] ${position.token_symbol} check skipped`, error);
    }
  }
}

async function runOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await seedNewPositions();
    await managePositions();
  } finally {
    running = false;
  }
}

export function startAiMoonbagShadow(): void {
  if (!ENABLED) {
    console.log("[moonbag-shadow] disabled; set PAPER_MOONBAG_SHADOW_ENABLED=true to run");
    return;
  }
  console.log(
    `[moonbag-shadow] ${VERSION} enabled; retained=${(RETAINED_FRACTION * 100).toFixed(0)}%; ` +
      `trail arms at ${TRAIL_ARM_MULTIPLE}x, distance=${TRAIL_DISTANCE_PCT}%; uncapped upside; paper-only`
  );
  void runOnce().catch((error) => console.error("[moonbag-shadow] initial cycle failed", error));
  setInterval(
    () => void runOnce().catch((error) => console.error("[moonbag-shadow] cycle failed", error)),
    LOOP_MS
  );
}
