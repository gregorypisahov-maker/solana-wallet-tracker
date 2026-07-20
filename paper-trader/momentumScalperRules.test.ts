import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateNetMultiple,
  decideScalpExit,
  evaluateScalpCandidate,
  evaluateScalpConfirmation,
  SCALP_RULES,
  ScalpCandidate,
} from "./momentumScalperRules";

const candidate: ScalpCandidate = {
  mint: "Mint111111111111111111111111111111111111",
  symbol: "TEST",
  pairAddress: "Pair11111111111111111111111111111111111",
  priceUsd: 0.001,
  liquidityUsd: 80_000,
  marketCapUsd: 300_000,
  fiveMinuteChangePct: 5,
  fifteenMinuteChangePct: 9,
  fiveMinuteVolumeUsd: 12_000,
  fiveMinuteBuys: 30,
  fiveMinuteSells: 25,
  fiveMinuteBuyers: 20,
  poolAgeMinutes: 180,
};

test("accepts the balanced, liquidity-backed scalper profile", () => {
  const result = evaluateScalpCandidate(candidate);
  assert.equal(result.accepted, true);
  assert.deepEqual(result.reasons, []);
  assert.ok(result.score >= SCALP_RULES.minimumSignalScore);
});

test("ranks a shadow-quality market profile above an otherwise identical candidate", () => {
  const ordinary = evaluateScalpCandidate(candidate);
  const shadowAligned = evaluateScalpCandidate({
    ...candidate,
    liquidityUsd: 65_000,
    marketCapUsd: 180_000,
  });

  assert.equal(shadowAligned.accepted, true);
  assert.ok(shadowAligned.score > ordinary.score);
  assert.equal(
    shadowAligned.score - ordinary.score,
    SCALP_RULES.shadowMarketCapScoreBonus +
      SCALP_RULES.shadowLiquidityScoreBonus
  );
});

test("keeps valid wider-range candidates eligible instead of over-filtering", () => {
  const result = evaluateScalpCandidate(candidate);
  assert.equal(result.accepted, true);
});

test("rejects discovery candidates with thin liquidity backing", () => {
  const result = evaluateScalpCandidate({
    ...candidate,
    liquidityUsd: 45_000,
    marketCapUsd: 300_000,
  });

  assert.equal(result.accepted, false);
  assert.ok(result.reasons.includes("liquidity_to_market_cap_below_20pct"));
});

test("rejects Dex confirmation with thin liquidity backing", () => {
  const reasons = evaluateScalpConfirmation({
    priceUsd: 0.001,
    liquidityUsd: 45_000,
    marketCapUsd: 300_000,
    fiveMinuteChangePct: 4,
  });

  assert.ok(reasons.includes("dex_liquidity_to_market_cap_below_20pct"));
});

test("rejects overheated momentum on discovery and confirmation", () => {
  const discovery = evaluateScalpCandidate({
    ...candidate,
    fiveMinuteChangePct: 8.5,
  });
  const confirmation = evaluateScalpConfirmation({
    priceUsd: 0.001,
    liquidityUsd: 80_000,
    marketCapUsd: 300_000,
    fiveMinuteChangePct: 8.5,
  });

  assert.equal(discovery.accepted, false);
  assert.ok(discovery.reasons.includes("five_minute_momentum_overheated"));
  assert.ok(confirmation.includes("dex_five_minute_momentum_overheated"));
});

test("keeps the smaller paper size and blocks same-token churn for 24 hours", () => {
  assert.equal(SCALP_RULES.maxDailyEntries, 6);
  assert.equal(SCALP_RULES.cooldownMinutes, 24 * 60);
  assert.equal(SCALP_RULES.fixedSizeSol, 0.20);
});

test("round-trip friction is charged before paper profit", () => {
  const net = calculateNetMultiple(1);
  assert.ok(net < 0.989);
  assert.ok(net > 0.987);
});

test("hard-stops a losing scalp after simulated friction", () => {
  const now = Date.now();
  const result = decideScalpExit({
    entryPriceUsd: 1,
    currentPriceUsd: 0.98,
    peakPriceUsd: 1,
    openedAtMs: now - 60_000,
    nowMs: now,
  });

  assert.equal(result?.reason, "hard_stop");
});

test("lets a strong winner run until its trailing floor is breached", () => {
  const now = Date.now();
  const stillRunning = decideScalpExit({
    entryPriceUsd: 1,
    currentPriceUsd: 1.07,
    peakPriceUsd: 1.07,
    openedAtMs: now - 11 * 60_000,
    nowMs: now,
  });
  const trailed = decideScalpExit({
    entryPriceUsd: 1,
    currentPriceUsd: 1.055,
    peakPriceUsd: 1.08,
    openedAtMs: now - 12 * 60_000,
    nowMs: now,
  });

  assert.equal(stillRunning, null);
  assert.equal(trailed?.reason, "trailing_stop");
});

test("closes a non-runner at the maximum hold time", () => {
  const now = Date.now();
  const result = decideScalpExit({
    entryPriceUsd: 1,
    currentPriceUsd: 1.01,
    peakPriceUsd: 1.01,
    openedAtMs: now - 9 * 60_000,
    nowMs: now,
  });

  assert.equal(result?.reason, "max_hold_time");
});

test("caps exceptional spikes at twenty-five percent net", () => {
  const now = Date.now();
  const result = decideScalpExit({
    entryPriceUsd: 1,
    currentPriceUsd: 1.27,
    peakPriceUsd: 1.27,
    openedAtMs: now - 60_000,
    nowMs: now,
  });

  assert.equal(result?.reason, "take_profit");
  assert.ok((result?.netReturnPct ?? 0) >= SCALP_RULES.targetProfitPct);
});
