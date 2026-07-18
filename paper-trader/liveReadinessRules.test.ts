import assert from "node:assert/strict";
import test from "node:test";
import { calculateLiveReadiness, ReadinessPosition } from "./liveReadinessRules";

function forwardPositions(startedAtMs: number): ReadinessPosition[] {
  return Array.from({ length: 100 }, (_, index) => ({
    positionId: `position_${index}`,
    pnlSol: index % 3 === 0 ? -0.01 : 0.02,
    closedAt: new Date(startedAtMs + (index + 1) * 3_600_000).toISOString(),
  }));
}

test("marks a diversified profitable 45-day forward sample ready", () => {
  const nowMs = Date.now();
  const startedAtMs = nowMs - 46 * 86_400_000;
  const result = calculateLiveReadiness({
    positions: forwardPositions(startedAtMs),
    startedAt: new Date(startedAtMs).toISOString(),
    nowMs,
  });

  assert.equal(result.completedTrades, 100);
  assert.ok((result.profitFactor ?? 0) > 1.4);
  assert.equal(result.ready, true);
  assert.deepEqual(result.blockers, []);
});

test("keeps a profitable but immature sample blocked", () => {
  const nowMs = Date.now();
  const startedAtMs = nowMs - 10 * 86_400_000;
  const result = calculateLiveReadiness({
    positions: forwardPositions(startedAtMs).slice(0, 20),
    startedAt: new Date(startedAtMs).toISOString(),
    nowMs,
  });

  assert.equal(result.ready, false);
  assert.ok(result.blockers.includes("minimum_100_forward_trades_not_reached"));
  assert.ok(result.blockers.includes("minimum_45_forward_days_not_reached"));
});
