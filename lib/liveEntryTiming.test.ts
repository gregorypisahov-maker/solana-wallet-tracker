import assert from "node:assert/strict";
import test from "node:test";
import { evaluateLiveEntryTiming } from "../live-executor/liveEntryTiming";

const now = Date.parse("2026-07-28T20:20:39.512Z");
const maxAgeMs = 45_000;

test("accepts a trigger signal using decision_at", () => {
  const result = evaluateLiveEntryTiming(
    {
      created_at: "2026-07-28T20:20:37.512Z",
      metadata: { decision_at: "2026-07-28T20:20:37.512Z" },
    },
    maxAgeMs,
    now
  );
  assert.equal(result.field, "decision_at");
  assert.equal(result.sourceAgeMs, 2_000);
  assert.equal(result.expired, false);
  assert.equal(result.tooFarInFuture, false);
});

test("prefers source_opened_at over other timestamps", () => {
  const result = evaluateLiveEntryTiming(
    {
      created_at: "2026-07-28T20:20:20.000Z",
      metadata: {
        source_opened_at: "2026-07-28T20:20:38.512Z",
        decision_at: "2026-07-28T20:20:30.000Z",
      },
    },
    maxAgeMs,
    now
  );
  assert.equal(result.field, "source_opened_at");
  assert.equal(result.sourceAgeMs, 1_000);
});

test("falls back to created_at when metadata timestamps are unavailable", () => {
  const result = evaluateLiveEntryTiming(
    { created_at: "2026-07-28T20:20:37.512Z", metadata: {} },
    maxAgeMs,
    now
  );
  assert.equal(result.field, "created_at");
  assert.equal(result.sourceAgeMs, 2_000);
  assert.equal(result.expired, false);
});

test("skips an invalid higher-priority timestamp and uses a valid fallback", () => {
  const result = evaluateLiveEntryTiming(
    {
      created_at: "2026-07-28T20:20:37.512Z",
      metadata: {
        source_opened_at: "not-a-date",
        decision_at: "2026-07-28T20:20:36.512Z",
      },
    },
    maxAgeMs,
    now
  );
  assert.equal(result.field, "decision_at");
  assert.equal(result.sourceAgeMs, 3_000);
});

test("marks signals older than the configured window as expired", () => {
  const result = evaluateLiveEntryTiming(
    {
      created_at: "2026-07-28T20:19:00.000Z",
      metadata: { source_opened_at: "2026-07-28T20:19:00.000Z" },
    },
    maxAgeMs,
    now
  );
  assert.equal(result.expired, true);
  assert.ok((result.sourceAgeMs ?? 0) > maxAgeMs);
});

test("clamps small future clock skew to zero age", () => {
  const result = evaluateLiveEntryTiming(
    {
      created_at: "2026-07-28T20:20:42.512Z",
      metadata: { source_opened_at: "2026-07-28T20:20:42.512Z" },
    },
    maxAgeMs,
    now,
    5_000
  );
  assert.equal(result.rawAgeMs, -3_000);
  assert.equal(result.sourceAgeMs, 0);
  assert.equal(result.tooFarInFuture, false);
});

test("rejects timestamps too far in the future", () => {
  const result = evaluateLiveEntryTiming(
    {
      created_at: "2026-07-28T20:20:49.512Z",
      metadata: { source_opened_at: "2026-07-28T20:20:49.512Z" },
    },
    maxAgeMs,
    now,
    5_000
  );
  assert.equal(result.tooFarInFuture, true);
});

test("reports invalid when no timestamp can be parsed", () => {
  const result = evaluateLiveEntryTiming(
    {
      created_at: "invalid",
      metadata: { source_opened_at: "", decision_at: "also-invalid" },
    },
    maxAgeMs,
    now
  );
  assert.equal(result.valid, false);
  assert.equal(result.field, null);
});
