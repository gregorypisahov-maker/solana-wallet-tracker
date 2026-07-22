import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { hasViewerAccess, unauthorized } from "@/lib/dashboardAuth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

type Direction = "SHORT" | "LONG";

const numberEnv = (name: string, fallback: number, minimum?: number): number => {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return minimum == null ? parsed : Math.max(minimum, parsed);
};

const finite = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const CONFIG = {
  symbol: (process.env.BINANCE_FUTURES_SYMBOL ?? "BTCUSDT").trim().toUpperCase(),
  leverage: Math.round(numberEnv("BINANCE_FUTURES_LEVERAGE", 5, 1)),
  marginBudgetUsdt: numberEnv("BINANCE_FUTURES_MARGIN_USDT", 50, 1),
  pumpThresholdPct: numberEnv("BINANCE_FUTURES_PUMP_THRESHOLD_PCT", 3, 0.1),
  lookbackCandles: Math.round(numberEnv("BINANCE_FUTURES_LOOKBACK_CANDLES", 5, 3)),
  stopLossPct: numberEnv("BINANCE_FUTURES_STOP_LOSS_PCT", 1.5, 0.1),
  takeProfitPct: numberEnv("BINANCE_FUTURES_TAKE_PROFIT_PCT", 2, 0.1),
  takerFeePctPerSide: numberEnv("BINANCE_FUTURES_TAKER_FEE_PCT", 0.05, 0),
  slippagePctPerSide: numberEnv("BINANCE_FUTURES_SLIPPAGE_PCT", 0.02, 0),
  maxHoldMinutes: numberEnv("BINANCE_FUTURES_MAX_HOLD_MINUTES", 240, 1),
  cooldownMinutes: numberEnv("BINANCE_FUTURES_COOLDOWN_MINUTES", 30, 0),
  maxDailyEntries: Math.round(numberEnv("BINANCE_FUTURES_MAX_DAILY_ENTRIES", 6, 1)),
} as const;

const direction = (value: unknown): Direction | null => {
  const normalized = String(value ?? "").toUpperCase();
  return normalized === "LONG" || normalized === "SHORT" ? normalized : null;
};

