import assert from "node:assert/strict";
import test from "node:test";
import {
  assertScalpEntryDecision,
  buildScalpEntryDecision,
} from "./scalpEntryDecision.ts";
import type { MinuteCandle } from "./momentumPullback.ts";
import type { ScalpCandidate } from "./momentumScalperRules.ts";

const nowMs = 1_800_000_000_000;
const nowSeconds = nowMs / 1_000;
const candles: MinuteCandle[] = [
  { timestampSeconds: nowSeconds - 180, open: 100, high: 102, low: 99.8, close: 101.5, volumeUsd: 10_000 },
  { timestampSeconds: nowSeconds - 120, open: 101.5, high: 104, low: 101, close: 103, volumeUsd: 12_000 },
  { timestampSeconds: nowSeconds - 60, open: 103, high: 105, low: 102.5, close: 104, volumeUsd: 14_000 },
  { timestampSeconds: nowSeconds - 10, open: 104, high: 104.5, low: 102.8, close: 103.8, volumeUsd: 8_000 },
];
const candidate: ScalpCandidate = {
  mint: "SelectedMint1111111111111111111111111111111",
  symbol: "SELECTED",
  pairAddress: "SelectedPair1111111111111111111111111111111",
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

const market = {
  mint: candidate.mint,
  pairAddress: candidate.pairAddress,
  priceUsd: candidate.priceUsd,
  liquidityUsd: candidate.liquidityUsd,
  marketCapUsd: candidate.marketCapUsd,
  fiveMinuteChangePct: candidate.fiveMinuteChangePct,
};

test("accepts only when every filter snapshot belongs to the selected mint", () => {
  const decision = buildScalpEntryDecision({
    candidate,
    market,
    minuteCandles: candles,
    pullbackPairAddress: candidate.pairAddress,
    nowMs,
  });
  assert.equal(decision.accepted, true);
  assert.equal(decision.selectedMint, decision.candidate.mint);
  assert.equal(decision.selectedMint, decision.market.mint);
  assert.doesNotThrow(() => assertScalpEntryDecision(decision));
});

test("blocks entry if confirmation data belongs to a different candidate", () => {
  const decision = buildScalpEntryDecision({
    candidate,
    market: { ...market, mint: "TopButNotSelected111111111111111111111111111" },
    minuteCandles: candles,
    pullbackPairAddress: candidate.pairAddress,
    nowMs,
  });
  assert.equal(decision.accepted, false);
  assert.ok(decision.reasons.includes("dex_mint_mismatch"));
  assert.throws(() => assertScalpEntryDecision(decision));
});

test("blocks the exact SOLdiers snapshot even if another top token is logged", () => {
  const soldiers = {
    ...candidate,
    mint: "B4ptaVsUe6YbtBwAS38WFeweSrVNfQLCcj9JRrtjU8vn",
    symbol: "SOLdiers",
    liquidityUsd: 114_762.463,
    marketCapUsd: 979_508.238,
    fiveMinuteChangePct: 4.869,
    fifteenMinuteChangePct: 2.979,
    fiveMinuteVolumeUsd: 5_363.29,
    fiveMinuteBuys: 22,
    fiveMinuteSells: 25,
    fiveMinuteBuyers: 17,
  };
  const decision = buildScalpEntryDecision({
    candidate: soldiers,
    market: { ...market, mint: soldiers.mint, fiveMinuteChangePct: 6.04 },
    minuteCandles: candles,
    pullbackPairAddress: soldiers.pairAddress,
    nowMs,
  });
  assert.equal(decision.accepted, false);
  assert.ok(decision.reasons.includes("fifteen_minute_confirmation_too_low"));
  assert.ok(decision.reasons.includes("signal_score_below_45"));
});

test("blocks pullback candles fetched for a different pool", () => {
  const decision = buildScalpEntryDecision({
    candidate,
    market,
    minuteCandles: candles,
    pullbackPairAddress: "DifferentPool111111111111111111111111111111",
    nowMs,
  });
  assert.equal(decision.accepted, false);
  assert.ok(decision.reasons.includes("pullback_pair_mismatch"));
  assert.throws(() => assertScalpEntryDecision(decision));
});
