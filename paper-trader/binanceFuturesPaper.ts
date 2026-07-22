import { randomUUID } from "crypto";
import { getSupabaseAdmin } from "../lib/supabase";
import { sendTelegramAlert } from "../lib/telegram";

const numberEnv = (name: string, fallback: number, minimum?: number): number => {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return minimum == null ? parsed : Math.max(minimum, parsed);
};

const booleanEnv = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name];
  if (raw == null) return fallback;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
};

export const BINANCE_FUTURES_PAPER_CONFIG = {
  enabled: booleanEnv("ENABLE_BINANCE_FUTURES_PAPER", true),
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
  dailyLossLimitUsdt: numberEnv("BINANCE_FUTURES_DAILY_LOSS_LIMIT_USDT", 20, 1),
  maxConsecutiveLosses: Math.round(numberEnv("BINANCE_FUTURES_MAX_CONSECUTIVE_LOSSES", 4, 1)),
  pendingSignalTtlMs: numberEnv("BINANCE_FUTURES_SIGNAL_TTL_MS", 15_000, 1_000),
  positionWriteIntervalMs: numberEnv("BINANCE_FUTURES_POSITION_WRITE_MS", 5_000, 1_000),
  heartbeatIntervalMs: numberEnv("BINANCE_FUTURES_HEARTBEAT_MS", 15_000, 5_000),
  staleSocketMs: numberEnv("BINANCE_FUTURES_STALE_SOCKET_MS", 45_000, 10_000),
  restBaseUrl: (process.env.BINANCE_FUTURES_REST_URL ?? "https://fapi.binance.com").replace(/\/$/, ""),
  websocketBaseUrl: (process.env.BINANCE_FUTURES_WS_URL ?? "wss://fstream.binance.com").replace(/\/$/, ""),
} as const;

export type PumpMeasurement = {
  rollingLow: number;
  changePct: number;
};

export type ShortTradeCalculation = {
  exitFillPrice: number;
  exitFeeUsdt: number;
  grossPnlUsdt: number;
  netPnlUsdt: number;
  priceReturnPct: number;
  marginReturnPct: number;
};

export function calculatePumpMeasurement(closes: number[]): PumpMeasurement | null {
  if (closes.length < 3) return null;
  const current = closes[closes.length - 1];
  const prior = closes.slice(0, -1).filter((value) => Number.isFinite(value) && value > 0);
  if (!Number.isFinite(current) || current <= 0 || prior.length === 0) return null;
  const rollingLow = Math.min(...prior);
  return {
    rollingLow,
    changePct: ((current - rollingLow) / rollingLow) * 100,
  };
}

export function calculateShortTrade(params: {
  entryFillPrice: number;
  marketExitPrice: number;
  quantity: number;
  marginUsdt: number;
  entryFeeUsdt: number;
  exitSlippagePct: number;
  feePct: number;
}): ShortTradeCalculation {
  const exitFillPrice = params.marketExitPrice * (1 + params.exitSlippagePct / 100);
  const exitNotional = params.quantity * exitFillPrice;
  const exitFeeUsdt = exitNotional * (params.feePct / 100);
  const grossPnlUsdt = params.quantity * (params.entryFillPrice - exitFillPrice);
  const netPnlUsdt = grossPnlUsdt - params.entryFeeUsdt - exitFeeUsdt;
  const priceReturnPct = ((params.entryFillPrice - exitFillPrice) / params.entryFillPrice) * 100;
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

function decimalPlaces(step: number): number {
  const text = step.toString().toLowerCase();
  if (text.includes("e-")) return Number(text.split("e-")[1] ?? 0);
  return text.includes(".") ? text.split(".")[1].length : 0;
}

export function floorToStep(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return 0;
  const places = Math.min(12, decimalPlaces(step));
  const floored = Math.floor((value + step * 1e-9) / step) * step;
  return Number(floored.toFixed(places));
}

function roundToTick(value: number, tick: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(tick) || tick <= 0) return value;
  const places = Math.min(12, decimalPlaces(tick));
  return Number((Math.round(value / tick) * tick).toFixed(places));
}

type ExchangeRules = {
  quantityStep: number;
  minimumQuantity: number;
  minimumNotional: number;
  priceTick: number;
};

type CandlePoint = {
  close: number;
  closeTimeMs: number;
};

type PendingSignal = {
  createdAtMs: number;
  candleCloseTimeMs: number;
  candleClosePrice: number;
  rollingLow: number;
  rollingChangePct: number;
  closes: number[];
};

