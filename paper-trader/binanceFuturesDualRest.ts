import { randomUUID } from "crypto";
import { getSupabaseAdmin } from "../lib/supabase";
import { sendTelegramAlert } from "../lib/telegram";
import {
  BINANCE_FUTURES_PAPER_CONFIG as CONFIG,
  calculatePumpMeasurement,
  calculateShortTrade,
  floorToStep,
  type PumpMeasurement,
} from "./binanceFuturesPaper";

type Direction = "SHORT" | "LONG";
type ExitReason = "take_profit" | "stop_loss" | "max_hold_time";

type Source = {
  name: "binance_usdm_futures" | "binance_spot_fallback";
  baseUrl: string;
  apiPrefix: "/fapi/v1" | "/api/v3";
};

type Rules = {
  quantityStep: number;
  minimumQuantity: number;
  minimumNotional: number;
  priceTick: number;
};

type PositionRow = {
  position_id: string;
  symbol: string;
  side: Direction;
  leverage: number | string;
  requested_margin_usdt: number | string;
  margin_usdt: number | string;
  notional_usdt: number | string;
  quantity: number | string;
  signal_price: number | string;
  entry_fill_price: number | string;
  stop_loss_price: number | string;
  take_profit_price: number | string;
  entry_fee_usdt: number | string;
  lowest_price_seen: number | string;
  highest_price_seen: number | string;
  last_market_price: number | string;
  opened_at: string;
  last_checked_at: string;
  signal_snapshot: Record<string, unknown> | null;
};

type Position = {
  positionId: string;
  symbol: string;
  side: Direction;
  leverage: number;
  requestedMarginUsdt: number;
  marginUsdt: number;
  notionalUsdt: number;
  quantity: number;
  signalPrice: number;
  entryFillPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  entryFeeUsdt: number;
  lowestPriceSeen: number;
  highestPriceSeen: number;
  lastMarketPrice: number;
  openedAtMs: number;
  lastCheckedAtMs: number;
  signalSnapshot: Record<string, unknown>;
};

type DumpMeasurement = {
  rollingHigh: number;
  changePct: number;
};

type PendingSignal = {
  side: Direction;
  createdAtMs: number;
  candleCloseTimeMs: number;
  candleClosePrice: number;
  referencePrice: number;
  movePct: number;
  closes: number[];
};

type TradeCalculation = {
  exitFillPrice: number;
  exitFeeUsdt: number;
  grossPnlUsdt: number;
  netPnlUsdt: number;
  priceReturnPct: number;
  marginReturnPct: number;
};

const SIDES: Direction[] = ["SHORT", "LONG"];
const SOURCES: Source[] = [
  {
    name: "binance_usdm_futures",
    baseUrl: (process.env.BINANCE_FUTURES_REST_URL ?? "https://fapi.binance.com").replace(/\/$/, ""),
    apiPrefix: "/fapi/v1",
  },
  {
    name: "binance_spot_fallback",
    baseUrl: (process.env.BINANCE_SPOT_MARKET_DATA_URL ?? "https://data-api.binance.vision").replace(/\/$/, ""),
    apiPrefix: "/api/v3",
  },
];

const PRICE_POLL_MS = Math.max(1_000, Number(process.env.BINANCE_FUTURES_PRICE_POLL_MS ?? 2_000));
const CANDLE_POLL_MS = Math.max(5_000, Number(process.env.BINANCE_FUTURES_CANDLE_POLL_MS ?? 10_000));
const HEARTBEAT_WRITE_MS = 10_000;
const POSITION_WRITE_MS = 5_000;
const SOURCE_RETRY_MS = 60_000;

const finite = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const decimalPlaces = (step: number): number => {
  const text = String(step).toLowerCase();
  if (text.includes("e-")) return Number(text.split("e-")[1] ?? 0);
  return text.includes(".") ? text.split(".")[1].length : 0;
};

const roundToTick = (value: number, tick: number): number => {
  if (!Number.isFinite(tick) || tick <= 0) return value;
  return Number((Math.round(value / tick) * tick).toFixed(Math.min(12, decimalPlaces(tick))));
};

export function calculateDumpMeasurement(closes: number[]): DumpMeasurement | null {
  if (closes.length < 3) return null;
  const current = closes[closes.length - 1];
  const prior = closes.slice(0, -1).filter((value) => Number.isFinite(value) && value > 0);
  if (!Number.isFinite(current) || current <= 0 || prior.length === 0) return null;
  const rollingHigh = Math.max(...prior);
  return {
    rollingHigh,
    changePct: ((rollingHigh - current) / rollingHigh) * 100,
  };
}

