import { OandaMarketDataClient } from "./oandaClient";
import { GoldPaperStore } from "./store";
import {
  calculatePaperUnits,
  evaluateGoldSignal,
  GOLD_STRATEGY_VERSION,
} from "./strategy";
import type { GoldInstrument, GoldPaperPosition, GoldQuote } from "./types";

const BOT_ID = "xauusd-paper-v1";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function numberEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`);
  }
  return value;
}

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const value = numberEnv(name, fallback, min, max);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

const config = {
  token: requiredEnv("OANDA_API_TOKEN"),
  accountId: requiredEnv("OANDA_ACCOUNT_ID"),
  environment: (process.env.OANDA_ENVIRONMENT?.trim() === "live" ? "live" : "practice") as
    | "practice"
    | "live",
  instrument: process.env.OANDA_INSTRUMENT?.trim() || "XAU_USD",
  granularity: process.env.GOLD_GRANULARITY?.trim() || "M15",
  pollMs: integerEnv("GOLD_POLL_MS", 15_000, 5_000, 300_000),
  startingBalanceUsd: numberEnv("GOLD_STARTING_BALANCE_USD", 10_000, 100, 10_000_000),
  riskFraction: numberEnv("GOLD_RISK_PER_TRADE", 0.0025, 0.0001, 0.005),
  maxDailyLossFraction: numberEnv("GOLD_MAX_DAILY_LOSS", 0.01, 0.001, 0.03),
  rewardRisk: numberEnv("GOLD_REWARD_RISK", 2, 1, 5),
  maxUnits: numberEnv("GOLD_MAX_UNITS", 5, 0.01, 10_000),
  maxSpreadAtrFraction: numberEnv("GOLD_MAX_SPREAD_ATR", 0.12, 0.01, 0.5),
  tradingStartUtc: integerEnv("GOLD_TRADING_START_UTC", 6, 0, 23),
  tradingEndUtc: integerEnv("GOLD_TRADING_END_UTC", 20, 1, 24),
  quoteMaxAgeSeconds: integerEnv("GOLD_QUOTE_MAX_AGE_SECONDS", 60, 5, 600),
};

if (process.env.GOLD_LIVE_ENABLED?.toLowerCase() === "true") {
  throw new Error(
    "This service is intentionally paper-only. GOLD_LIVE_ENABLED=true is rejected; " +
    "build and review a separate broker execution service after paper validation.",
  );
}

if (config.granularity !== "M15") {
  throw new Error("Version 1 is strategy-locked to GOLD_GRANULARITY=M15");
}

const client = new OandaMarketDataClient({
  token: config.token,
  accountId: config.accountId,
  instrument: config.instrument,
  environment: config.environment,
});
const store = new GoldPaperStore(BOT_ID);

let instrumentDetails: GoldInstrument;
let tickRunning = false;
let shuttingDown = false;

function asNumber(value: number | string | null): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric database value: ${value}`);
  return parsed;
}

function roundPrice(value: number): number {
  const factor = 10 ** instrumentDetails.displayPrecision;
  return Math.round(value * factor) / factor;
}

function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function insideTradingWindow(date: Date): boolean {
  const hour = date.getUTCHours();
  if (config.tradingStartUtc < config.tradingEndUtc) {
    return hour >= config.tradingStartUtc && hour < config.tradingEndUtc;
  }
  return hour >= config.tradingStartUtc || hour < config.tradingEndUtc;
}

function quoteIsFresh(quote: GoldQuote): boolean {
  const quoteTime = new Date(quote.time).getTime();
  if (!Number.isFinite(quoteTime)) return false;
  return Date.now() - quoteTime <= config.quoteMaxAgeSeconds * 1_000;
}

async function telegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return;

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.error(`[gold-paper] Telegram ${response.status}: ${await response.text()}`);
    }
  } catch (error) {
    console.error("[gold-paper] Telegram delivery failed", error);
  }
}

function calculatePnl(position: GoldPaperPosition, exitPrice: number): number {
  const entry = asNumber(position.entry_price);
  const units = asNumber(position.units);
  return position.side === "long"
    ? (exitPrice - entry) * units
    : (entry - exitPrice) * units;
}

