import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateMomentumPullback,
  parseGeckoMinuteCandles,
} from "./momentumPullback.ts";
import type { MinuteCandle } from "./momentumPullback.ts";

const nowMs = 1_800_000_000_000;
const nowSeconds = nowMs / 1_000;

const validCandles: MinuteCandle[] = [
  { timestampSeconds: nowSeconds - 180, open: 100, high: 102, low: 99.8, close: 101.5, volumeUsd: 10_000 },
  { timestampSeconds: nowSeconds - 120, open: 101.5, high: 104, low: 101, close: 103, volumeUsd: 12_000 },
  { timestampSeconds: nowSeconds - 60, open: 103, high: 105, low: 102.5, close: 104, volumeUsd: 14_000 },
  { timestampSeconds: nowSeconds - 10, open: 104, high: 104.5, low: 102.8, close: 103.8, volumeUsd: 8_000 },
];

test("accepts a pullback that recovered and holds above the short-term level", () => {
  const result = evaluateMomentumPullback(validCandles, nowMs);
  assert.equal(result.accepted, true);
  assert.deepEqual(result.reasons, []);
  assert.ok((result.snapshot.pullbackFromHighPct ?? 0) >= 0.35);
});

test("rejects entry while the current one-minute candle is still spiking", () => {
  const result = evaluateMomentumPullback([
    ...validCandles.slice(0, -1),
    { timestampSeconds: nowSeconds - 10, open: 104, high: 106, low: 103.8, close: 105.7, volumeUsd: 20_000 },
  ], nowMs);
  assert.equal(result.accepted, false);
  assert.ok(result.reasons.includes("current_one_minute_candle_still_spiking"));
});

test("rejects a pullback that loses the short-term level", () => {
  const result = evaluateMomentumPullback([
    ...validCandles.slice(0, -1),
    { timestampSeconds: nowSeconds - 10, open: 103, high: 103.2, low: 100, close: 101, volumeUsd: 20_000 },
  ], nowMs);
  assert.equal(result.accepted, false);
  assert.ok(result.reasons.includes("price_not_holding_short_term_level"));
});

test("fails closed on missing or malformed candle fields", () => {
  const parsed = parseGeckoMinuteCandles({
    data: { attributes: { ohlcv_list: [[nowSeconds, 1, 2, 0.5, null, 10]] } },
  });
  assert.deepEqual(parsed, []);
  const result = evaluateMomentumPullback(parsed, nowMs);
  assert.equal(result.accepted, false);
  assert.ok(result.reasons.includes("pullback_candles_missing"));
});