export function calculateLongTrade(params: {
  entryFillPrice: number;
  marketExitPrice: number;
  quantity: number;
  marginUsdt: number;
  entryFeeUsdt: number;
  exitSlippagePct: number;
  feePct: number;
}): TradeCalculation {
  const exitFillPrice = params.marketExitPrice * (1 - params.exitSlippagePct / 100);
  const exitNotional = params.quantity * exitFillPrice;
  const exitFeeUsdt = exitNotional * (params.feePct / 100);
  const grossPnlUsdt = params.quantity * (exitFillPrice - params.entryFillPrice);
  const netPnlUsdt = grossPnlUsdt - params.entryFeeUsdt - exitFeeUsdt;
  const priceReturnPct = ((exitFillPrice - params.entryFillPrice) / params.entryFillPrice) * 100;
  const marginReturnPct = params.marginUsdt > 0 ? (netPnlUsdt / params.marginUsdt) * 100 : 0;
  return {
    exitFillPrice,
    exitFeeUsdt,
    grossPnlUsdt,
    netPnlUsdt,
    priceReturnPct,
    marginReturnPct,
  };
}

const hydratePosition = (row: PositionRow): Position => ({
  positionId: row.position_id,
  symbol: row.symbol,
  side: row.side,
  leverage: finite(row.leverage),
  requestedMarginUsdt: finite(row.requested_margin_usdt),
  marginUsdt: finite(row.margin_usdt),
  notionalUsdt: finite(row.notional_usdt),
  quantity: finite(row.quantity),
  signalPrice: finite(row.signal_price),
  entryFillPrice: finite(row.entry_fill_price),
  stopLossPrice: finite(row.stop_loss_price),
  takeProfitPrice: finite(row.take_profit_price),
  entryFeeUsdt: finite(row.entry_fee_usdt),
  lowestPriceSeen: finite(row.lowest_price_seen),
  highestPriceSeen: finite(row.highest_price_seen),
  lastMarketPrice: finite(row.last_market_price),
  openedAtMs: Date.parse(row.opened_at),
  lastCheckedAtMs: Date.parse(row.last_checked_at),
  signalSnapshot: row.signal_snapshot ?? {},
});

class BinanceDualPositionRestPaperBot {
  private readonly supabase = getSupabaseAdmin({ noStore: true });
  private readonly openPositions = new Map<Direction, Position>();
  private readonly pendingSignals = new Map<Direction, PendingSignal>();
  private readonly openingSides = new Set<Direction>();
  private readonly closingSides = new Set<Direction>();
  private source: Source | null = null;
  private rules: Rules | null = null;
  private sourceFailures = 0;
  private lastProcessedCandleMs = 0;
  private lastHeartbeatWriteMs = 0;
  private lastPositionWriteMs = 0;
  private lastSourceAttemptMs = 0;
  private pricePolling = false;
  private candlePolling = false;

  async start(): Promise<void> {
    await this.updateConnection("starting", null, null);
    await this.loadOpenPositions();
    await this.selectSource();
    setInterval(() => void this.pollPrice(), PRICE_POLL_MS);
    setInterval(() => void this.pollCandles(), CANDLE_POLL_MS);
    void this.pollPrice();
    void this.pollCandles();
    console.log(
      `[binance-futures-paper] dual-position REST engine active for ${CONFIG.symbol}; ` +
        `one LONG slot + one SHORT slot, ${CONFIG.leverage}x paper, ` +
        `${CONFIG.pumpThresholdPct}%/${CONFIG.lookbackCandles}m triggers`
    );
  }

