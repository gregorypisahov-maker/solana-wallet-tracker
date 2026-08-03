import { getSupabaseAdmin } from "../lib/supabase";
import { sendTelegramAlert } from "../lib/telegram";

type Candle = {
  open: number;
  high: number;
  low: number;
  close: number;
  quoteVolume: number;
  closeTimeMs: number;
};

type Side = "long" | "short";

type Position = {
  tradeId: number;
  side: Side;
  entryPrice: number;
  stopPrice: number;
  takeProfitPrice: number;
  highWaterPrice: number;
  lowWaterPrice: number;
  marginUsdt: number;
  notionalUsdt: number;
  openedAt: string;
  signalSnapshot: Record<string, unknown>;
};

const CONFIG = {
  enabled: !["0", "false", "off", "no"].includes((process.env.ENABLE_SOL_EMA_10X_PAPER ?? "true").toLowerCase()),
  symbol: "SOLUSDT",
  restBaseUrl: (process.env.BINANCE_SPOT_REST_URL ?? "https://data-api.binance.vision").replace(/\/$/, ""),
  intervalMs: Math.max(15_000, Number(process.env.SOL_EMA_10X_SCAN_MS ?? 30_000)),
  leverage: 10,
  marginPct: 10,
  minMarginUsdt: 5,
  maxMarginUsdt: 50,
  stopPct: 0.8,
  takeProfitPct: 1.6,
  trailingActivationPct: 0.9,
  trailingGivebackPct: 0.45,
  maxHoldMinutes: 180,
  maxDailyEntries: 6,
  maxDailyLossUsdt: 15,
  maxConsecutiveLosses: 3,
  feePctPerSideOnNotional: 0.04,
} as const;

const finite = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  for (let index = period; index < values.length; index += 1) {
    value = values[index] * multiplier + value * (1 - multiplier);
  }
  return value;
}

function rsi(values: number[], period = 14): number | null {
  if (values.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, change)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -change)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

