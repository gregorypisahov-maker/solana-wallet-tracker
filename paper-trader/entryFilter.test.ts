import assert from "node:assert/strict";
import test from "node:test";
import { evaluateEntry } from "./entryFilter";
import { AlertInput } from "./types";

const eligibleTwoWalletAlert: AlertInput = {
  tokenSymbol: "TEST",
  mint: "Mint111111111111111111111111111111111111",
  score: 29,
  walletCount: 2,
  totalBoughtSol: 3.2,
  marketCapUsd: 40_000,
  liquidityUsd: 14_400,
  averageTrustScore: 58,
  confidenceGrade: "B",
};

test("accepts a high-trust two-wallet signal at the evidence-backed floors", () => {
  const result = evaluateEntry(eligibleTwoWalletAlert);
  assert.equal(result.pass, true);
  assert.deepEqual(result.reasons, []);
});

test("keeps the historically weak trust 53-54 band blocked", () => {
  const result = evaluateEntry({
    ...eligibleTwoWalletAlert,
    averageTrustScore: 54.1,
  });
  assert.equal(result.pass, false);
  assert.ok(result.reasons.some((reason) => reason.includes("average trust")));
});

test("requires meaningful average buying even for two trusted wallets", () => {
  const result = evaluateEntry({
    ...eligibleTwoWalletAlert,
    totalBoughtSol: 2.2,
  });
  assert.equal(result.pass, false);
  assert.ok(result.reasons.some((reason) => reason.includes("avg buy")));
});

test("rejects a large thin-liquidity pool seen in recent alerts", () => {
  const result = evaluateEntry({
    ...eligibleTwoWalletAlert,
    marketCapUsd: 492_334,
    liquidityUsd: 62_194,
  });
  assert.equal(result.pass, false);
  assert.ok(result.reasons.some((reason) => reason.includes("liquidity/mcap")));
  assert.ok(result.reasons.some((reason) => reason.includes("above ceiling")));
});

test("continues to block confidence grade D", () => {
  const result = evaluateEntry({
    ...eligibleTwoWalletAlert,
    confidenceGrade: "D",
  });
  assert.equal(result.pass, false);
  assert.ok(result.reasons.includes("confidence grade D blocked"));
});

test("accepts one independently verified profitable leader at the normal market floors", () => {
  const result = evaluateEntry({
    ...eligibleTwoWalletAlert,
    walletCount: 1,
    totalBoughtSol: 1.6,
    averageTrustScore: undefined,
    confidenceGrade: undefined,
    signalSource: "proven_trader_copy",
    leaderWallet: "Leader111111111111111111111111111111111",
    leaderProfile: {
      profileVersion: 1,
      closedTrades: 12,
      distinctClosedTokens: 5,
      wins: 8,
      losses: 4,
      winRate: 8 / 12,
      realizedPnlSol: 1.2,
      grossProfitSol: 2.1,
      grossLossSol: 0.9,
      profitFactor: 2.333,
      maxDrawdownSol: 0.4,
      maxDrawdownToGrossProfit: 0.19,
      eligible: true,
    },
  });

  assert.equal(result.pass, true);
  assert.deepEqual(result.reasons, []);
});

test("does not let an unverified single wallet bypass consensus", () => {
  const result = evaluateEntry({
    ...eligibleTwoWalletAlert,
    walletCount: 1,
    totalBoughtSol: 1.6,
    averageTrustScore: undefined,
    confidenceGrade: undefined,
    signalSource: "proven_trader_copy",
  });

  assert.equal(result.pass, false);
  assert.ok(
    result.reasons.some((reason) => reason.includes("proven-trader profile"))
  );
  assert.ok(result.reasons.some((reason) => reason.includes("walletCount 1")));
});
