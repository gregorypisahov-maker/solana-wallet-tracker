import assert from "node:assert/strict";
import test from "node:test";
import {
  getRateLimitDelayMs,
  isFreshTimestamp,
  readBoundedNumber,
  RpcPacer,
} from "./monitorSafety";

test("readBoundedNumber uses a fallback and clamps unsafe values", () => {
  assert.equal(readBoundedNumber(undefined, 15, 5, 60), 15);
  assert.equal(readBoundedNumber("not-a-number", 15, 5, 60), 15);
  assert.equal(readBoundedNumber("1", 15, 5, 60), 5);
  assert.equal(readBoundedNumber("500", 15, 5, 60), 60);
  assert.equal(readBoundedNumber("20", 15, 5, 60), 20);
});

test("isFreshTimestamp rejects stale and implausibly future trades", () => {
  const now = Date.parse("2026-07-16T00:00:00.000Z");

  assert.equal(
    isFreshTimestamp(new Date(now - 60_000), now, 120_000),
    true
  );
  assert.equal(
    isFreshTimestamp(new Date(now - 121_000), now, 120_000),
    false
  );
  assert.equal(
    isFreshTimestamp(new Date(now + 31_000), now, 120_000),
    false
  );
});

test("getRateLimitDelayMs backs off exponentially with bounded jitter", () => {
  assert.equal(getRateLimitDelayMs(0, () => 0), 2_000);
  assert.equal(getRateLimitDelayMs(1, () => 0.5), 4_250);
  assert.equal(getRateLimitDelayMs(9, () => 1), 30_500);
});

test("RpcPacer spaces request starts even when work is queued together", async () => {
  let now = 1_000;
  const waits: number[] = [];
  const starts: number[] = [];
  const pacer = new RpcPacer(
    100,
    () => now,
    async (ms) => {
      waits.push(ms);
      now += ms;
    }
  );

  await Promise.all([
    pacer.run(async () => starts.push(now)),
    pacer.run(async () => starts.push(now)),
    pacer.run(async () => starts.push(now)),
  ]);

  assert.deepEqual(starts, [1_000, 1_100, 1_200]);
  assert.deepEqual(waits, [100, 100]);
});
