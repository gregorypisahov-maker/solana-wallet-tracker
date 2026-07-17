import assert from "node:assert/strict";
import test from "node:test";
import { buildScalpEntryDecision } from "./scalpEntryDecision.ts";
import { buildScalpScanAudit } from "./scalpScanAudit.ts";
import { evaluateScalpCandidate } from "./momentumScalperRules.ts";
import type { MinuteCandle } from "./momentumPullback.ts";
import type { ScalpCandidate } from "./momentumScalperRules.ts";

const nowMs = 1_800_000_000_000;
const nowSeconds = nowMs / 1_000;
const selected: ScalpCandidate = {
  mint: "JimothyMint111111111111111111111111111111",
  symbol: "Jimothy",
  pairAddress: "JimothyPair111111111111111111111111111111",
  priceUsd: 0.001,
  liquidityUsd: 80_000,
  marketCapUsd: 500_000,
  fiveMinuteChangePct: 4,
  fifteenMinuteChangePct: 9,
  fiveMinuteVolumeUsd: 15_000,
  fiveMinuteBuys: 38,
  fiveMinuteSells: 24,
  fiveMinuteBuyers: 24,
  poolAgeMinutes: 180,
};
const candles: MinuteCandle[] = [
  { timestampSeconds: nowSeconds - 180, open: 100, high: 102, low: 99.8, close: 101.5, volumeUsd: 10_000 },
  { timestampSeconds: nowSeconds - 120, open: 101.5, high: 104, low: 101, close: 103, volumeUsd: 12_000 },
  { timestampSeconds: nowSeconds - 60, open: 103, high: 105, low: 102.5, close: 104, volumeUsd: 14_000 },
  { timestampSeconds: nowSeconds - 10, open: 104, high: 104.5, low: 102.8, close: 103.8, volumeUsd: 8_000 },
];

test("logs the entered candidate as top while retaining the rejected pre-selection top", () => {
  const rejectedTop: ScalpCandidate = {
    ...selected,
    mint: "WifoutMint1111111111111111111111111111111",
    symbol: "Wifout",
    liquidityUsd: 10_000,
    fiveMinuteChangePct: 8,
  };
  const topBeforeSelection = {
    candidate: rejectedTop,
    evaluation: evaluateScalpCandidate(rejectedTop),
  };
  const decision = buildScalpEntryDecision({
    candidate: selected,
    market: {
      mint: selected.mint,
      pairAddress: selected.pairAddress,
      priceUsd: selected.priceUsd,
      liquidityUsd: selected.liquidityUsd,
      marketCapUsd: selected.marketCapUsd,
      fiveMinuteChangePct: selected.fiveMinuteChangePct,
    },
    minuteCandles: candles,
    pullbackPairAddress: selected.pairAddress,
    nowMs,
  });
  assert.equal(decision.accepted, true);

  const audit = buildScalpScanAudit({
    strategyVersion: "v3-test",
    topBeforeSelection,
    selectedDecision: decision,
    candidateDecisions: [topBeforeSelection],
  });

  assert.equal(audit.topSymbol, "Jimothy");
  assert.equal(audit.topMint, selected.mint);
  assert.equal(audit.selectedMint, selected.mint);
  assert.equal(audit.snapshot.entered, true);
  assert.equal(audit.snapshot.selectedSnapshotMatches, true);
  assert.equal(audit.snapshot.topBeforeSelection?.candidate.symbol, "Wifout");
});

test("logs all candidate decisions when no candidate is entered", () => {
  const rejected = {
    candidate: { ...selected, fifteenMinuteChangePct: 2.98 },
    evaluation: evaluateScalpCandidate({ ...selected, fifteenMinuteChangePct: 2.98 }),
  };
  const candidateDecisions = [rejected];
  const audit = buildScalpScanAudit({
    strategyVersion: "v3-test",
    topBeforeSelection: rejected,
    selectedDecision: null,
    candidateDecisions,
  });

  assert.equal(audit.snapshot.entered, false);
  assert.equal(audit.snapshot.candidateDecisions, candidateDecisions);
  assert.equal(audit.topSymbol, selected.symbol);
  assert.equal(audit.selectedMint, null);
});
