import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateNetMultiple,
  configuredNetRewardRiskRatio,
  decideScalpExit,
  evaluateScalpCandidate,
  evaluateScalpConfirmation,
  SCALP_RULES,
} from "./momentumScalperRules.ts";
import type { ScalpCandidate } from "./momentumScalperRules.ts";

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

const confirmationFor = (source: ScalpCandidate, change = source.fiveMinuteChangePct) => ({
  mint: source.mint,
  pairAddress: source.pairAddress,
  priceUsd: source.priceUsd,
  liquidityUsd: source.liquidityUsd,
  marketCapUsd: source.marketCapUsd,
  fiveMinuteChangePct: change,
});

test("accepts liquid, confirmed momentum without wallet signals", () => {
  const result = evaluateScalpCandidate(candidate);
  assert.equal(result.accepted, true);
  assert.equal(result.reasons.length, 0);
  assert.ok(result.checks.every((check) => check.passed));
});

test("rejects the observed overheated OH loss on both feeds", () => {
  const oh = {
    ...candidate,
    liquidityUsd: 35_690.7991,
    marketCapUsd: 198_389.2301,
    fiveMinuteChangePct: 7.684,
    fifteenMinuteChangePct: 9.924,
    fiveMinuteVolumeUsd: 3_936.9,
    fiveMinuteBuys: 39,
    fiveMinuteSells: 48,
    fiveMinuteBuyers: 35,
  };
  const discovery = evaluateScalpCandidate(oh);
  const confirmation = evaluateScalpConfirmation(oh, confirmationFor(oh, 6.89));

  assert.equal(discovery.accepted, false);
  assert.ok(discovery.reasons.includes("five_minute_momentum_overheated"));
  assert.ok(confirmation.reasons.includes("dex_five_minute_momentum_overheated"));
});

test("rejects the observed low-quality SOLdiers loss", () => {
  const soldiers = {
    ...candidate,
    liquidityUsd: 114_762.463,
    marketCapUsd: 979_508.238,
    fiveMinuteChangePct: 4.869,
    fifteenMinuteChangePct: 2.979,
    fiveMinuteVolumeUsd: 5_363.29,
    fiveMinuteBuys: 22,
    fiveMinuteSells: 25,
    fiveMinuteBuyers: 17,
  };
  const discovery = evaluateScalpCandidate(soldiers);
  const confirmation = evaluateScalpConfirmation(soldiers, confirmationFor(soldiers, 6.04));

  assert.equal(discovery.accepted, false);
  assert.ok(discovery.reasons.includes("fifteen_minute_confirmation_too_low"));
  assert.ok(discovery.reasons.includes("signal_score_below_45"));
  assert.ok(confirmation.reasons.includes("dex_five_minute_momentum_overheated"));
});

test("keeps the observed HOMIE winner eligible before pullback checks", () => {
  const homie = {
    ...candidate,
    liquidityUsd: 41_966.0335,
    marketCapUsd: 218_292.743,
    fiveMinuteChangePct: 4.938,
    fifteenMinuteChangePct: 10.187,
    fiveMinuteVolumeUsd: 4_126.55,
    fiveMinuteBuys: 42,
    fiveMinuteSells: 65,
    fiveMinuteBuyers: 42,
  };
  const discovery = evaluateScalpCandidate(homie);
  const confirmation = evaluateScalpConfirmation(homie, confirmationFor(homie, 2.94));

  assert.equal(discovery.accepted, true);
  assert.equal(confirmation.accepted, true);
});

test("fails closed when any required discovery or confirmation field is missing", () => {
  const missingDiscovery = evaluateScalpCandidate({
    ...candidate,
    fifteenMinuteChangePct: undefined as unknown as number,
  });
  assert.equal(missingDiscovery.accepted, false);
  assert.ok(missingDiscovery.reasons.includes("candidate_field_missing_or_invalid:fifteenMinuteChangePct"));

  const missingConfirmation = evaluateScalpConfirmation(candidate, {
    ...confirmationFor(candidate),
    liquidityUsd: Number.NaN,
  });
  assert.equal(missingConfirmation.accepted, false);
  assert.ok(missingConfirmation.reasons.includes("dex_liquidity_missing_or_invalid"));
});

test("rejects a confirmation snapshot for a different mint", () => {
  const result = evaluateScalpConfirmation(candidate, {
    ...confirmationFor(candidate),
    mint: "DifferentMint111111111111111111111111111111",
  });
  assert.equal(result.accepted, false);
  assert.ok(result.reasons.includes("dex_mint_mismatch"));
});

test("configured net reward to risk is at least 1.5 to 1", () => {
  assert.ok(configuredNetRewardRiskRatio() >= 1.5);
  assert.equal(SCALP_RULES.takeProfitNetPct, 4);
  assert.equal(SCALP_RULES.hardStopNetPct, -2.5);
});

test("round-trip friction is charged before paper profit", () => {
  const net = calculateNetMultiple(1);
  assert.ok(net < 0.989);
  assert.ok(net > 0.987);
});

test("takes profit only after simulated costs", () => {
  const now = Date.now();
  assert.equal(decideScalpExit({
    entryPriceUsd: 1,
    currentPriceUsd: 1.04,
    peakPriceUsd: 1.04,
    openedAtMs: now - 60_000,
    nowMs: now,
  }), null);

  const profitable = decideScalpExit({
    entryPriceUsd: 1,
    currentPriceUsd: 1.053,
    peakPriceUsd: 1.053,
    openedAtMs: now - 60_000,
    nowMs: now,
  });
  assert.equal(profitable?.reason, "take_profit");
  assert.ok((profitable?.netReturnPct ?? 0) >= 4);
});

test("caps daily churn at eight entries", () => {
  assert.equal(SCALP_RULES.maxDailyEntries, 8);
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
