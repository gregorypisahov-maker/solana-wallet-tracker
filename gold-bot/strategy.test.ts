import assert from "node:assert/strict";
import test from "node:test";
import {
  atrSeries,
  calculatePaperUnits,
  emaSeries,
  evaluateGoldSignal,
  type GoldStrategyConfig,
} from "./strategy";
import type { GoldCandle } from "./types";

test("EMA follows a constant series", () => {
  assert.deepEqual(emaSeries([10, 10, 10, 10], 3), [10, 10, 10, 10]);
});

test("ATR captures candle range", () => {
  const candles: GoldCandle[] = [
    { time: "1", open: 100, high: 102, low: 99, close: 101, complete: true },
    { time: "2", open: 101, high: 104, low: 100, close: 103, complete: true },
  ];
  const atr = atrSeries(candles, 14);
  assert.equal(atr.length, 2);
  assert.equal(atr[0], 3);
  assert.equal(atr[1], 3.5);
});

test("position sizing caps risk and rounds down", () => {
  const units = calculatePaperUnits({
    balanceUsd: 10_000,
    riskFraction: 0.0025,
    stopDistance: 8,
    unitPrecision: 2,
    minimumUnits: 0.01,
    maximumUnits: 5,
  });
  assert.equal(units, 3.12);
  assert.ok(units * 8 <= 25);
});

test("strategy refuses insufficient history", () => {
  const candles: GoldCandle[] = Array.from({ length: 20 }, (_, index) => ({
    time: String(index),
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100.5 + index,
    complete: true,
  }));
  assert.equal(evaluateGoldSignal(candles), null);
});

const compactConfig: GoldStrategyConfig = {
  fastEmaPeriod: 3,
  slowEmaPeriod: 6,
  atrPeriod: 3,
  atrStopMultiple: 1.5,
  minimumTrendAtr: 0.1,
  pullbackToleranceAtr: 0.15,
};

test("strategy accepts a bullish pullback that narrowly misses the exact EMA", () => {
  const candles: GoldCandle[] = Array.from({ length: 15 }, (_, index) => {
    const close = 100 + index * 0.5;
    return {
      time: String(index),
      open: close - 0.15,
      high: close + 0.25,
      low: close - 0.25,
      close,
      complete: true,
    };
  });

  candles.push({
    time: "15",
    open: 106.95,
    high: 107.05,
    low: 106.72,
    close: 106.8,
    complete: true,
  });
  candles.push({
    time: "16",
    open: 106.85,
    high: 107.3,
    low: 106.88,
    close: 107.2,
    complete: true,
  });

  const signal = evaluateGoldSignal(candles, compactConfig);
  assert.equal(signal?.side, "long");
  assert.match(signal?.reason ?? "", /ATR-tolerant/);
});

test("strategy still rejects a bullish candle with no EMA pullback", () => {
  const candles: GoldCandle[] = Array.from({ length: 17 }, (_, index) => {
    const close = 100 + index * 0.5;
    return {
      time: String(index),
      open: close - 0.1,
      high: close + 0.2,
      low: close + 0.1,
      close,
      complete: true,
    };
  });

  assert.equal(evaluateGoldSignal(candles, compactConfig), null);
});
