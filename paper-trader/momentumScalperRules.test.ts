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
  marketCapUsd: 500_000,
  fiveMinuteChangePct: 5,
  fifteenMinuteChangePct: 9,
  fiveMinuteVolumeUsd: 12_000,
  fiveMinuteBuys: 30,
  fiveMinuteSells: 25,
  fiveMinuteBuyers: 20,
  poolAgeMinutes: 180,
};

test("accepts the focused scalper market profile", () => {
  const result = evaluateScalpCandidate(candidate);
  assert.equal(result.accepted, true);
  assert.deepEqual(result.reasons, []);
  assert.ok(result.score >= SCALP_RULES.minimumSignalScore);
});

test("rejects the observed overheated OH loss on both feeds", () => {
  const discovery = evaluateScalpCandidate({
    ...candidate,
    liquidityUsd: 35_690.7991,
    marketCapUsd: 198_389.2301,
    fiveMinuteChangePct: 7.684,
    fifteenMinuteChangePct: 9.924,
    fiveMinuteVolumeUsd: 3_936.9,
    fiveMinuteBuys: 39,
    fiveMinuteSells: 48,
    fiveMinuteBuyers: 35,
  });
  const confirmation = evaluateScalpConfirmation({
    priceUsd: 0.0001994,
    liquidityUsd: 35_964.36,
    marketCapUsd: 199_400,
    fiveMinuteChangePct: 6.89,
  });

  assert.equal(discovery.accepted, false);
  assert.ok(discovery.reasons.includes("five_minute_momentum_overheated"));
  assert.ok(confirmation.includes("dex_five_minute_momentum_overheated"));
});

test("rejects the observed low-quality SOLdiers loss", () => {
  const discovery = evaluateScalpCandidate({
    ...candidate,
    liquidityUsd: 114_762.463,
    marketCapUsd: 979_508.238,
    fiveMinuteChangePct: 4.869,
    fifteenMinuteChangePct: 2.979,
    fiveMinuteVolumeUsd: 5_363.29,
    fiveMinuteBuys: 22,
    fiveMinuteSells: 25,
    fiveMinuteBuyers: 17,
  });

  assert.equal(discovery.accepted, false);
  assert.ok(discovery.reasons.includes("market_cap_above_500k"));
  assert.ok(discovery.reasons.includes("fifteen_minute_confirmation_too_low"));
  assert.ok(discovery.reasons.includes("signal_score_below_45"));
});

test("keeps the observed HOMIE winner eligible", () => {
  const discovery = evaluateScalpCandidate({
    ...candidate,
    liquidityUsd: 41_966.0335,
    marketCapUsd: 218_292.743,
    fiveMinuteChangePct: 4.938,
    fifteenMinuteChangePct: 10.187,
    fiveMinuteVolumeUsd: 4_126.55,
    fiveMinuteBuys: 42,
    fiveMinuteSells: 65,
    fiveMinuteBuyers: 42,
  });
  const confirmation = evaluateScalpConfirmation({
    priceUsd: 0.0002168,
    liquidityUsd: 42_177.56,
    marketCapUsd: 216_800,
    fiveMinuteChangePct: 2.94,
  });

  assert.equal(discovery.accepted, true);
  assert.deepEqual(confirmation, []);
});

test("rejects today's low-volume negative-15m bounce", () => {
  const result = evaluateScalpCandidate({
    ...candidate,
    liquidityUsd: 26_464,
    marketCapUsd: 114_980,
    fiveMinuteChangePct: 6.107,
    fifteenMinuteChangePct: -10.492,
    fiveMinuteVolumeUsd: 1_621,
    fiveMinuteBuys: 47,
    fiveMinuteSells: 27,
    fiveMinuteBuyers: 45,
  });

  assert.equal(result.accepted, false);
  assert.ok(result.reasons.includes("five_minute_momentum_overheated"));
  assert.ok(result.reasons.includes("fifteen_minute_confirmation_too_low"));
  assert.ok(result.reasons.includes("five_minute_volume_too_low"));
});

test("keeps paper churn and repeat-token entries bounded", () => {
  assert.equal(SCALP_RULES.maxDailyEntries, 8);
  assert.equal(SCALP_RULES.cooldownMinutes, 30);
});

test("round-trip friction is charged before paper profit", () => {
  const net = calculateNetMultiple(1);
  assert.ok(net < 0.989);
  assert.ok(net > 0.987);
});

test("uses a 1.5-to-1 net target-to-stop profile", () => {
  assert.equal(
    SCALP_RULES.targetProfitPct / SCALP_RULES.hardStopLossPct,
    1.5
  );

  const now = Date.now();
  const tooSmall = decideScalpExit({
    entryPriceUsd: 1,
    currentPriceUsd: 1.04,
    peakPriceUsd: 1.04,
    openedAtMs: now - 60_000,
    nowMs: now,
  });
  assert.equal(tooSmall, null);

  const profitable = decideScalpExit({
    entryPriceUsd: 1,
    currentPriceUsd: 1.06,
    peakPriceUsd: 1.06,
    openedAtMs: now - 60_000,
    nowMs: now,
  });
  assert.equal(profitable?.reason, "target_profit_hit");
  assert.ok((profitable?.netReturnPct ?? 0) >= 4.5);
});

test("enforces the ten-minute maximum hold", () => {
  const now = Date.now();
  const result = decideScalpExit({
    entryPriceUsd: 1,
    currentPriceUsd: 1.01,
    peakPriceUsd: 1.01,
    openedAtMs: now - 11 * 60_000,
    nowMs: now,
  });
  assert.equal(result?.reason, "max_hold_time_exceeded");
});
