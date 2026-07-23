import assert from "node:assert/strict";
import test, { before } from "node:test";

let costs: typeof import("./executionCosts");

before(async () => {
  process.env.PAPER_COST_MODEL_ENABLED = "true";
  costs = await import("./executionCosts");
});

test("0.2 SOL in a $20k pool uses liquidity-scaled slippage", () => {
  const result = costs.calculateEntryExecutionCosts(0.2, 20_000);

  assert.equal(result.networkFeeSol, 0.00023043);
  assert.ok(Math.abs(result.swapFeeSol - 0.0025) < 1e-12);
  assert.ok(Math.abs(result.slippagePct - 0.00153396242463667) < 1e-12);
  assert.ok(Math.abs(result.slippageSol - 0.000306792484927334) < 1e-12);
  assert.ok(Math.abs(result.totalSol - 0.003037222484927334) < 1e-12);
});

test("slippage rises with size and falls with liquidity", () => {
  const small = costs.estimateLiquiditySlippagePct(0.1, 20_000);
  const large = costs.estimateLiquiditySlippagePct(0.2, 20_000);
  const deep = costs.estimateLiquiditySlippagePct(0.2, 40_000);

  assert.equal(large, small * 2);
  assert.equal(deep, large / 2);
});

test("failed entry decision is deterministic at the configured boundary", () => {
  assert.equal(costs.shouldSimulateFailedEntry(0), true);
  assert.equal(costs.shouldSimulateFailedEntry(0.049999), true);
  assert.equal(costs.shouldSimulateFailedEntry(0.05), false);
});

test("missing liquidity fails closed", () => {
  assert.throws(
    () => costs.calculateEntryExecutionCosts(0.2, 0),
    /liquidityUsd must be a positive finite number/
  );
});
