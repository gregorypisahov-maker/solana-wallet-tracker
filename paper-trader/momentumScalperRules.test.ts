import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateNetMultiple,
  decideScalpExit,
  evaluateScalpCandidate,
  ScalpCandidate,
} from "./momentumScalperRules";

const candidate: ScalpCandidate = {
  mint: "Mint111111111111111111111111111111111111",
  symbol: "TEST",
  pairAddress: "Pair11111111111111111111111111111111111",
  priceUsd: 0.001,
  liquidityUsd: 80_000,
  marketCapUsd: 500_000,
  fiveMinuteChangePct: 5,
  fifteenMinuteChangePct: 9,
  fiveMinuteVolumeUsd: 12_000,
  fiveMinuteBuys: 30,
  fiveMinuteSells: 25,
  fiveMinuteBuyers: 20,
  poolAgeMinutes: 180,
};

test("accepts liquid, confirmed momentum without wallet signals", () => {
  const result = evaluateScalpCandidate(candidate);
  assert.equal(result.accepted, true);
  assert.equal(result.reasons.length, 0);
  assert.ok(result.score > 0);
});

test("rejects an overheated move and weak liquidity", () => {
  const result = evaluateScalpCandidate({
    ...candidate,
    liquidityUsd: 10_000,
    fiveMinuteChangePct: 25,
  });
  assert.equal(result.accepted, false);
  assert.ok(result.reasons.includes("liquidity_below_35k"));
  assert.ok(result.reasons.includes("five_minute_momentum_overheated"));
});

test("round-trip friction is charged before paper profit", () => {
  const net = calculateNetMultiple(1);
  assert.ok(net < 0.989);
  assert.ok(net > 0.987);
});

test("takes profit only after simulated costs", () => {
  const now = Date.now();
  const tooSmall = decideScalpExit({
    entryPriceUsd: 1,
    currentPriceUsd: 1.03,
    peakPriceUsd: 1.03,
    openedAtMs: now - 60_000,
    nowMs: now,
  });
  assert.equal(tooSmall, null);

  const profitable = decideScalpExit({
    entryPriceUsd: 1,
    currentPriceUsd: 1.04,
    peakPriceUsd: 1.04,
    openedAtMs: now - 60_000,
    nowMs: now,
  });
  assert.equal(profitable?.reason, "take_profit");
  assert.ok((profitable?.netReturnPct ?? 0) >= 2.5);
});

test("enforces the seven-minute maximum hold", () => {
  const now = Date.now();
  const result = decideScalpExit({
    entryPriceUsd: 1,
    currentPriceUsd: 1.01,
    peakPriceUsd: 1.01,
    openedAtMs: now - 8 * 60_000,
    nowMs: now,
  });
  assert.equal(result?.reason, "max_hold_time");
});