  private async requestJson<T>(source: Source, path: string): Promise<T> {
    const response = await fetch(`${source.baseUrl}${source.apiPrefix}${path}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
      headers: { "User-Agent": "solana-intelligence-paper-research/1.0" },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`${source.name} HTTP ${response.status}${body ? `: ${body.slice(0, 160)}` : ""}`);
    }
    return (await response.json()) as T;
  }

  private async selectSource(): Promise<void> {
    this.lastSourceAttemptMs = Date.now();
    let finalError = "No Binance market-data source available";
    for (const candidate of SOURCES) {
      try {
        const rules = await this.loadRules(candidate);
        const ticker = await this.requestJson<{ price: string }>(
          candidate,
          `/ticker/price?symbol=${encodeURIComponent(CONFIG.symbol)}`
        );
        if (finite(ticker.price) <= 0) throw new Error(`${candidate.name} returned invalid price`);
        this.source = candidate;
        this.rules = rules;
        this.sourceFailures = 0;
        await this.updateConnection(
          candidate.name === "binance_usdm_futures" ? "connected" : "degraded",
          candidate.name,
          candidate.name === "binance_spot_fallback"
            ? "USD-M futures endpoint unavailable; using Binance spot BTCUSDT as the paper price reference"
            : null
        );
        console.log(`[binance-futures-paper] market data source: ${candidate.name}`);
        return;
      } catch (error) {
        finalError = error instanceof Error ? error.message : String(error);
        console.warn(`[binance-futures-paper] source ${candidate.name} unavailable: ${finalError}`);
      }
    }
    this.source = null;
    this.rules = null;
    await this.updateConnection("error", null, finalError);
  }

  private async loadRules(source: Source): Promise<Rules> {
    const payload = await this.requestJson<any>(source, "/exchangeInfo");
    const symbol = (payload.symbols ?? []).find(
      (row: any) => String(row.symbol).toUpperCase() === CONFIG.symbol
    );
    if (!symbol) throw new Error(`${CONFIG.symbol} missing from ${source.name} exchangeInfo`);
    const filters = Array.isArray(symbol.filters) ? symbol.filters : [];
    const marketQuantityFilter = filters.find((row: any) => row.filterType === "MARKET_LOT_SIZE");
    const lotQuantityFilter = filters.find((row: any) => row.filterType === "LOT_SIZE");
    const quantityFilter =
      marketQuantityFilter && finite(marketQuantityFilter.stepSize) > 0 && finite(marketQuantityFilter.minQty) > 0
        ? marketQuantityFilter
        : lotQuantityFilter;
    const priceFilter = filters.find((row: any) => row.filterType === "PRICE_FILTER");
    const notionalFilter = filters.find(
      (row: any) => row.filterType === "MIN_NOTIONAL" || row.filterType === "NOTIONAL"
    );
    const rules: Rules = {
      quantityStep: finite(quantityFilter?.stepSize),
      minimumQuantity: finite(quantityFilter?.minQty),
      minimumNotional: finite(notionalFilter?.notional ?? notionalFilter?.minNotional),
      priceTick: finite(priceFilter?.tickSize),
    };
    if (rules.quantityStep <= 0 || rules.minimumQuantity <= 0 || rules.priceTick <= 0) {
      throw new Error(`Incomplete exchange filters from ${source.name}`);
    }
    return rules;
  }

  private async loadOpenPositions(): Promise<void> {
    const { data, error } = await this.supabase
      .from("binance_futures_positions")
      .select(
        "position_id,symbol,side,leverage,requested_margin_usdt,margin_usdt,notional_usdt,quantity,signal_price,entry_fill_price,stop_loss_price,take_profit_price,entry_fee_usdt,lowest_price_seen,highest_price_seen,last_market_price,opened_at,last_checked_at,signal_snapshot"
      )
      .order("opened_at", { ascending: true });
    if (error) throw new Error(`Unable to load Binance paper positions: ${error.message}`);
    for (const row of (data ?? []) as PositionRow[]) {
      const position = hydratePosition(row);
      this.openPositions.set(position.side, position);
      console.log(
        `[binance-futures-paper] recovered open ${position.side} ${position.symbol} @ ${position.entryFillPrice}`
      );
    }
  }

  private async ensureSource(): Promise<boolean> {
    if (this.source && this.rules) return true;
    if (Date.now() - this.lastSourceAttemptMs < SOURCE_RETRY_MS) return false;
    await this.selectSource();
    return Boolean(this.source && this.rules);
  }

  private async sourceFailed(error: unknown): Promise<void> {
    this.sourceFailures += 1;
    const message = error instanceof Error ? error.message : String(error);
    await this.updateConnection("error", this.source?.name ?? null, message);
    if (this.sourceFailures >= 3) {
      this.source = null;
      this.rules = null;
      this.sourceFailures = 0;
      this.lastSourceAttemptMs = 0;
      await this.selectSource();
    }
  }

  private async pollPrice(): Promise<void> {
    if (this.pricePolling) return;
    this.pricePolling = true;
    try {
      if (!(await this.ensureSource())) return;
      const source = this.source!;
      const ticker = await this.requestJson<{ price: string }>(
        source,
        `/ticker/price?symbol=${encodeURIComponent(CONFIG.symbol)}`
      );
      const price = finite(ticker.price);
      if (price <= 0) throw new Error(`${source.name} returned invalid ticker price`);
      this.sourceFailures = 0;
      const now = Date.now();

      for (const position of [...this.openPositions.values()]) {
        position.lastMarketPrice = price;
        position.lastCheckedAtMs = now;
        position.lowestPriceSeen = Math.min(position.lowestPriceSeen, price);
        position.highestPriceSeen = Math.max(position.highestPriceSeen, price);
        await this.evaluateExit(position, price, now);
      }
      await this.persistPositionsIfDue();

      for (const side of SIDES) {
        if (
          this.pendingSignals.has(side) &&
          !this.openPositions.has(side) &&
          !this.openingSides.has(side) &&
          !this.closingSides.has(side)
        ) {
          await this.openPendingSignal(side, price, now);
        }
      }

      if (now - this.lastHeartbeatWriteMs >= HEARTBEAT_WRITE_MS) {
        this.lastHeartbeatWriteMs = now;
        await this.supabase
          .from("binance_futures_state")
          .update({
            connection_status: source.name === "binance_usdm_futures" ? "connected" : "degraded",
            data_source: source.name,
            last_error:
              source.name === "binance_spot_fallback"
                ? "Using Binance spot BTCUSDT as fallback price reference"
                : null,
            last_market_price: price,
            last_ws_message_at: new Date(now).toISOString(),
            updated_at: new Date(now).toISOString(),
          })
          .eq("id", 1);
      }
    } catch (error) {
      await this.sourceFailed(error);
    } finally {
      this.pricePolling = false;
    }
  }

  private async pollCandles(): Promise<void> {
    if (this.candlePolling) return;
    this.candlePolling = true;
    try {
      if (!(await this.ensureSource())) return;
      const source = this.source!;
      const limit = CONFIG.lookbackCandles + 3;
      const rows = await this.requestJson<any[]>(
        source,
        `/klines?symbol=${encodeURIComponent(CONFIG.symbol)}&interval=1m&limit=${limit}`
      );
      const now = Date.now();
      const candles = rows
        .map((row) => ({ close: finite(row?.[4]), closeTimeMs: finite(row?.[6]) }))
        .filter((row) => row.close > 0 && row.closeTimeMs > 0 && row.closeTimeMs < now)
        .slice(-CONFIG.lookbackCandles);
      if (candles.length === 0) return;
      const latest = candles[candles.length - 1];
      if (latest.closeTimeMs <= this.lastProcessedCandleMs) return;
      this.lastProcessedCandleMs = latest.closeTimeMs;
      const closes = candles.map((row) => row.close);
      const pump = calculatePumpMeasurement(closes);
      const dump = calculateDumpMeasurement(closes);
      await this.supabase
        .from("binance_futures_state")
        .update({
          last_candle_close_time: new Date(latest.closeTimeMs).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", 1);
      await this.processClosedCandle(latest.closeTimeMs, latest.close, closes, pump, dump);
    } catch (error) {
      await this.sourceFailed(error);
    } finally {
      this.candlePolling = false;
    }
  }

  private async processClosedCandle(
    closeTimeMs: number,
    closePrice: number,
    closes: number[],
    pump: PumpMeasurement | null,
    dump: DumpMeasurement | null
  ): Promise<void> {
    if (!pump || !dump || closes.length < CONFIG.lookbackCandles) {
      await this.logScan(
        closeTimeMs,
        closePrice,
        null,
        pump,
        dump,
        false,
        "warming_up",
        "insufficient_closed_candles",
        []
      );
      return;
    }

    const triggeredSides: Direction[] = [];
    if (pump.changePct >= CONFIG.pumpThresholdPct) triggeredSides.push("SHORT");
    if (dump.changePct >= CONFIG.pumpThresholdPct) triggeredSides.push("LONG");

    const { data: state, error } = await this.supabase
      .from("binance_futures_state")
      .select("enabled,halted,halt_reason,short_cooldown_until,long_cooldown_until")
      .eq("id", 1)
      .single();
    if (error) {
      await this.logScan(
        closeTimeMs,
        closePrice,
        triggeredSides.length === 1 ? triggeredSides[0] : null,
        pump,
        dump,
        triggeredSides.length > 0,
        "error",
        `state_read_failed:${error.message}`,
        triggeredSides
      );
      return;
    }
    if (!state.enabled || state.halted) {
      await this.logScan(
        closeTimeMs,
        closePrice,
        triggeredSides.length === 1 ? triggeredSides[0] : null,
        pump,
        dump,
        triggeredSides.length > 0,
        "halted",
        state.halt_reason || "disabled",
        triggeredSides
      );
      return;
    }
    if (triggeredSides.length === 0) {
      await this.logScan(closeTimeMs, closePrice, null, pump, dump, false, "monitor", "move_threshold_not_reached", []);
      return;
    }

    const queuedSides: Direction[] = [];
    const blockedSides: Direction[] = [];
    const now = Date.now();
    for (const side of triggeredSides) {
      const cooldownValue = side === "SHORT" ? state.short_cooldown_until : state.long_cooldown_until;
      const cooldownUntil = cooldownValue ? Date.parse(cooldownValue) : 0;
      if (cooldownUntil > now) {
        blockedSides.push(side);
        continue;
      }
      if (
        this.openPositions.has(side) ||
        this.pendingSignals.has(side) ||
        this.openingSides.has(side) ||
        this.closingSides.has(side)
      ) {
        blockedSides.push(side);
        continue;
      }

      const referencePrice = side === "SHORT" ? pump.rollingLow : dump.rollingHigh;
      const movePct = side === "SHORT" ? pump.changePct : dump.changePct;
      this.pendingSignals.set(side, {
        side,
        createdAtMs: now,
        candleCloseTimeMs: closeTimeMs,
        candleClosePrice: closePrice,
        referencePrice,
        movePct,
        closes,
      });
      queuedSides.push(side);
      console.log(
        `[binance-futures-paper] ${side} signal ${CONFIG.symbol} ${movePct.toFixed(2)}% over ${CONFIG.lookbackCandles} closed candles`
      );
    }

    const primarySide = queuedSides.length === 1 ? queuedSides[0] : triggeredSides.length === 1 ? triggeredSides[0] : null;
    if (queuedSides.length > 0) {
      await this.logScan(
        closeTimeMs,
        closePrice,
        primarySide,
        pump,
        dump,
        true,
        "signal_pending",
        queuedSides.length === 2 ? "both_sides_awaiting_next_price_poll" : "awaiting_next_price_poll",
        triggeredSides,
        queuedSides,
        blockedSides
      );
      return;
    }

    const allOnCooldown = blockedSides.every((side) => {
      const value = side === "SHORT" ? state.short_cooldown_until : state.long_cooldown_until;
      return Boolean(value && Date.parse(value) > now);
    });
    await this.logScan(
      closeTimeMs,
      closePrice,
      primarySide,
      pump,
      dump,
      true,
      allOnCooldown ? "cooldown" : "position_open",
      allOnCooldown ? "side_cooldown" : "same_side_position_limit",
      triggeredSides,
      queuedSides,
      blockedSides
    );
  }

  private async openPendingSignal(side: Direction, marketPrice: number, openedAtMs: number): Promise<void> {
    const signal = this.pendingSignals.get(side);
    if (!signal || !this.rules || !this.source || this.openPositions.has(side)) return;
    if (openedAtMs - signal.createdAtMs > CONFIG.pendingSignalTtlMs) {
      this.pendingSignals.delete(side);
      return;
    }

    this.openingSides.add(side);
    try {
      const entryFillPrice =
        side === "SHORT"
          ? marketPrice * (1 - CONFIG.slippagePctPerSide / 100)
          : marketPrice * (1 + CONFIG.slippagePctPerSide / 100);
      const requestedNotional = CONFIG.marginBudgetUsdt * CONFIG.leverage;
      const quantity = floorToStep(requestedNotional / entryFillPrice, this.rules.quantityStep);
      const notionalUsdt = quantity * entryFillPrice;
      const marginUsdt = notionalUsdt / CONFIG.leverage;
      if (quantity < this.rules.minimumQuantity || quantity <= 0) {
        throw new Error(`quantity ${quantity} below minimum ${this.rules.minimumQuantity}`);
      }
      if (this.rules.minimumNotional > 0 && notionalUsdt < this.rules.minimumNotional) {
        throw new Error(`notional ${notionalUsdt} below minimum ${this.rules.minimumNotional}`);
      }
      const entryFeeUsdt = notionalUsdt * (CONFIG.takerFeePctPerSide / 100);
      const stopLossPrice = roundToTick(
        side === "SHORT"
          ? entryFillPrice * (1 + CONFIG.stopLossPct / 100)
          : entryFillPrice * (1 - CONFIG.stopLossPct / 100),
        this.rules.priceTick
      );
      const takeProfitPrice = roundToTick(
        side === "SHORT"
          ? entryFillPrice * (1 - CONFIG.takeProfitPct / 100)
          : entryFillPrice * (1 + CONFIG.takeProfitPct / 100),
        this.rules.priceTick
      );
      const positionId = randomUUID();
      const signalSnapshot = {
        strategy_version: "binance_btc_dual_slot_fade_paper_v3_2026_07_23",
        paper_only: true,
        side,
        independent_side_slot: true,
        price_source: this.source.name,
        source_is_futures: this.source.name === "binance_usdm_futures",
        signal_candle_close_time: new Date(signal.candleCloseTimeMs).toISOString(),
        signal_candle_close_price: signal.candleClosePrice,
        market_price_at_fill: marketPrice,
        rolling_reference_price: signal.referencePrice,
        rolling_move_pct: signal.movePct,
        recent_closes: signal.closes,
        lookback_candles: CONFIG.lookbackCandles,
        trigger_threshold_pct: CONFIG.pumpThresholdPct,
        leverage: CONFIG.leverage,
        requested_margin_usdt: CONFIG.marginBudgetUsdt,
        taker_fee_pct_per_side: CONFIG.takerFeePctPerSide,
        slippage_pct_per_side: CONFIG.slippagePctPerSide,
      };
      const { error } = await this.supabase.rpc("binance_futures_open_paper_position_v3", {
        p_position_id: positionId,
        p_symbol: CONFIG.symbol,
        p_side: side,
        p_leverage: CONFIG.leverage,
        p_requested_margin_usdt: CONFIG.marginBudgetUsdt,
        p_margin_usdt: marginUsdt,
        p_notional_usdt: notionalUsdt,
        p_quantity: quantity,
        p_signal_price: signal.candleClosePrice,
        p_entry_fill_price: entryFillPrice,
        p_stop_loss_price: stopLossPrice,
        p_take_profit_price: takeProfitPrice,
        p_entry_fee_usdt: entryFeeUsdt,
        p_opened_at: new Date(openedAtMs).toISOString(),
        p_signal_snapshot: signalSnapshot,
        p_max_daily_entries: CONFIG.maxDailyEntries,
      });
      if (error) throw new Error(error.message);

      this.openPositions.set(side, {
        positionId,
        symbol: CONFIG.symbol,
        side,
        leverage: CONFIG.leverage,
        requestedMarginUsdt: CONFIG.marginBudgetUsdt,
        marginUsdt,
        notionalUsdt,
        quantity,
        signalPrice: signal.candleClosePrice,
        entryFillPrice,
        stopLossPrice,
        takeProfitPrice,
        entryFeeUsdt,
        lowestPriceSeen: entryFillPrice,
        highestPriceSeen: entryFillPrice,
        lastMarketPrice: marketPrice,
        openedAtMs,
        lastCheckedAtMs: openedAtMs,
        signalSnapshot,
      });
      this.pendingSignals.delete(side);
      const icon = side === "SHORT" ? "📉" : "📈";
      const moveName = side === "SHORT" ? "Pump" : "Drop";
      await sendTelegramAlert([
        `${icon} <b>BINANCE FUTURES PAPER ${side}</b>`,
        "",
        `Slot: <b>${side}</b> (independent)`,
        `Symbol: <b>${CONFIG.symbol}</b>`,
        `Price source: <b>${this.source.name}</b>`,
        `${moveName} signal: <b>${side === "SHORT" ? "+" : "-"}${signal.movePct.toFixed(2)}%</b>`,
        `Entry: <b>$${entryFillPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}</b>`,
        `Notional: <b>$${notionalUsdt.toFixed(2)}</b>`,
        `Margin: <b>$${marginUsdt.toFixed(2)}</b> @ ${CONFIG.leverage}x`,
        `Stop: <b>$${stopLossPrice.toLocaleString()}</b>`,
        `Target: <b>$${takeProfitPrice.toLocaleString()}</b>`,
        `Other slot: <b>${this.openPositions.has(side === "SHORT" ? "LONG" : "SHORT") ? "OPEN" : "AVAILABLE"}</b>`,
        "",
        "🧪 Paper simulation only — no Binance order was placed.",
      ].join("\n"));
    } catch (error) {
      this.pendingSignals.delete(side);
      await this.updateConnection(
        "error",
        this.source?.name ?? null,
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      this.openingSides.delete(side);
    }
  }

  private async evaluateExit(position: Position, price: number, now: number): Promise<void> {
    if (this.closingSides.has(position.side)) return;
    let reason: ExitReason | null = null;
    if (position.side === "SHORT") {
      if (price >= position.stopLossPrice) reason = "stop_loss";
      else if (price <= position.takeProfitPrice) reason = "take_profit";
    } else {
      if (price <= position.stopLossPrice) reason = "stop_loss";
      else if (price >= position.takeProfitPrice) reason = "take_profit";
    }
    if (!reason && now - position.openedAtMs >= CONFIG.maxHoldMinutes * 60_000) {
      reason = "max_hold_time";
    }
    if (reason) await this.closePosition(position, reason, price, now);
  }

  private async closePosition(
    position: Position,
    reason: ExitReason,
    marketPrice: number,
    closedAtMs: number
  ): Promise<void> {
    if (this.closingSides.has(position.side)) return;
    this.closingSides.add(position.side);
    try {
      const result =
        position.side === "SHORT"
          ? calculateShortTrade({
              entryFillPrice: position.entryFillPrice,
              marketExitPrice: marketPrice,
              quantity: position.quantity,
              marginUsdt: position.marginUsdt,
              entryFeeUsdt: position.entryFeeUsdt,
              exitSlippagePct: CONFIG.slippagePctPerSide,
              feePct: CONFIG.takerFeePctPerSide,
            })
          : calculateLongTrade({
              entryFillPrice: position.entryFillPrice,
              marketExitPrice: marketPrice,
              quantity: position.quantity,
              marginUsdt: position.marginUsdt,
              entryFeeUsdt: position.entryFeeUsdt,
              exitSlippagePct: CONFIG.slippagePctPerSide,
              feePct: CONFIG.takerFeePctPerSide,
            });
      const cooldownUntil = new Date(closedAtMs + CONFIG.cooldownMinutes * 60_000).toISOString();
      const { data, error } = await this.supabase.rpc("binance_futures_close_paper_position", {
        p_position_id: position.positionId,
        p_exit_market_price: marketPrice,
        p_exit_fill_price: result.exitFillPrice,
        p_exit_fee_usdt: result.exitFeeUsdt,
        p_gross_pnl_usdt: result.grossPnlUsdt,
        p_net_pnl_usdt: result.netPnlUsdt,
        p_price_return_pct: result.priceReturnPct,
        p_margin_return_pct: result.marginReturnPct,
        p_exit_reason: reason,
        p_closed_at: new Date(closedAtMs).toISOString(),
        p_cooldown_until: cooldownUntil,
        p_exit_snapshot: {
          paper_only: true,
          side: position.side,
          independent_side_slot: true,
          price_source: this.source?.name ?? "unknown",
          market_exit_price: marketPrice,
          simulated_exit_fill_price: result.exitFillPrice,
          lowest_price_seen: position.lowestPriceSeen,
          highest_price_seen: position.highestPriceSeen,
          hold_seconds: (closedAtMs - position.openedAtMs) / 1000,
        },
        p_daily_loss_limit_usdt: CONFIG.dailyLossLimitUsdt,
        p_max_consecutive_losses: CONFIG.maxConsecutiveLosses,
        p_max_daily_entries: CONFIG.maxDailyEntries,
      });
      if (error) throw new Error(error.message);
      const ledger = (data ?? {}) as Record<string, unknown>;
      await sendTelegramAlert([
        `${result.netPnlUsdt >= 0 ? "✅" : "❌"} <b>BINANCE FUTURES PAPER CLOSED</b>`,
        "",
        `Symbol: <b>${position.symbol}</b> ${position.side}`,
        `Reason: <b>${reason}</b>`,
        `Entry: <b>$${position.entryFillPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}</b>`,
        `Exit: <b>$${result.exitFillPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}</b>`,
        `Net PnL: <b>${result.netPnlUsdt >= 0 ? "+" : ""}$${result.netPnlUsdt.toFixed(2)}</b>`,
        `Margin return: <b>${result.marginReturnPct >= 0 ? "+" : ""}${result.marginReturnPct.toFixed(2)}%</b>`,
        `Paper bankroll: <b>$${finite(ledger.bankrollUsdt).toFixed(2)}</b>`,
        `Other slot: <b>${this.openPositions.has(position.side === "SHORT" ? "LONG" : "SHORT") ? "STILL OPEN" : "EMPTY"}</b>`,
        "",
        "🧪 Paper simulation only.",
      ].join("\n"));
      console.log(
        `[binance-futures-paper] closed ${position.side} ${position.symbol} ${reason}; net $${result.netPnlUsdt.toFixed(2)}`
      );
      this.openPositions.delete(position.side);
      this.pendingSignals.delete(position.side);
    } catch (error) {
      await this.updateConnection(
        "error",
        this.source?.name ?? null,
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      this.closingSides.delete(position.side);
    }
  }

  private async persistPositionsIfDue(): Promise<void> {
    const now = Date.now();
    if (this.openPositions.size === 0 || now - this.lastPositionWriteMs < POSITION_WRITE_MS) return;
    this.lastPositionWriteMs = now;
    await Promise.all(
      [...this.openPositions.values()].map((position) =>
        this.supabase
          .from("binance_futures_positions")
          .update({
            lowest_price_seen: position.lowestPriceSeen,
            highest_price_seen: position.highestPriceSeen,
            last_market_price: position.lastMarketPrice,
            last_checked_at: new Date(position.lastCheckedAtMs).toISOString(),
            updated_at: new Date(now).toISOString(),
          })
          .eq("position_id", position.positionId)
      )
    );
  }

  private async updateConnection(
    status: "starting" | "connected" | "degraded" | "error" | "disabled",
    source: string | null,
    error: string | null
  ): Promise<void> {
    await this.supabase
      .from("binance_futures_state")
      .update({
        connection_status: status,
        data_source: source,
        last_error: error,
        updated_at: new Date().toISOString(),
      })
      .eq("id", 1);
  }

  private async logScan(
    closeTimeMs: number,
    closePrice: number,
    side: Direction | null,
    pump: PumpMeasurement | null,
    dump: DumpMeasurement | null,
    triggered: boolean,
    action: "warming_up" | "monitor" | "signal_pending" | "position_open" | "cooldown" | "halted" | "error",
    reason: string,
    triggeredSides: Direction[],
    queuedSides: Direction[] = [],
    blockedSides: Direction[] = []
  ): Promise<void> {
    const signedChange = side === "LONG" ? -(dump?.changePct ?? 0) : pump?.changePct ?? 0;
    const openPositionIds = Object.fromEntries(
      [...this.openPositions.entries()].map(([positionSide, position]) => [positionSide, position.positionId])
    );
    await this.supabase.from("binance_futures_scan_runs").upsert(
      {
        symbol: CONFIG.symbol,
        candle_close_time: new Date(closeTimeMs).toISOString(),
        close_price: closePrice,
        rolling_low_price: pump?.rollingLow ?? null,
        rolling_change_pct: signedChange,
        trigger_threshold_pct: CONFIG.pumpThresholdPct,
        triggered,
        action,
        reason,
        snapshot: {
          signal_side: side,
          triggered_sides: triggeredSides,
          queued_sides: queuedSides,
          blocked_sides: blockedSides,
          price_source: this.source?.name ?? null,
          lookback_candles: CONFIG.lookbackCandles,
          pump_change_pct: pump?.changePct ?? null,
          dump_change_pct: dump?.changePct ?? null,
          rolling_low_price: pump?.rollingLow ?? null,
          rolling_high_price: dump?.rollingHigh ?? null,
          open_positions: openPositionIds,
          short_position_id: this.openPositions.get("SHORT")?.positionId ?? null,
          long_position_id: this.openPositions.get("LONG")?.positionId ?? null,
          pending_signals: [...this.pendingSignals.keys()],
          opening_sides: [...this.openingSides],
          closing_sides: [...this.closingSides],
        },
      },
      { onConflict: "symbol,candle_close_time" }
    );
  }
}

let started = false;

export function startBinanceFuturesDualRestPaperBot(): void {
  if (started) return;
  started = true;
  if (!CONFIG.enabled) return;
  const bot = new BinanceDualPositionRestPaperBot();
  void bot.start().catch((error) => {
    console.error("[binance-futures-paper] dual-position REST startup failed:", error);
  });
}
