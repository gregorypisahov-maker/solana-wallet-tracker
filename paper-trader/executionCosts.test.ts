import assert from "node:assert/strict";
import test, { before } from "node:test";

let costs: typeof import("./executionCosts");

before(async () => {
  process.env.PAPER_COST_MODEL_ENABLED = "true";
  costs = await import("./executionCosts");
});

test("0.2 SOL in a $20k pool includes base fee, priority fee, Jito tip, swap fee and slippage", () => {
  const result = costs.calculateEntryExecutionCosts(0.2, 20_000);

  assert.equal(costs.PAPER_COST_MODEL.baseFeeSolPerTransaction, 0.000005);
  assert.equal(costs.PAPER_COST_MODEL.priorityFeeSolPerTransaction, 0.00022543);
  assert.equal(costs.PAPER_COST_MODEL.jitoTipSolPerTransaction, 0.0000998);
  assert.ok(Math.abs(result.networkFeeSol - 0.00033023) < 1e-12);
  assert.ok(Math.abs(result.swapFeeSol - 0.0025) < 1e-12);
  assert.ok(Math.abs(result.slippagePct - 0.00153396242463667) < 1e-12);
  assert.ok(Math.abs(result.slippageSol - 0.000306792484927334) < 1e-12);
  assert.ok(Math.abs(result.totalSol - 0.003137022484927334) < 1e-12);
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
