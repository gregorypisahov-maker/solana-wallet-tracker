import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePaperReadiness } from "./readiness";

test("paper readiness requires every risk and evidence gate", () => {
  const result = evaluatePaperReadiness({
    completedPositions: 100,
    totalPnlSol: 1,
    profitFactor: 1.4,
    maxDrawdownPct: 9,
    halted: false,
  });

  assert.equal(result.ready, true);
  assert.equal(result.checks.every((check) => check.passed), true);
});

test("paper readiness rejects a tiny lucky sample", () => {
  const result = evaluatePaperReadiness({
    completedPositions: 3,
    totalPnlSol: 2,
    profitFactor: 5,
    maxDrawdownPct: 1,
    halted: false,
  });

  assert.equal(result.ready, false);
  assert.equal(result.checks[0].passed, false);
});
