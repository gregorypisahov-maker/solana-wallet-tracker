import assert from "node:assert/strict";
import test from "node:test";
import { buildAiEntryFeatureSnapshot, captureStats } from "./aiEntryFeatures";

test("builds a rich entry snapshot with a stable join key", () => {
  const entryTs = "2026-07-30T09:30:00.000Z";
  const snapshot = buildAiEntryFeatureSnapshot({
    entryId: "ai_entry_test_1",
    entryTs,
    opportunity: {
      mint: "Mint111111111111111111111111111111111111111",
      token_symbol: "TEST",
      pair_address: "Pool111111111111111111111111111111111111111",
      score: 91,
      market_regime: "hot",
      liquidity_usd: 125_000,
      market_cap_usd: 600_000,
      price_change_m5: 6.5,
      price_change_h1: 31,
      volume_m5_usd: 44_000,
      volume_h1_usd: 210_000,
      buys_m5: 80,
      sells_m5: 20,
      pool_age_minutes: 42,
      signal_snapshot: {
        discoveryServedFrom: "live",
        fdvUsd: 650_000,
        volumeH24Usd: 1_800_000,
        priceChangeH24: 84,
        uniqueMakersM5: 63,
        dexId: "pumpswap",
        subScores: { liquidity: 17, volume: 12, buyPressure: 16 },
      },
      entry_safety: {
        heliusWouldBlock: false,
        top10HolderPct: 38.4,
        lp_lock: { verdict: "LOCKED", method: "burned", pctLocked: 99.5, action: "pass" },
      },
    },
    market: {
      priceUsd: 0.000123,
      liquidityUsd: 125_000,
      marketCapUsd: 600_000,
      changeM5: 6.5,
      priceSource: "helius",
      poolProgram: "pumpswap",
    },
  });

  assert.equal(snapshot.entry_id, "ai_entry_test_1");
  assert.equal(snapshot.entry_ts, entryTs);
  assert.equal(snapshot.poolProgram, "pumpswap");
  assert.equal(snapshot.top10_holder_pct, 38.4);
  assert.equal(snapshot.vol_24h, 1_800_000);
  assert.equal(snapshot.buy_sell_ratio, 0.8);
  assert.equal((snapshot.feature_source as any).price_usd_at_entry, "helius");
  assert.ok(snapshot.capture.nonnull >= 19);
  assert.equal(snapshot.capture.total, 21);
});

test("keeps genuinely unavailable fields null without fabricating values", () => {
  const snapshot = buildAiEntryFeatureSnapshot({
    entryId: "ai_entry_test_2",
    entryTs: "2026-07-30T09:31:00.000Z",
    opportunity: {
      mint: "Mint222222222222222222222222222222222222222",
      token_symbol: "NULLS",
      pair_address: "Pool222222222222222222222222222222222222222",
      score: 84,
      market_regime: "selective",
      liquidity_usd: 50_000,
      market_cap_usd: 200_000,
      price_change_m5: 2,
      price_change_h1: 8,
      volume_m5_usd: 10_000,
      volume_h1_usd: 25_000,
      buys_m5: 12,
      sells_m5: 8,
      pool_age_minutes: 25,
      signal_snapshot: { discoveryServedFrom: "cache", subScores: { liquidity: 10 } },
      entry_safety: { heliusWouldBlock: true },
    },
    market: {
      priceUsd: 0.002,
      liquidityUsd: 50_000,
      marketCapUsd: 200_000,
      changeM5: 2,
      priceSource: "dex",
      poolProgram: null,
    },
  });

  assert.equal(snapshot.holder_count, null);
  assert.equal(snapshot.top10_holder_pct, null);
  assert.equal(snapshot.unique_makers_5m, null);
  assert.equal((snapshot.feature_source as any).liquidity_usd, "cache");
  assert.equal((snapshot.feature_source as any).price_usd_at_entry, "dex");
  assert.deepEqual(snapshot.capture, captureStats(snapshot));
});
