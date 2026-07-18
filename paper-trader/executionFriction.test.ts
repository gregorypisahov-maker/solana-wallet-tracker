import assert from "node:assert/strict";
import test from "node:test";
import { applyEntryFriction, applyExitFriction } from "./executionFriction";

test("charges the configured cost on both sides of a flat paper trade", () => {
  const entry = applyEntryFriction(1, 0.006);
  const exit = applyExitFriction(1, 0.006);
  const netReturnPct = (exit / entry - 1) * 100;

  assert.ok(netReturnPct < -1.19);
  assert.ok(netReturnPct > -1.21);
});
