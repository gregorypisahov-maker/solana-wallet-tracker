import assert from "node:assert/strict";
import test from "node:test";
import { atrSeries, calculatePaperUnits, emaSeries, evaluateGoldSignal } from "./strategy";
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
