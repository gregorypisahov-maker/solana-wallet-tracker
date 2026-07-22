import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateDumpMeasurement,
  calculateLongTrade,
} from "./binanceFuturesBidirectionalRest";

test("dump measurement uses the highest prior close in the rolling window", () => {
  const result = calculateDumpMeasurement([100, 99, 100, 98, 97]);
  assert.ok(result);
  assert.equal(result.rollingHigh, 100);
  assert.equal(Number(result.changePct.toFixed(6)), 3);
});

test("long PnL includes adverse exit slippage and fees on both sides", () => {
  const result = calculateLongTrade({
    entryFillPrice: 100,
    marketExitPrice: 102,
    quantity: 2,
    marginUsdt: 40,
    entryFeeUsdt: 0.1,
    exitSlippagePct: 0.02,
    feePct: 0.05,
  });

  assert.equal(Number(result.exitFillPrice.toFixed(4)), 101.9796);
  assert.equal(Number(result.grossPnlUsdt.toFixed(4)), 3.9592);
  assert.equal(Number(result.exitFeeUsdt.toFixed(6)), 0.10198);
  assert.equal(Number(result.netPnlUsdt.toFixed(6)), 3.75722);
  assert.equal(Number(result.marginReturnPct.toFixed(4)), 9.3931);
});