async function fetchJson(url: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`market_data_http_${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCandles(interval: "15m" | "1h", limit: number): Promise<Candle[]> {
  const rows = await fetchJson(
    `${CONFIG.restBaseUrl}/api/v3/klines?symbol=${CONFIG.symbol}&interval=${interval}&limit=${limit}`
  );
  if (!Array.isArray(rows)) throw new Error("invalid_kline_payload");
  const now = Date.now();
  return rows
    .map((row: any[]) => ({
      open: finite(row[1]),
      high: finite(row[2]),
      low: finite(row[3]),
      close: finite(row[4]),
      quoteVolume: finite(row[7]),
      closeTimeMs: finite(row[6]),
    }))
    .filter((candle: Candle) => candle.close > 0 && candle.closeTimeMs < now);
}

function buildSignal(fifteen: Candle[], hourly: Candle[]) {
  const closes = fifteen.map((candle) => candle.close);
  const hourCloses = hourly.map((candle) => candle.close);
  const latest = fifteen.at(-1)!;
  const previous = fifteen.at(-2)!;
  const e7 = ema(closes, 7) ?? 0;
  const e25 = ema(closes, 25) ?? 0;
  const e99 = ema(closes, 99) ?? 0;
  const prevE7 = ema(closes.slice(0, -1), 7) ?? 0;
  const prevE25 = ema(closes.slice(0, -1), 25) ?? 0;
  const hourE25 = ema(hourCloses, 25) ?? 0;
  const hourE99 = ema(hourCloses, 99) ?? 0;
  const momentum = rsi(closes, 14) ?? 50;
  const avgVolume = fifteen.slice(-21, -1).reduce((sum, candle) => sum + candle.quoteVolume, 0) / 20;
  const volumeRatio = avgVolume > 0 ? latest.quoteVolume / avgVolume : 0;
  const bullishCross = prevE7 <= prevE25 && e7 > e25;
  const bearishCross = prevE7 >= prevE25 && e7 < e25;
  const bullishCompression = Math.abs(e7 - e25) / latest.close <= 0.0012 && e7 >= e25;
  const bearishCompression = Math.abs(e7 - e25) / latest.close <= 0.0012 && e7 <= e25;

  const longPassed =
    (bullishCross || bullishCompression) &&
    latest.close > e7 &&
    latest.close > previous.close &&
    e7 > prevE7 &&
    e25 >= prevE25 &&
    latest.close >= e99 * 0.997 &&
    hourE25 >= hourE99 * 0.995 &&
    momentum >= 48 && momentum <= 68 &&
    volumeRatio >= 0.8;

  const shortPassed =
    (bearishCross || bearishCompression) &&
    latest.close < e7 &&
    latest.close < previous.close &&
    e7 < prevE7 &&
    e25 <= prevE25 &&
    latest.close <= e99 * 1.003 &&
    hourE25 <= hourE99 * 1.005 &&
    momentum >= 32 && momentum <= 52 &&
    volumeRatio >= 0.8;

  return {
    side: longPassed ? ("long" as const) : shortPassed ? ("short" as const) : null,
    price: latest.close,
    snapshot: {
      strategy: "sol_ema_7_25_99_10x_paper_v1",
      candleCloseTime: new Date(latest.closeTimeMs).toISOString(),
      ema7: e7,
      ema25: e25,
      ema99: e99,
      previousEma7: prevE7,
      previousEma25: prevE25,
      hourlyEma25: hourE25,
      hourlyEma99: hourE99,
      rsi14: momentum,
      relativeVolume: volumeRatio,
      bullishCross,
      bearishCross,
      bullishCompression,
      bearishCompression,
      longPassed,
      shortPassed,
    },
  };
}

function positionFromState(value: unknown): Position | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (!row.tradeId || !row.side || !row.entryPrice) return null;
  return {
    tradeId: finite(row.tradeId),
    side: row.side === "short" ? "short" : "long",
    entryPrice: finite(row.entryPrice),
    stopPrice: finite(row.stopPrice),
    takeProfitPrice: finite(row.takeProfitPrice),
    highWaterPrice: finite(row.highWaterPrice),
    lowWaterPrice: finite(row.lowWaterPrice),
    marginUsdt: finite(row.marginUsdt),
    notionalUsdt: finite(row.notionalUsdt),
    openedAt: String(row.openedAt),
    signalSnapshot: (row.signalSnapshot as Record<string, unknown>) ?? {},
  };
}

function calculatePnl(position: Position, exitPrice: number) {
  const direction = position.side === "long" ? 1 : -1;
  const gross = direction * ((exitPrice - position.entryPrice) / position.entryPrice) * position.notionalUsdt;
  const fees = position.notionalUsdt * (CONFIG.feePctPerSideOnNotional / 100) * 2;
  const net = gross - fees;
  return { net, pctOnMargin: position.marginUsdt > 0 ? (net / position.marginUsdt) * 100 : 0 };
}

async function closePosition(state: any, position: Position, exitPrice: number, reason: string): Promise<void> {
  const supabase = getSupabaseAdmin({ noStore: true });
  const now = new Date().toISOString();
  const { net, pctOnMargin } = calculatePnl(position, exitPrice);
  const bankroll = finite(state.bankroll_usdt) + net;
  const dailyPnl = finite(state.daily_realized_pnl_usdt) + net;
  const losses = net < 0 ? finite(state.consecutive_losses) + 1 : 0;
  const halted = dailyPnl <= -CONFIG.maxDailyLossUsdt || losses >= CONFIG.maxConsecutiveLosses;
  const haltReason = dailyPnl <= -CONFIG.maxDailyLossUsdt
    ? "daily_loss_limit"
    : losses >= CONFIG.maxConsecutiveLosses
      ? "consecutive_loss_limit"
      : null;

  const { error: tradeError } = await supabase
    .from("sol_ema_10x_trades")
    .update({
      status: "closed",
      closed_at: now,
      exit_price: exitPrice,
      exit_reason: reason,
      pnl_usdt: net,
      pnl_pct_on_margin: pctOnMargin,
      high_water_price: position.highWaterPrice,
      low_water_price: position.lowWaterPrice,
      updated_at: now,
    })
    .eq("id", position.tradeId);
  if (tradeError) throw new Error(tradeError.message);

  const { error: stateError } = await supabase
    .from("sol_ema_10x_state")
    .update({
      bankroll_usdt: bankroll,
      daily_realized_pnl_usdt: dailyPnl,
      consecutive_losses: losses,
      open_position: null,
      halted,
      halt_reason: haltReason,
      last_heartbeat_at: now,
      updated_at: now,
    })
    .eq("id", 1);
  if (stateError) throw new Error(stateError.message);

  await sendTelegramAlert(
    `${net >= 0 ? "✅" : "❌"} SOL EMA 10× PAPER ${position.side.toUpperCase()} CLOSED\n` +
      `Exit: ${reason}\nPnL: ${net >= 0 ? "+" : ""}${net.toFixed(2)} USDT (${pctOnMargin.toFixed(1)}% margin)\n` +
      `Entry: ${position.entryPrice.toFixed(2)} → Exit: ${exitPrice.toFixed(2)}`
  ).catch(() => undefined);
}

async function openPosition(state: any, side: Side, price: number, snapshot: Record<string, unknown>): Promise<void> {
  const supabase = getSupabaseAdmin({ noStore: true });
  const bankroll = finite(state.bankroll_usdt);
  const marginUsdt = Math.min(CONFIG.maxMarginUsdt, Math.max(CONFIG.minMarginUsdt, bankroll * (CONFIG.marginPct / 100)));
  if (marginUsdt > bankroll || marginUsdt <= 0) return;
  const notionalUsdt = marginUsdt * CONFIG.leverage;
  const stopPrice = side === "long" ? price * (1 - CONFIG.stopPct / 100) : price * (1 + CONFIG.stopPct / 100);
  const takeProfitPrice = side === "long"
    ? price * (1 + CONFIG.takeProfitPct / 100)
    : price * (1 - CONFIG.takeProfitPct / 100);
  const now = new Date().toISOString();

  const { data: trade, error: tradeError } = await supabase
    .from("sol_ema_10x_trades")
    .insert({
      status: "open",
      side,
      symbol: CONFIG.symbol,
      leverage: CONFIG.leverage,
      margin_usdt: marginUsdt,
      notional_usdt: notionalUsdt,
      entry_price: price,
      stop_price: stopPrice,
      take_profit_price: takeProfitPrice,
      high_water_price: price,
      low_water_price: price,
      signal_snapshot: snapshot,
      updated_at: now,
    })
    .select("id")
    .single();
  if (tradeError) throw new Error(tradeError.message);

  const position: Position = {
    tradeId: Number(trade.id),
    side,
    entryPrice: price,
    stopPrice,
    takeProfitPrice,
    highWaterPrice: price,
    lowWaterPrice: price,
    marginUsdt,
    notionalUsdt,
    openedAt: now,
    signalSnapshot: snapshot,
  };

  const { error: stateError } = await supabase
    .from("sol_ema_10x_state")
    .update({
      open_position: position,
      entries_today: finite(state.entries_today) + 1,
      last_signal: snapshot,
      last_heartbeat_at: now,
      updated_at: now,
    })
    .eq("id", 1);
  if (stateError) throw new Error(stateError.message);

  await sendTelegramAlert(
    `🟡 SOL EMA 10× PAPER ${side.toUpperCase()} OPENED\n` +
      `Entry: ${price.toFixed(2)}\nMargin: ${marginUsdt.toFixed(2)} USDT · Notional: ${notionalUsdt.toFixed(2)} USDT\n` +
      `Stop: ${stopPrice.toFixed(2)} · Target: ${takeProfitPrice.toFixed(2)}`
  ).catch(() => undefined);
}

async function processOnce(): Promise<void> {
  const supabase = getSupabaseAdmin({ noStore: true });
  const now = new Date();
  const nowIso = now.toISOString();
  const { data: state, error } = await supabase.from("sol_ema_10x_state").select("*").eq("id", 1).single();
  if (error) throw new Error(error.message);

  const utcDate = nowIso.slice(0, 10);
  if (state.daily_date !== utcDate) {
    const { error: resetError } = await supabase
      .from("sol_ema_10x_state")
      .update({ daily_date: utcDate, entries_today: 0, daily_realized_pnl_usdt: 0, consecutive_losses: 0, halted: false, halt_reason: null, updated_at: nowIso })
      .eq("id", 1);
    if (resetError) throw new Error(resetError.message);
    state.daily_date = utcDate;
    state.entries_today = 0;
    state.daily_realized_pnl_usdt = 0;
    state.consecutive_losses = 0;
    state.halted = false;
  }

  if (!CONFIG.enabled || state.enabled === false) {
    await supabase.from("sol_ema_10x_state").update({ last_heartbeat_at: nowIso, updated_at: nowIso }).eq("id", 1);
    return;
  }

  const fifteen = await fetchCandles("15m", 160);
  const hourly = await fetchCandles("1h", 160);
  const signal = buildSignal(fifteen, hourly);
  const price = signal.price;
  const position = positionFromState(state.open_position);

  if (position) {
    position.highWaterPrice = Math.max(position.highWaterPrice, price);
    position.lowWaterPrice = Math.min(position.lowWaterPrice, price);
    const ageMinutes = (Date.now() - Date.parse(position.openedAt)) / 60_000;
    const favorablePct = position.side === "long"
      ? ((position.highWaterPrice - position.entryPrice) / position.entryPrice) * 100
      : ((position.entryPrice - position.lowWaterPrice) / position.entryPrice) * 100;
    const trailingTriggered = favorablePct >= CONFIG.trailingActivationPct;
    const trailingPrice = position.side === "long"
      ? position.highWaterPrice * (1 - CONFIG.trailingGivebackPct / 100)
      : position.lowWaterPrice * (1 + CONFIG.trailingGivebackPct / 100);

    let reason: string | null = null;
    if (position.side === "long" && price <= position.stopPrice) reason = "hard_stop";
    if (position.side === "short" && price >= position.stopPrice) reason = "hard_stop";
    if (!reason && position.side === "long" && price >= position.takeProfitPrice) reason = "take_profit";
    if (!reason && position.side === "short" && price <= position.takeProfitPrice) reason = "take_profit";
    if (!reason && trailingTriggered && position.side === "long" && price <= trailingPrice) reason = "trailing_stop";
    if (!reason && trailingTriggered && position.side === "short" && price >= trailingPrice) reason = "trailing_stop";
    if (!reason && ageMinutes >= CONFIG.maxHoldMinutes) reason = "max_hold";
    if (!reason && position.side === "long" && signal.snapshot.bearishCross === true) reason = "ema_cross_exit";
    if (!reason && position.side === "short" && signal.snapshot.bullishCross === true) reason = "ema_cross_exit";

    if (reason) {
      await closePosition(state, position, price, reason);
      return;
    }

    await supabase
      .from("sol_ema_10x_state")
      .update({ open_position: position, last_signal: signal.snapshot, last_scan_at: nowIso, last_heartbeat_at: nowIso, last_error: null, updated_at: nowIso })
      .eq("id", 1);
    await supabase
      .from("sol_ema_10x_trades")
      .update({ high_water_price: position.highWaterPrice, low_water_price: position.lowWaterPrice, updated_at: nowIso })
      .eq("id", position.tradeId);
    return;
  }

  const mayEnter = !state.halted && finite(state.entries_today) < CONFIG.maxDailyEntries;
  if (mayEnter && signal.side) await openPosition(state, signal.side, price, signal.snapshot);
  else {
    await supabase
      .from("sol_ema_10x_state")
      .update({ last_signal: signal.snapshot, last_scan_at: nowIso, last_heartbeat_at: nowIso, last_error: null, updated_at: nowIso })
      .eq("id", 1);
  }
}

let started = false;
let running = false;

export function startSolEma10xPaperBot(): void {
  if (started) return;
  started = true;
  console.log(`[sol-ema-10x-paper] started symbol=${CONFIG.symbol} leverage=${CONFIG.leverage}x`);

  const run = async () => {
    if (running) return;
    running = true;
    try {
      await processOnce();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[sol-ema-10x-paper] cycle failed", message);
      const now = new Date().toISOString();
      await getSupabaseAdmin({ noStore: true })
        .from("sol_ema_10x_state")
        .update({ last_error: message.slice(0, 500), last_heartbeat_at: now, updated_at: now })
        .eq("id", 1)
        .then(() => undefined)
        .catch(() => undefined);
    } finally {
      running = false;
    }
  };

  void run();
  setInterval(() => void run(), CONFIG.intervalMs);
}