type PositionRow = {
  position_id: string;
  symbol: string;
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

type OpenPosition = {
  positionId: string;
  symbol: string;
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

type BinanceKlineEvent = {
  e: "kline";
  E: number;
  s: string;
  k: {
    t: number;
    T: number;
    c: string;
    x: boolean;
  };
};

type BinanceAggTradeEvent = {
  e: "aggTrade";
  E: number;
  s: string;
  p: string;
  T: number;
};

const finite = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

function hydratePosition(row: PositionRow): OpenPosition {
  return {
    positionId: row.position_id,
    symbol: row.symbol,
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
  };
}

class BinancePumpFadePaperBot {
  private readonly supabase = getSupabaseAdmin({ noStore: true });
  private exchangeRules: ExchangeRules | null = null;
  private recentCandles: CandlePoint[] = [];
  private openPosition: OpenPosition | null = null;
  private pendingSignal: PendingSignal | null = null;
  private socket: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastSocketMessageAtMs = 0;
  private lastHeartbeatWriteAtMs = 0;
  private lastPositionWriteAtMs = 0;
  private closingPosition = false;
  private openingPosition = false;
  private stopped = false;

  async start(): Promise<void> {
    await this.loadOpenPosition();
    await Promise.allSettled([this.loadExchangeRules(), this.seedRecentCandles()]);
    this.startWatchdog();
    this.connect();
    console.log(
      `[binance-futures-paper] active ${BINANCE_FUTURES_PAPER_CONFIG.symbol} ` +
        `${BINANCE_FUTURES_PAPER_CONFIG.leverage}x isolated simulation; ` +
        `pump ${BINANCE_FUTURES_PAPER_CONFIG.pumpThresholdPct}%/${BINANCE_FUTURES_PAPER_CONFIG.lookbackCandles}m; ` +
        `SL ${BINANCE_FUTURES_PAPER_CONFIG.stopLossPct}% TP ${BINANCE_FUTURES_PAPER_CONFIG.takeProfitPct}%`
    );
  }

  private async loadOpenPosition(): Promise<void> {
    const { data, error } = await this.supabase
      .from("binance_futures_positions")
      .select(
        "position_id,symbol,leverage,requested_margin_usdt,margin_usdt,notional_usdt,quantity,signal_price,entry_fill_price,stop_loss_price,take_profit_price,entry_fee_usdt,lowest_price_seen,highest_price_seen,last_market_price,opened_at,last_checked_at,signal_snapshot"
      )
      .maybeSingle();
    if (error) throw new Error(`Unable to load Binance paper position: ${error.message}`);
    if (data) {
      this.openPosition = hydratePosition(data as PositionRow);
      console.log(
        `[binance-futures-paper] recovered open SHORT ${this.openPosition.symbol} @ ${this.openPosition.entryFillPrice}`
      );
    }
  }

  private async loadExchangeRules(): Promise<void> {
    const response = await fetch(`${BINANCE_FUTURES_PAPER_CONFIG.restBaseUrl}/fapi/v1/exchangeInfo`, {
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`Binance exchangeInfo HTTP ${response.status}`);
    const payload = (await response.json()) as any;
    const symbol = (payload.symbols ?? []).find(
      (row: any) => String(row.symbol).toUpperCase() === BINANCE_FUTURES_PAPER_CONFIG.symbol
    );
    if (!symbol) throw new Error(`Binance symbol ${BINANCE_FUTURES_PAPER_CONFIG.symbol} not found`);
    const filters = Array.isArray(symbol.filters) ? symbol.filters : [];
    const quantityFilter =
      filters.find((row: any) => row.filterType === "MARKET_LOT_SIZE") ??
      filters.find((row: any) => row.filterType === "LOT_SIZE");
    const priceFilter = filters.find((row: any) => row.filterType === "PRICE_FILTER");
    const notionalFilter = filters.find((row: any) => row.filterType === "MIN_NOTIONAL");
    const rules: ExchangeRules = {
      quantityStep: finite(quantityFilter?.stepSize),
      minimumQuantity: finite(quantityFilter?.minQty),
      minimumNotional: finite(notionalFilter?.notional),
      priceTick: finite(priceFilter?.tickSize),
    };
    if (rules.quantityStep <= 0 || rules.minimumQuantity <= 0 || rules.priceTick <= 0) {
      throw new Error(`Incomplete Binance exchange filters for ${BINANCE_FUTURES_PAPER_CONFIG.symbol}`);
    }
    this.exchangeRules = rules;
    console.log(
      `[binance-futures-paper] exchange filters qtyStep=${rules.quantityStep} minQty=${rules.minimumQuantity} minNotional=${rules.minimumNotional}`
    );
  }

  private async seedRecentCandles(): Promise<void> {
    const limit = BINANCE_FUTURES_PAPER_CONFIG.lookbackCandles + 3;
    const url =
      `${BINANCE_FUTURES_PAPER_CONFIG.restBaseUrl}/fapi/v1/klines?symbol=` +
      `${encodeURIComponent(BINANCE_FUTURES_PAPER_CONFIG.symbol)}&interval=1m&limit=${limit}`;
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`Binance klines HTTP ${response.status}`);
    const rows = (await response.json()) as any[];
    const now = Date.now();
    this.recentCandles = rows
      .map((row) => ({ close: finite(row?.[4]), closeTimeMs: finite(row?.[6]) }))
      .filter((row) => row.close > 0 && row.closeTimeMs > 0 && row.closeTimeMs < now)
      .slice(-BINANCE_FUTURES_PAPER_CONFIG.lookbackCandles);
    console.log(`[binance-futures-paper] seeded ${this.recentCandles.length} closed 1m candles`);
  }

  private startWatchdog(): void {
    this.watchdogTimer = setInterval(() => {
      if (this.stopped) return;
      const now = Date.now();
      if (
        this.socket &&
        this.socket.readyState === WebSocket.OPEN &&
        this.lastSocketMessageAtMs > 0 &&
        now - this.lastSocketMessageAtMs > BINANCE_FUTURES_PAPER_CONFIG.staleSocketMs
      ) {
        console.warn("[binance-futures-paper] websocket stale; reconnecting");
        this.socket.close();
      }
      if (this.openPosition && this.openPosition.lastMarketPrice > 0) {
        void this.evaluateExit(this.openPosition.lastMarketPrice, now);
      }
    }, BINANCE_FUTURES_PAPER_CONFIG.heartbeatIntervalMs);
  }

  private connect(): void {
    if (this.stopped) return;
    if (typeof WebSocket === "undefined") {
      console.error("[binance-futures-paper] WebSocket is unavailable in this Node runtime");
      this.scheduleReconnect();
      return;
    }
    const streamSymbol = BINANCE_FUTURES_PAPER_CONFIG.symbol.toLowerCase();
    const url =
      `${BINANCE_FUTURES_PAPER_CONFIG.websocketBaseUrl}/stream?streams=` +
      `${streamSymbol}@kline_1m/${streamSymbol}@aggTrade`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      this.lastSocketMessageAtMs = Date.now();
      console.log(`[binance-futures-paper] websocket connected ${url}`);
    });

    socket.addEventListener("message", (event) => {
      void this.handleSocketMessage(event.data).catch((error) => {
        console.error("[binance-futures-paper] message handler failed:", error);
      });
    });

    socket.addEventListener("error", () => {
      console.error("[binance-futures-paper] websocket error");
    });

    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = null;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(60_000, 1_000 * 2 ** Math.min(this.reconnectAttempt, 6));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    console.log(`[binance-futures-paper] reconnect scheduled in ${delay}ms`);
  }

  private async messageText(data: unknown): Promise<string> {
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
    if (typeof Blob !== "undefined" && data instanceof Blob) return data.text();
    return String(data);
  }

  private async handleSocketMessage(data: unknown): Promise<void> {
    const text = await this.messageText(data);
    const envelope = JSON.parse(text) as { data?: BinanceKlineEvent | BinanceAggTradeEvent };
    const event = envelope.data ?? (envelope as unknown as BinanceKlineEvent | BinanceAggTradeEvent);
    this.lastSocketMessageAtMs = Date.now();

    if (event.e === "kline") {
      await this.handleKline(event);
    } else if (event.e === "aggTrade") {
      await this.handleTrade(event);
    }
  }

  private async handleKline(event: BinanceKlineEvent): Promise<void> {
    if (!event.k.x) return;
    const close = finite(event.k.c);
    const closeTimeMs = finite(event.k.T);
    if (close <= 0 || closeTimeMs <= 0) return;
    if (this.recentCandles.some((row) => row.closeTimeMs === closeTimeMs)) return;

    this.recentCandles.push({ close, closeTimeMs });
    this.recentCandles = this.recentCandles.slice(-BINANCE_FUTURES_PAPER_CONFIG.lookbackCandles);
    const closes = this.recentCandles.map((row) => row.close);
    const measurement = calculatePumpMeasurement(closes);

    await this.supabase
      .from("binance_futures_state")
      .update({ last_candle_close_time: new Date(closeTimeMs).toISOString(), updated_at: new Date().toISOString() })
      .eq("id", 1);

    if (!measurement || closes.length < BINANCE_FUTURES_PAPER_CONFIG.lookbackCandles) {
      await this.logScan(closeTimeMs, close, measurement, false, "warming_up", "insufficient_closed_candles");
      return;
    }

    const triggered = measurement.changePct >= BINANCE_FUTURES_PAPER_CONFIG.pumpThresholdPct;
    const { data: state, error } = await this.supabase
      .from("binance_futures_state")
      .select("enabled,halted,halt_reason,cooldown_until")
      .eq("id", 1)
      .single();

    if (error) {
      await this.logScan(closeTimeMs, close, measurement, triggered, "error", `state_read_failed:${error.message}`);
      return;
    }

    if (!state.enabled || state.halted) {
      await this.logScan(
        closeTimeMs,
        close,
        measurement,
        triggered,
        "halted",
        state.halt_reason || (state.enabled ? "halted" : "disabled")
      );
      return;
    }

    if (this.openPosition || this.openingPosition || this.closingPosition) {
      await this.logScan(closeTimeMs, close, measurement, triggered, "position_open", "one_position_limit");
      return;
    }

    const cooldownUntil = state.cooldown_until ? Date.parse(state.cooldown_until) : 0;
    if (cooldownUntil > Date.now()) {
      await this.logScan(closeTimeMs, close, measurement, triggered, "cooldown", "post_trade_cooldown");
      return;
    }

    if (!triggered) {
      await this.logScan(closeTimeMs, close, measurement, false, "monitor", "pump_threshold_not_reached");
      return;
    }

    this.pendingSignal = {
      createdAtMs: Date.now(),
      candleCloseTimeMs: closeTimeMs,
      candleClosePrice: close,
      rollingLow: measurement.rollingLow,
      rollingChangePct: measurement.changePct,
      closes,
    };
    await this.logScan(closeTimeMs, close, measurement, true, "signal_pending", "awaiting_next_market_trade");
    console.log(
      `[binance-futures-paper] SHORT signal ${BINANCE_FUTURES_PAPER_CONFIG.symbol} ` +
        `${measurement.changePct.toFixed(2)}% over ${BINANCE_FUTURES_PAPER_CONFIG.lookbackCandles} closed candles`
    );
  }

  private async handleTrade(event: BinanceAggTradeEvent): Promise<void> {
    const marketPrice = finite(event.p);
    const tradeTimeMs = finite(event.T || event.E) || Date.now();
    if (marketPrice <= 0) return;

    if (this.openPosition) {
      this.openPosition.lastMarketPrice = marketPrice;
      this.openPosition.lastCheckedAtMs = tradeTimeMs;
      this.openPosition.lowestPriceSeen = Math.min(this.openPosition.lowestPriceSeen, marketPrice);
      this.openPosition.highestPriceSeen = Math.max(this.openPosition.highestPriceSeen, marketPrice);
      await this.evaluateExit(marketPrice, tradeTimeMs);
      await this.maybePersistPosition();
    } else if (this.pendingSignal && !this.openingPosition) {
      if (tradeTimeMs >= this.pendingSignal.createdAtMs) {
        await this.openPendingSignal(marketPrice, tradeTimeMs);
      }
    }

    await this.maybeWriteHeartbeat(marketPrice, tradeTimeMs);
  }

  private async openPendingSignal(marketPrice: number, openedAtMs: number): Promise<void> {
    const signal = this.pendingSignal;
    if (!signal) return;
    if (Date.now() - signal.createdAtMs > BINANCE_FUTURES_PAPER_CONFIG.pendingSignalTtlMs) {
      this.pendingSignal = null;
      console.warn("[binance-futures-paper] pending signal expired before simulated fill");
      return;
    }

    this.openingPosition = true;
    try {
      if (!this.exchangeRules) await this.loadExchangeRules();
      const rules = this.exchangeRules!;
      const entryFillPrice = marketPrice * (1 - BINANCE_FUTURES_PAPER_CONFIG.slippagePctPerSide / 100);
      const requestedNotional =
        BINANCE_FUTURES_PAPER_CONFIG.marginBudgetUsdt * BINANCE_FUTURES_PAPER_CONFIG.leverage;
      const quantity = floorToStep(requestedNotional / entryFillPrice, rules.quantityStep);
      const notionalUsdt = quantity * entryFillPrice;
      const marginUsdt = notionalUsdt / BINANCE_FUTURES_PAPER_CONFIG.leverage;

      if (quantity < rules.minimumQuantity || quantity <= 0) {
        throw new Error(`quantity ${quantity} below Binance minimum ${rules.minimumQuantity}`);
      }
      if (rules.minimumNotional > 0 && notionalUsdt < rules.minimumNotional) {
        throw new Error(`notional ${notionalUsdt} below Binance minimum ${rules.minimumNotional}`);
      }

      const entryFeeUsdt = notionalUsdt * (BINANCE_FUTURES_PAPER_CONFIG.takerFeePctPerSide / 100);
      const stopLossPrice = roundToTick(
        entryFillPrice * (1 + BINANCE_FUTURES_PAPER_CONFIG.stopLossPct / 100),
        rules.priceTick
      );
      const takeProfitPrice = roundToTick(
        entryFillPrice * (1 - BINANCE_FUTURES_PAPER_CONFIG.takeProfitPct / 100),
        rules.priceTick
      );
      const positionId = randomUUID();
      const signalSnapshot = {
        strategy_version: "binance_btc_pump_fade_paper_v1_2026_07_22",
        paper_only: true,
        symbol: BINANCE_FUTURES_PAPER_CONFIG.symbol,
        signal_candle_close_time: new Date(signal.candleCloseTimeMs).toISOString(),
        signal_candle_close_price: signal.candleClosePrice,
        simulated_market_price: marketPrice,
        rolling_low_price: signal.rollingLow,
        rolling_change_pct: signal.rollingChangePct,
        recent_closes: signal.closes,
        lookback_candles: BINANCE_FUTURES_PAPER_CONFIG.lookbackCandles,
        pump_threshold_pct: BINANCE_FUTURES_PAPER_CONFIG.pumpThresholdPct,
        leverage: BINANCE_FUTURES_PAPER_CONFIG.leverage,
        requested_margin_usdt: BINANCE_FUTURES_PAPER_CONFIG.marginBudgetUsdt,
        taker_fee_pct_per_side: BINANCE_FUTURES_PAPER_CONFIG.takerFeePctPerSide,
        slippage_pct_per_side: BINANCE_FUTURES_PAPER_CONFIG.slippagePctPerSide,
        quantity_step: rules.quantityStep,
        price_tick: rules.priceTick,
      };

      const { error } = await this.supabase.rpc("binance_futures_open_paper_position", {
        p_position_id: positionId,
        p_symbol: BINANCE_FUTURES_PAPER_CONFIG.symbol,
        p_leverage: BINANCE_FUTURES_PAPER_CONFIG.leverage,
        p_requested_margin_usdt: BINANCE_FUTURES_PAPER_CONFIG.marginBudgetUsdt,
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
        p_max_daily_entries: BINANCE_FUTURES_PAPER_CONFIG.maxDailyEntries,
      });
      if (error) throw new Error(error.message);

      this.openPosition = {
        positionId,
        symbol: BINANCE_FUTURES_PAPER_CONFIG.symbol,
        leverage: BINANCE_FUTURES_PAPER_CONFIG.leverage,
        requestedMarginUsdt: BINANCE_FUTURES_PAPER_CONFIG.marginBudgetUsdt,
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
      };
      this.pendingSignal = null;
      this.lastPositionWriteAtMs = openedAtMs;

      const message = [
        "📉 <b>BINANCE FUTURES PAPER SHORT</b>",
        "",
        `Symbol: <b>${BINANCE_FUTURES_PAPER_CONFIG.symbol}</b>`,
        `Pump signal: <b>+${signal.rollingChangePct.toFixed(2)}%</b>`,
        `Entry: <b>$${entryFillPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}</b>`,
        `Quantity: <b>${quantity}</b>`,
        `Notional: <b>$${notionalUsdt.toFixed(2)}</b>`,
        `Isolated margin: <b>$${marginUsdt.toFixed(2)}</b> @ ${BINANCE_FUTURES_PAPER_CONFIG.leverage}x`,
        `Stop: <b>$${stopLossPrice.toLocaleString()}</b>`,
        `Target: <b>$${takeProfitPrice.toLocaleString()}</b>`,
        "",
        "🧪 Paper simulation only — no Binance order was placed.",
      ].join("\n");
      void sendTelegramAlert(message);
      console.log(
        `[binance-futures-paper] opened SHORT ${quantity} ${BINANCE_FUTURES_PAPER_CONFIG.symbol} @ ${entryFillPrice}`
      );
    } catch (error) {
      this.pendingSignal = null;
      console.error("[binance-futures-paper] entry failed:", error);
    } finally {
      this.openingPosition = false;
    }
  }

  private async evaluateExit(marketPrice: number, checkedAtMs: number): Promise<void> {
    const position = this.openPosition;
    if (!position || this.closingPosition) return;
    let reason: "take_profit" | "stop_loss" | "max_hold_time" | null = null;
    if (marketPrice >= position.stopLossPrice) reason = "stop_loss";
    else if (marketPrice <= position.takeProfitPrice) reason = "take_profit";
    else if (checkedAtMs - position.openedAtMs >= BINANCE_FUTURES_PAPER_CONFIG.maxHoldMinutes * 60_000) {
      reason = "max_hold_time";
    }
    if (reason) await this.closePosition(reason, marketPrice, checkedAtMs);
  }

  private async closePosition(
    reason: "take_profit" | "stop_loss" | "max_hold_time",
    marketPrice: number,
    closedAtMs: number
  ): Promise<void> {
    const position = this.openPosition;
    if (!position || this.closingPosition) return;
    this.closingPosition = true;
    try {
      const calculation = calculateShortTrade({
        entryFillPrice: position.entryFillPrice,
        marketExitPrice: marketPrice,
        quantity: position.quantity,
        marginUsdt: position.marginUsdt,
        entryFeeUsdt: position.entryFeeUsdt,
        exitSlippagePct: BINANCE_FUTURES_PAPER_CONFIG.slippagePctPerSide,
        feePct: BINANCE_FUTURES_PAPER_CONFIG.takerFeePctPerSide,
      });
      const cooldownUntil = new Date(
        closedAtMs + BINANCE_FUTURES_PAPER_CONFIG.cooldownMinutes * 60_000
      ).toISOString();
      const exitSnapshot = {
        paper_only: true,
        market_exit_price: marketPrice,
        simulated_exit_fill_price: calculation.exitFillPrice,
        lowest_price_seen: position.lowestPriceSeen,
        highest_price_seen: position.highestPriceSeen,
        hold_seconds: Math.max(0, (closedAtMs - position.openedAtMs) / 1000),
        fee_pct_per_side: BINANCE_FUTURES_PAPER_CONFIG.takerFeePctPerSide,
        slippage_pct_per_side: BINANCE_FUTURES_PAPER_CONFIG.slippagePctPerSide,
      };

      const { data, error } = await this.supabase.rpc("binance_futures_close_paper_position", {
        p_position_id: position.positionId,
        p_exit_market_price: marketPrice,
        p_exit_fill_price: calculation.exitFillPrice,
        p_exit_fee_usdt: calculation.exitFeeUsdt,
        p_gross_pnl_usdt: calculation.grossPnlUsdt,
        p_net_pnl_usdt: calculation.netPnlUsdt,
        p_price_return_pct: calculation.priceReturnPct,
        p_margin_return_pct: calculation.marginReturnPct,
        p_exit_reason: reason,
        p_closed_at: new Date(closedAtMs).toISOString(),
        p_cooldown_until: cooldownUntil,
        p_exit_snapshot: exitSnapshot,
        p_daily_loss_limit_usdt: BINANCE_FUTURES_PAPER_CONFIG.dailyLossLimitUsdt,
        p_max_consecutive_losses: BINANCE_FUTURES_PAPER_CONFIG.maxConsecutiveLosses,
        p_max_daily_entries: BINANCE_FUTURES_PAPER_CONFIG.maxDailyEntries,
      });
      if (error) throw new Error(error.message);

      const result = (data ?? {}) as Record<string, unknown>;
      const icon = calculation.netPnlUsdt >= 0 ? "✅" : "❌";
      const message = [
        `${icon} <b>BINANCE FUTURES PAPER CLOSED</b>`,
        "",
        `Symbol: <b>${position.symbol}</b> SHORT`,
        `Reason: <b>${reason}</b>`,
        `Entry: <b>$${position.entryFillPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}</b>`,
        `Exit: <b>$${calculation.exitFillPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}</b>`,
        `Net PnL: <b>${calculation.netPnlUsdt >= 0 ? "+" : ""}$${calculation.netPnlUsdt.toFixed(2)}</b>`,
        `Margin return: <b>${calculation.marginReturnPct >= 0 ? "+" : ""}${calculation.marginReturnPct.toFixed(2)}%</b>`,
        `Paper bankroll: <b>$${finite(result.bankrollUsdt).toFixed(2)}</b>`,
        "",
        "🧪 Paper simulation only.",
      ].join("\n");
      void sendTelegramAlert(message);
      console.log(
        `[binance-futures-paper] closed ${position.symbol} ${reason}; net $${calculation.netPnlUsdt.toFixed(2)}`
      );
      this.openPosition = null;
      this.pendingSignal = null;
    } catch (error) {
      console.error("[binance-futures-paper] close failed:", error);
    } finally {
      this.closingPosition = false;
    }
  }

  private async maybePersistPosition(): Promise<void> {
    const position = this.openPosition;
    if (!position) return;
    const now = Date.now();
    if (now - this.lastPositionWriteAtMs < BINANCE_FUTURES_PAPER_CONFIG.positionWriteIntervalMs) return;
    this.lastPositionWriteAtMs = now;
    const { error } = await this.supabase
      .from("binance_futures_positions")
      .update({
        lowest_price_seen: position.lowestPriceSeen,
        highest_price_seen: position.highestPriceSeen,
        last_market_price: position.lastMarketPrice,
        last_checked_at: new Date(position.lastCheckedAtMs).toISOString(),
        updated_at: new Date(now).toISOString(),
      })
      .eq("position_id", position.positionId);
    if (error) console.error("[binance-futures-paper] position update failed:", error.message);
  }

  private async maybeWriteHeartbeat(marketPrice: number, messageTimeMs: number): Promise<void> {
    const now = Date.now();
    if (now - this.lastHeartbeatWriteAtMs < BINANCE_FUTURES_PAPER_CONFIG.heartbeatIntervalMs) return;
    this.lastHeartbeatWriteAtMs = now;
    const { error } = await this.supabase
      .from("binance_futures_state")
      .update({
        last_market_price: marketPrice,
        last_ws_message_at: new Date(messageTimeMs).toISOString(),
        updated_at: new Date(now).toISOString(),
      })
      .eq("id", 1);
    if (error) console.error("[binance-futures-paper] heartbeat update failed:", error.message);
  }

  private async logScan(
    closeTimeMs: number,
    closePrice: number,
    measurement: PumpMeasurement | null,
    triggered: boolean,
    action: "warming_up" | "monitor" | "signal_pending" | "position_open" | "cooldown" | "halted" | "error",
    reason: string
  ): Promise<void> {
    const { error } = await this.supabase.from("binance_futures_scan_runs").upsert(
      {
        symbol: BINANCE_FUTURES_PAPER_CONFIG.symbol,
        candle_close_time: new Date(closeTimeMs).toISOString(),
        close_price: closePrice,
        rolling_low_price: measurement?.rollingLow ?? null,
        rolling_change_pct: measurement?.changePct ?? null,
        trigger_threshold_pct: BINANCE_FUTURES_PAPER_CONFIG.pumpThresholdPct,
        triggered,
        action,
        reason,
        snapshot: {
          closes: this.recentCandles.map((row) => row.close),
          lookback_candles: BINANCE_FUTURES_PAPER_CONFIG.lookbackCandles,
          open_position: this.openPosition?.positionId ?? null,
          pending_signal: Boolean(this.pendingSignal),
        },
      },
      { onConflict: "symbol,candle_close_time" }
    );
    if (error) console.error("[binance-futures-paper] scan log failed:", error.message);
  }
}

let started = false;

export function startBinanceFuturesPaperScheduler(): void {
  if (started) return;
  started = true;
  if (!BINANCE_FUTURES_PAPER_CONFIG.enabled) {
    console.log("[binance-futures-paper] disabled by ENABLE_BINANCE_FUTURES_PAPER=false");
    return;
  }
  const bot = new BinancePumpFadePaperBot();
  void bot.start().catch((error) => {
    console.error("[binance-futures-paper] startup failed:", error);
  });
}