async function manageOpenPosition(
  position: GoldPaperPosition,
  quote: GoldQuote,
): Promise<boolean> {
  const stop = asNumber(position.stop_loss);
  const takeProfit = asNumber(position.take_profit);
  const executableExit = position.side === "long" ? quote.bid : quote.ask;

  let reason: string | null = null;
  if (position.side === "long") {
    if (executableExit <= stop) reason = "stop_loss";
    else if (executableExit >= takeProfit) reason = "take_profit";
  } else {
    if (executableExit >= stop) reason = "stop_loss";
    else if (executableExit <= takeProfit) reason = "take_profit";
  }

  if (!reason) return false;

  const exitPrice = roundPrice(executableExit);
  const pnl = Number(calculatePnl(position, exitPrice).toFixed(2));
  const closed = await store.closePosition({
    positionId: position.id,
    exitPrice,
    realizedPnlUsd: pnl,
    reason,
  });
  if (!closed) return false;

  console.log(
    `[gold-paper] CLOSE ${position.side.toUpperCase()} ${position.units} ${config.instrument} ` +
    `at ${exitPrice} pnl=${pnl.toFixed(2)} reason=${reason}`,
  );
  await telegram(
    `🥇 GOLD PAPER CLOSE\n` +
    `${position.side.toUpperCase()} ${position.units} ${config.instrument}\n` +
    `Exit: ${exitPrice}\nPnL: $${pnl.toFixed(2)}\nReason: ${reason}`,
  );
  return true;
}

async function applyDailyRiskReset(): Promise<void> {
  const state = await store.getState();
  const today = utcDate();
  if (state.daily_date !== today) {
    await store.resetDaily(asNumber(state.balance_usd), today);
    await store.logEvent("daily_risk_reset", {
      date: today,
      balanceUsd: asNumber(state.balance_usd),
    });
  }
}

async function enforceDailyLossLock(): Promise<boolean> {
  const state = await store.getState();
  const balance = asNumber(state.balance_usd);
  const dailyStart = asNumber(state.daily_start_balance_usd);
  const floor = dailyStart * (1 - config.maxDailyLossFraction);
  if (balance > floor) return state.paused;

  if (!state.paused || state.pause_reason !== "daily_loss_limit") {
    await store.setPaused(true, "daily_loss_limit");
    await store.logEvent("daily_loss_lock", {
      balanceUsd: balance,
      dailyStartBalanceUsd: dailyStart,
      maxDailyLossFraction: config.maxDailyLossFraction,
    });
    await telegram(
      `🛑 GOLD PAPER PAUSED\nDaily loss limit reached.\n` +
      `Balance: $${balance.toFixed(2)}\nDaily start: $${dailyStart.toFixed(2)}`,
    );
  }
  return true;
}

