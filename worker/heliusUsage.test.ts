import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateHeliusCredits,
  HeliusUsageTracker,
} from "./heliusUsage";

test("estimateHeliusCredits combines RPC calls and streamed data", () => {
  assert.equal(
    estimateHeliusCredits({
      signatureRequests: 20,
      transactionRequests: 30,
      websocketBytes: 100_001,
    }),
    54
  );
});

test("HeliusUsageTracker commits only the captured counters", () => {
  const tracker = new HeliusUsageTracker(1_000);
  tracker.increment("transactionRequests", 2);
  tracker.observeQueueDepth(4);

  const captured = tracker.snapshot(2_000);
  tracker.increment("transactionRequests", 1);
  tracker.commit(captured);

  const remaining = tracker.snapshot(3_000);
  assert.equal(remaining.transactionRequests, 1);
  assert.equal(remaining.maxQueueDepth, 0);
  assert.equal(remaining.periodStartedAt, new Date(2_000).toISOString());
});
