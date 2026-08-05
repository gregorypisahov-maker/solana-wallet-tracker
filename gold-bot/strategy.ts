import type { GoldCandle, GoldSignal } from "./types";

export const GOLD_STRATEGY_VERSION = "xauusd_m15_pullback_v1_2026_08_05";

export type GoldStrategyConfig = {
  fastEmaPeriod: number;
  slowEmaPeriod: number;
  atrPeriod: number;
  atrStopMultiple: number;
  minimumTrendAtr: number;
};

export const DEFAULT_GOLD_STRATEGY: GoldStrategyConfig = {
  fastEmaPeriod: 20,
  slowEmaPeriod: 50,
  atrPeriod: 14,
  atrStopMultiple: 1.5,
  minimumTrendAtr: 0.15,
};

export function emaSeries(values: number[], period: number): number[] {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error("EMA period must be a positive integer");
  }
  if (values.length === 0) return [];

  const multiplier = 2 / (period + 1);
  const output = new Array<number>(values.length);
  output[0] = values[0];
  for (let i = 1; i < values.length; i += 1) {
    output[i] = values[i] * multiplier + output[i - 1] * (1 - multiplier);
  }
  return output;
}

export function atrSeries(candles: GoldCandle[], period: number): number[] {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error("ATR period must be a positive integer");
  }
  if (candles.length === 0) return [];

  const trueRanges = candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const previousClose = candles[index - 1].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });

  const output = new Array<number>(candles.length);
  output[0] = trueRanges[0];
  for (let i = 1; i < candles.length; i += 1) {
    output[i] = i < period
      ? (output[i - 1] * i + trueRanges[i]) / (i + 1)
      : (output[i - 1] * (period - 1) + trueRanges[i]) / period;
  }
  return output;
}

export function calculatePaperUnits(args: {
  balanceUsd: number;
  riskFraction: number;
  stopDistance: number;
  unitPrecision: number;
  minimumUnits: number;
  maximumUnits: number;
}): number {
  const {
    balanceUsd,
    riskFraction,
    stopDistance,
    unitPrecision,
    minimumUnits,
    maximumUnits,
  } = args;

  if (
    !Number.isFinite(balanceUsd) || balanceUsd <= 0 ||
    !Number.isFinite(riskFraction) || riskFraction <= 0 || riskFraction > 0.02 ||
    !Number.isFinite(stopDistance) || stopDistance <= 0
  ) {
    return 0;
  }

  const rawUnits = (balanceUsd * riskFraction) / stopDistance;
  const precisionFactor = 10 ** Math.max(0, unitPrecision);
  const roundedDown = Math.floor(rawUnits * precisionFactor) / precisionFactor;
  const clamped = Math.min(roundedDown, maximumUnits);
  return clamped >= minimumUnits ? clamped : 0;
}

export function evaluateGoldSignal(
  inputCandles: GoldCandle[],
  config: GoldStrategyConfig = DEFAULT_GOLD_STRATEGY,
): GoldSignal | null {
  const candles = inputCandles.filter((candle) => candle.complete);
  const minimumCandles = Math.max(config.slowEmaPeriod + 10, config.atrPeriod + 10);
  if (candles.length < minimumCandles) return null;

  const closes = candles.map((candle) => candle.close);
  const fast = emaSeries(closes, config.fastEmaPeriod);
  const slow = emaSeries(closes, config.slowEmaPeriod);
  const atr = atrSeries(candles, config.atrPeriod);

  const latestIndex = candles.length - 1;
  const previousIndex = latestIndex - 1;
  const latest = candles[latestIndex];
  const previous = candles[previousIndex];
  const latestAtr = atr[latestIndex];

  if (!Number.isFinite(latestAtr) || latestAtr <= 0) return null;

  const fastNow = fast[latestIndex];
  const slowNow = slow[latestIndex];
  const fastPrevious = fast[previousIndex];
  const trendDistanceAtr = Math.abs(fastNow - slowNow) / latestAtr;
  if (trendDistanceAtr < config.minimumTrendAtr) return null;

  const bullishTrend = fastNow > slowNow && fastNow > fastPrevious;
  const bearishTrend = fastNow < slowNow && fastNow < fastPrevious;

  const bullishPullbackReclaim =
    previous.low <= fastPrevious &&
    latest.close > fastNow &&
    latest.close > latest.open;

  const bearishPullbackReject =
    previous.high >= fastPrevious &&
    latest.close < fastNow &&
    latest.close < latest.open;

  if (bullishTrend && bullishPullbackReclaim) {
    return {
      side: "long",
      candleTime: latest.time,
      referencePrice: latest.close,
      atr: latestAtr,
      stopDistance: latestAtr * config.atrStopMultiple,
      reason: "M15 EMA20/EMA50 uptrend with EMA20 pullback reclaim",
    };
  }

  if (bearishTrend && bearishPullbackReject) {
    return {
      side: "short",
      candleTime: latest.time,
      referencePrice: latest.close,
      atr: latestAtr,
      stopDistance: latestAtr * config.atrStopMultiple,
      reason: "M15 EMA20/EMA50 downtrend with EMA20 pullback rejection",
    };
  }

  return null;
}
