import assert from "node:assert/strict";
import test from "node:test";
import { reduceWalletLimitForMonthlyBudget } from "./heliusBudget";

test("budget guard keeps a wallet limit that is under target", () => {
  assert.equal(
    reduceWalletLimitForMonthlyBudget({
      currentLimit: 6,
      minimumLimit: 3,
      projectedMonthlyCredits: 500_000,
      targetMonthlyCredits: 700_000,
    }),
    6
  );
});

test("budget guard reduces coverage proportionally when over target", () => {
  assert.equal(
    reduceWalletLimitForMonthlyBudget({
      currentLimit: 6,
      minimumLimit: 3,
      projectedMonthlyCredits: 900_000,
      targetMonthlyCredits: 700_000,
    }),
    4
  );
});

test("budget guard always makes progress but respects the minimum", () => {
  assert.equal(
    reduceWalletLimitForMonthlyBudget({
      currentLimit: 4,
      minimumLimit: 3,
      projectedMonthlyCredits: 10_000_000,
      targetMonthlyCredits: 700_000,
    }),
    3
  );
});
