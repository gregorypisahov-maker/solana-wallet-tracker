import assert from "node:assert/strict";
import test from "node:test";
import {
  extractMoonshotCandidateMints,
  parseMoonshotProgramIds,
  selectMoonshotSignatures,
} from "./moonshotScanner";

const WSOL = "So11111111111111111111111111111111111111112";
const TOKEN_A = "7YttLkHDoNj9wyDur5HUsxXW1jR5Lw3v3cV7hYB9pump";
const TOKEN_B = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6hZZ8VfKzP6VhB1P";

test("parseMoonshotProgramIds removes invalid and duplicate values", () => {
  const systemProgram = "11111111111111111111111111111111";
  const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

  assert.deepEqual(
    parseMoonshotProgramIds(
      `${systemProgram}, invalid-value ${tokenProgram} ${systemProgram}`
    ),
    [systemProgram, tokenProgram]
  );
});

test("extractMoonshotCandidateMints excludes WSOL and prioritizes newly visible mints", () => {
  const transaction = {
    meta: {
      preTokenBalances: [
        {
          mint: WSOL,
          owner: "wallet-one",
          accountIndex: 0,
          uiTokenAmount: { amount: "1", decimals: 9, uiAmount: 1 },
        },
        {
          mint: TOKEN_B,
          owner: "wallet-two",
          accountIndex: 1,
          uiTokenAmount: { amount: "10", decimals: 6, uiAmount: 10 },
        },
      ],
      postTokenBalances: [
        {
          mint: TOKEN_A,
          owner: "wallet-one",
          accountIndex: 2,
          uiTokenAmount: { amount: "100", decimals: 6, uiAmount: 100 },
        },
        {
          mint: TOKEN_B,
          owner: "wallet-two",
          accountIndex: 1,
          uiTokenAmount: { amount: "20", decimals: 6, uiAmount: 20 },
        },
      ],
    },
  } as any;

  const candidates = extractMoonshotCandidateMints(transaction);

  assert.deepEqual(
    candidates.map((candidate) => candidate.mint),
    [TOKEN_A, TOKEN_B]
  );
  assert.equal(candidates[0].newlyVisibleInPostBalances, true);
  assert.equal(candidates[1].newlyVisibleInPostBalances, false);
  assert.equal(candidates.some((candidate) => candidate.mint === WSOL), false);
});

test("extractMoonshotCandidateMints respects the transaction cap", () => {
  const transaction = {
    meta: {
      preTokenBalances: [],
      postTokenBalances: [
        { mint: TOKEN_A, owner: "one" },
        { mint: TOKEN_B, owner: "two" },
      ],
    },
  } as any;

  assert.equal(extractMoonshotCandidateMints(transaction, 1).length, 1);
});

test("selectMoonshotSignatures filters failed and stale signatures and returns oldest first", () => {
  const nowMs = 1_000_000;
  const signatures = [
    { signature: "newest", slot: 3, err: null, blockTime: 995 },
    { signature: "failed", slot: 2, err: { InstructionError: [0, "x"] }, blockTime: 994 },
    { signature: "oldest-fresh", slot: 1, err: null, blockTime: 990 },
    { signature: "stale", slot: 0, err: null, blockTime: 800 },
  ];

  assert.deepEqual(
    selectMoonshotSignatures(signatures, nowMs, 120_000).map(
      (signature) => signature.signature
    ),
    ["oldest-fresh", "newest"]
  );
});
