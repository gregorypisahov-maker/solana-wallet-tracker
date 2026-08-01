import test from "node:test";
import assert from "node:assert/strict";
import {
  atr,
  calculateSpotExit,
  deriveSpotRiskPlan,
  ema,
  evaluateSolSpotEntry,
  floorToStep,
  rsi,
  type Candle,
} from "./solSpotPaper";

function candlesFromCloses(closes: number[], volume = 100_000): Candle[] {
  return closes.map((close, index) => ({
    open: close * 0.998,
    high: close * 1.003,
    low: close * 0.997,
    close,
    quoteVolume: volume * (1 + (index % 3) * 0.05),
    closeTimeMs: 1_700_000_000_000 + index * 300_000,
  }));
}

test("indicator helpers produce finite trend values", () => {
  const closes = Array.from({ length: 60 }, (_, index) => 100 + index * 0.2);
  assert.ok((ema(closes, 20) ?? 0) > 0);
  assert.ok((rsi(closes, 14) ?? 0) > 70);
  assert.ok((atr(candlesFromCloses(closes), 14) ?? 0) > 0);
});

test("entry scoring passes a supportive SOL trend without requiring every signal", () => {
  const fiveMinute = candlesFromCloses(
    Array.from({ length: 80 }, (_, index) => 100 + index * 0.03 + Math.sin(index / 2) * 0.6)
  );
  const hourly = candlesFromCloses(
    Array.from({ length: 80 }, (_, index) => 90 + index * 0.18)
  );
  const result = evaluateSolSpotEntry(fiveMinute, hourly, 6);
  assert.equal(result.passed, true);
  assert.ok(result.score >= 6);
  assert.ok(result.stopDistancePct >= 0.8);
});

test("entry scoring blocks a clear hourly downtrend", () => {
  const fiveMinute = candlesFromCloses(
    Array.from({ length: 80 }, (_, index) => 100 + index * 0.03)
  );
  const hourly = candlesFromCloses(
    Array.from({ length: 80 }, (_, index) => 120 - index * 0.25)
  );
  const result = evaluateSolSpotEntry(fiveMinute, hourly, 6);
  assert.equal(result.passed, false);
  assert.ok(result.blockers.includes("hourly_downtrend"));
});

test("spot sizing respects exchange steps, bankroll cap and fees", () => {
  const plan = deriveSpotRiskPlan({
    bankrollUsdt: 1_000,
    marketPrice: 160,
    signalPrice: 159.8,
    stopDistancePct: 1,
    quantityStep: 0.001,
    minimumQuantity: 0.001,
    minimumNotional: 5,
  });
  assert.ok(plan);
  assert.equal(plan.quantity, floorToStep(plan.quantity, 0.001));
  assert.ok(plan.quoteSpentUsdt <= 200.01);
  assert.ok(plan.stopLossPrice < plan.entryFillPrice);
  assert.ok(plan.takeProfitPrice > plan.entryFillPrice);
});

test("spot exit calculation includes adverse slippage and both trading fees", () => {
  const result = calculateSpotExit({
    quantity: 1,
    entryFillPrice: 100,
    entryFeeUsdt: 0.1,
    quoteSpentUsdt: 100.1,
    marketExitPrice: 102,
    exitSlippagePct: 0.03,
    feePct: 0.1,
  });
  assert.equal(Number(result.exitFillPrice.toFixed(4)), 101.9694);
  assert.equal(Number(result.exitFeeUsdt.toFixed(6)), 0.101969);
  assert.equal(Number(result.netPnlUsdt.toFixed(6)), 1.767431);
  assert.ok(result.netReturnPct > 1.7);
});