export async function GET(request: NextRequest) {
  if (!hasViewerAccess(request)) return unauthorized();

  const supabase = getSupabaseAdmin({ noStore: true });
  const [stateResult, positionResult, scansResult, tradesResult] = await Promise.all([
    supabase.from("binance_futures_state").select("*").eq("id", 1).maybeSingle(),
    supabase
      .from("binance_futures_positions")
      .select("*")
      .order("opened_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("binance_futures_scan_runs")
      .select("*")
      .order("candle_close_time", { ascending: false })
      .limit(90),
    supabase
      .from("binance_futures_trades")
      .select("*")
      .order("closed_at", { ascending: false })
      .limit(20),
  ]);

  const failed = [stateResult, positionResult, scansResult, tradesResult].find(
    (result) => result.error
  );
  if (failed?.error) {
    console.error("[binance-live] dashboard query failed", failed.error);
    return NextResponse.json(
      { error: "Binance paper-feed data is temporarily unavailable" },
      { status: 500 }
    );
  }

  const now = Date.now();
  const state = stateResult.data ?? null;
  const position = positionResult.data ?? null;
  const descendingScans = scansResult.data ?? [];
  const latestScan = descendingScans[0] ?? null;
  const scans = [...descendingScans].reverse();
  const currentPrice = finite(
    state?.last_market_price ?? position?.last_market_price ?? latestScan?.close_price
  );
  const currentMovePct = finite(latestScan?.rolling_change_pct);
  const triggerThresholdPct =
    finite(latestScan?.trigger_threshold_pct) || CONFIG.pumpThresholdPct;
  const triggerProgressPct = clamp(
    (Math.abs(currentMovePct) / triggerThresholdPct) * 100,
    0,
    100
  );
  const distanceToTriggerPct = Math.max(0, triggerThresholdPct - Math.abs(currentMovePct));

  const latestSnapshot = (latestScan?.snapshot ?? {}) as Record<string, unknown>;
  const signalSide: Direction =
    direction(position?.side) ??
    direction(latestSnapshot.signal_side) ??
    (currentMovePct < 0 ? "LONG" : "SHORT");

  const plannedEntryFillPrice =
    currentPrice > 0
      ? currentPrice *
        (signalSide === "LONG"
          ? 1 + CONFIG.slippagePctPerSide / 100
          : 1 - CONFIG.slippagePctPerSide / 100)
      : 0;
  const plannedStopLossPrice =
    plannedEntryFillPrice > 0
      ? plannedEntryFillPrice *
        (signalSide === "LONG"
          ? 1 - CONFIG.stopLossPct / 100
          : 1 + CONFIG.stopLossPct / 100)
      : 0;
  const plannedTakeProfitPrice =
    plannedEntryFillPrice > 0
      ? plannedEntryFillPrice *
        (signalSide === "LONG"
          ? 1 + CONFIG.takeProfitPct / 100
          : 1 - CONFIG.takeProfitPct / 100)
      : 0;

  let status = "waiting";
  if (state?.enabled === false) status = "disabled";
  else if (state?.halted) status = "halted";
  else if (position) status = "position_open";
  else if (latestScan?.action === "signal_pending") status = "signal_pending";

  let liveGrossPnlUsdt = 0;
  let liveNetPnlUsdt = 0;
  let liveMarginReturnPct = 0;
  let livePriceReturnPct = 0;
  let targetProgressPct = 0;
  let stopRiskPct = 0;
  let stopBufferPct: number | null = null;
  let targetDistancePct: number | null = null;
  let holdMinutes = 0;

  if (position && currentPrice > 0) {
    const side = direction(position.side) ?? "SHORT";
    const quantity = finite(position.quantity);
    const entryFillPrice = finite(position.entry_fill_price);
    const entryFeeUsdt = finite(position.entry_fee_usdt);
    const marginUsdt = finite(position.margin_usdt);
    const exitFillPrice =
      currentPrice *
      (side === "LONG"
        ? 1 - CONFIG.slippagePctPerSide / 100
        : 1 + CONFIG.slippagePctPerSide / 100);
    const exitFeeUsdt =
      quantity * exitFillPrice * (CONFIG.takerFeePctPerSide / 100);
    liveGrossPnlUsdt =
      side === "LONG"
        ? quantity * (exitFillPrice - entryFillPrice)
        : quantity * (entryFillPrice - exitFillPrice);
    liveNetPnlUsdt = liveGrossPnlUsdt - entryFeeUsdt - exitFeeUsdt;
    liveMarginReturnPct = marginUsdt > 0 ? (liveNetPnlUsdt / marginUsdt) * 100 : 0;
    livePriceReturnPct =
      entryFillPrice > 0
        ? side === "LONG"
          ? ((exitFillPrice - entryFillPrice) / entryFillPrice) * 100
          : ((entryFillPrice - exitFillPrice) / entryFillPrice) * 100
        : 0;

    const stop = finite(position.stop_loss_price);
    const target = finite(position.take_profit_price);
    const targetRange = Math.abs(target - entryFillPrice);
    const stopRange = Math.abs(stop - entryFillPrice);
    targetProgressPct =
      targetRange > 0
        ? clamp(
            ((side === "LONG" ? currentPrice - entryFillPrice : entryFillPrice - currentPrice) /
              targetRange) *
              100,
            0,
            100
          )
        : 0;
    stopRiskPct =
      stopRange > 0
        ? clamp(
            ((side === "LONG" ? entryFillPrice - currentPrice : currentPrice - entryFillPrice) /
              stopRange) *
              100,
            0,
            100
          )
        : 0;
    stopBufferPct =
      stop > 0
        ? side === "LONG"
          ? ((currentPrice - stop) / currentPrice) * 100
          : ((stop - currentPrice) / currentPrice) * 100
        : null;
    targetDistancePct =
      target > 0
        ? side === "LONG"
          ? ((target - currentPrice) / currentPrice) * 100
          : ((currentPrice - target) / currentPrice) * 100
        : null;
    holdMinutes = Math.max(0, (now - Date.parse(position.opened_at)) / 60_000);
  }

  const heartbeatAt = state?.last_ws_message_at ?? state?.updated_at ?? null;
  const heartbeatAgeSeconds = heartbeatAt
    ? Math.max(0, (now - Date.parse(heartbeatAt)) / 1000)
    : null;
  const feedHealthy = heartbeatAgeSeconds != null && heartbeatAgeSeconds < 30;

  return NextResponse.json(
    {
      generatedAt: new Date(now).toISOString(),
      config: CONFIG,
      state,
      position,
      scans,
      trades: tradesResult.data ?? [],
      derived: {
        status,
        signalSide,
        currentPrice,
        currentMovePct,
        triggerThresholdPct,
        triggerProgressPct,
        distanceToTriggerPct,
        plannedEntryFillPrice,
        plannedStopLossPrice,
        plannedTakeProfitPrice,
        plannedNotionalUsdt: CONFIG.marginBudgetUsdt * CONFIG.leverage,
        liveGrossPnlUsdt,
        liveNetPnlUsdt,
        liveMarginReturnPct,
        livePriceReturnPct,
        targetProgressPct,
        stopRiskPct,
        stopBufferPct,
        targetDistancePct,
        holdMinutes,
        heartbeatAt,
        heartbeatAgeSeconds,
        feedHealthy,
        latestScanAt: latestScan?.candle_close_time ?? null,
      },
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}