async function tick(): Promise<void> {
  if (tickRunning || shuttingDown) return;
  tickRunning = true;

  try {
    await applyDailyRiskReset();

    const quote = await client.getQuote();
    if (quote.status.toLowerCase() !== "tradeable" || !quoteIsFresh(quote)) {
      console.log(`[gold-paper] quote unavailable status=${quote.status} time=${quote.time}`);
      return;
    }

    const openPosition = await store.getOpenPosition();
    if (openPosition) {
      const closed = await manageOpenPosition(openPosition, quote);
      if (!closed) return;
      // Never close and immediately reopen in the same polling cycle.
      return;
    }

    if (await enforceDailyLossLock()) return;
    if (!insideTradingWindow(new Date())) return;

    const candles = await client.getCandles(config.granularity, 300);
    const completed = candles.filter((candle) => candle.complete);
    const latest = completed[completed.length - 1];
    if (!latest) return;

    const state = await store.getState();
    if (state.last_processed_candle_time === latest.time) return;
    await store.markCandleProcessed(latest.time);

    const signal = evaluateGoldSignal(completed);
    if (!signal) return;

    const spread = quote.ask - quote.bid;
    if (spread / signal.atr > config.maxSpreadAtrFraction) {
      await store.logEvent("entry_rejected", {
        reason: "spread_too_wide",
        spread,
        atr: signal.atr,
        spreadAtrFraction: spread / signal.atr,
        candleTime: signal.candleTime,
      });
      return;
    }

    const balance = asNumber((await store.getState()).balance_usd);
    const brokerMax = instrumentDetails.maximumOrderUnits ?? config.maxUnits;
    const units = calculatePaperUnits({
      balanceUsd: balance,
      riskFraction: config.riskFraction,
      stopDistance: signal.stopDistance,
      unitPrecision: instrumentDetails.tradeUnitsPrecision,
      minimumUnits: instrumentDetails.minimumTradeSize,
      maximumUnits: Math.min(config.maxUnits, brokerMax),
    });
    if (units <= 0) {
      await store.logEvent("entry_rejected", {
        reason: "position_size_below_minimum",
        balanceUsd: balance,
        stopDistance: signal.stopDistance,
        minimumTradeSize: instrumentDetails.minimumTradeSize,
        maximumUnits: Math.min(config.maxUnits, brokerMax),
      });
      return;
    }

    const entryPrice = roundPrice(signal.side === "long" ? quote.ask : quote.bid);
    const stopLoss = roundPrice(
      signal.side === "long"
        ? entryPrice - signal.stopDistance
        : entryPrice + signal.stopDistance,
    );
    const takeProfit = roundPrice(
      signal.side === "long"
        ? entryPrice + signal.stopDistance * config.rewardRisk
        : entryPrice - signal.stopDistance * config.rewardRisk,
    );

    const position = await store.openPosition({
      instrument: config.instrument,
      side: signal.side,
      units,
      entryPrice,
      stopLoss,
      takeProfit,
      entrySpread: spread,
      strategyVersion: GOLD_STRATEGY_VERSION,
      signal,
    });

    console.log(
      `[gold-paper] OPEN ${signal.side.toUpperCase()} ${units} ${config.instrument} ` +
      `entry=${entryPrice} stop=${stopLoss} tp=${takeProfit}`,
    );
    await telegram(
      `🥇 GOLD PAPER OPEN\n` +
      `${signal.side.toUpperCase()} ${units} ${config.instrument}\n` +
      `Entry: ${entryPrice}\nStop: ${stopLoss}\nTarget: ${takeProfit}\n` +
      `Risk: ${(config.riskFraction * 100).toFixed(2)}%\n` +
      `Position ID: ${position.id}`,
    );
  } catch (error) {
    console.error("[gold-paper] tick failed", error);
    try {
      await store.logEvent("runtime_error", {
        message: error instanceof Error ? error.message : String(error),
      });
    } catch (storeError) {
      console.error("[gold-paper] could not persist runtime error", storeError);
    }
  } finally {
    tickRunning = false;
  }
}

async function start(): Promise<void> {
  instrumentDetails = await client.getInstrument();
  const state = await store.ensureState(config.startingBalanceUsd);

  console.log(
    `[gold-paper] started ${instrumentDetails.displayName} (${instrumentDetails.name}) ` +
    `environment=${config.environment} balance=$${asNumber(state.balance_usd).toFixed(2)} ` +
    `strategy=${GOLD_STRATEGY_VERSION}`,
  );
  await store.logEvent("service_started", {
    environment: config.environment,
    instrument: instrumentDetails,
    strategyVersion: GOLD_STRATEGY_VERSION,
    paperOnly: true,
    config: {
      granularity: config.granularity,
      riskFraction: config.riskFraction,
      maxDailyLossFraction: config.maxDailyLossFraction,
      rewardRisk: config.rewardRisk,
      maxUnits: config.maxUnits,
      tradingStartUtc: config.tradingStartUtc,
      tradingEndUtc: config.tradingEndUtc,
    },
  });
  await telegram(
    `✅ GOLD PAPER BOT STARTED\n${instrumentDetails.displayName}\n` +
    `Balance: $${asNumber(state.balance_usd).toFixed(2)}\n` +
    `Strategy: ${GOLD_STRATEGY_VERSION}\nLive execution: DISABLED`,
  );

  await tick();
  const timer = setInterval(() => void tick(), config.pollMs);

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(timer);
    console.log(`[gold-paper] shutting down after ${signal}`);
    setTimeout(() => process.exit(0), tickRunning ? 2_000 : 0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch((error) => {
  console.error("[gold-paper] fatal startup error", error);
  process.exit(1);
});
