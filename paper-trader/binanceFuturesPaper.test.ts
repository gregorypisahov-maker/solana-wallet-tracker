import test from "node:test";
import assert from "node:assert/strict";
import {
  calculatePumpMeasurement,
  calculateShortTrade,
  floorToStep,
} from "./binanceFuturesPaper";

test("pump measurement uses the lowest prior close in the rolling window", () => {
  const result = calculatePumpMeasurement([100, 101, 100.5, 102, 103]);
  assert.ok(result);
  assert.equal(result.rollingLow, 100);
  assert.equal(Number(result.changePct.toFixed(6)), 3);
});

test("quantity is rounded down to the exchange step without exceeding budget", () => {
  assert.equal(floorToStep(0.00251, 0.001), 0.002);
  assert.equal(floorToStep(12.349, 0.01), 12.34);
});

test("short PnL includes adverse exit slippage and fees on both sides", () => {
  const result = calculateShortTrade({
    entryFillPrice: 100,
    marketExitPrice: 98,
    quantity: 2,
    marginUsdt: 40,
    entryFeeUsdt: 0.1,
    exitSlippagePct: 0.02,
    feePct: 0.05,
  });

  assert.equal(Number(result.exitFillPrice.toFixed(4)), 98.0196);
  assert.equal(Number(result.grossPnlUsdt.toFixed(4)), 3.9608);
  assert.equal(Number(result.exitFeeUsdt.toFixed(6)), 0.09802);
  assert.equal(Number(result.netPnlUsdt.toFixed(6)), 3.76278);
  assert.equal(Number(result.marginReturnPct.toFixed(4)), 9.407);
});
