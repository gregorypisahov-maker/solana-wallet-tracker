import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import { walletSettlementFromTransaction } from "./liveWalletSettlement";

const owner = new PublicKey("11111111111111111111111111111111");
const other = new PublicKey("So11111111111111111111111111111111111111112");
const mint = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

function tx(input: {
  preSol: number;
  postSol: number;
  preUsdt: string;
  postUsdt: string;
}) {
  const keys = [other, owner];
  return {
    transaction: {
      message: {
        getAccountKeys: () => ({
          length: keys.length,
          get: (index: number) => keys[index],
        }),
      },
    },
    meta: {
      err: null,
      preBalances: [0, input.preSol],
      postBalances: [0, input.postSol],
      preTokenBalances: [
        { mint, owner: owner.toBase58(), uiTokenAmount: { amount: input.preUsdt } },
      ],
      postTokenBalances: [
        { mint, owner: owner.toBase58(), uiTokenAmount: { amount: input.postUsdt } },
      ],
      loadedAddresses: undefined,
    },
  };
}

test("buy settlement uses actual SOL and USDT deltas", () => {
  const result = walletSettlementFromTransaction(
    tx({
      preSol: 30_000_000,
      postSol: 2_815_000_000,
      preUsdt: "250000000",
      postUsdt: "50060000",
    }),
    owner,
    mint
  );
  assert.equal(result.solLamportsDelta, 2_785_000_000n);
  assert.equal(result.tokenRawDelta, -199_940_000n);
});

test("sell settlement uses actual USDT received and SOL fee-inclusive delta", () => {
  const result = walletSettlementFromTransaction(
    tx({
      preSol: 2_815_000_000,
      postSol: 29_990_000,
      preUsdt: "50060000",
      postUsdt: "252410321",
    }),
    owner,
    mint
  );
  assert.equal(result.solLamportsDelta, -2_785_010_000n);
  assert.equal(result.tokenRawDelta, 202_350_321n);
});

test("multiple owner token accounts are summed", () => {
  const transaction = tx({ preSol: 1, postSol: 1, preUsdt: "10", postUsdt: "20" });
  transaction.meta.preTokenBalances.push({
    mint,
    owner: owner.toBase58(),
    uiTokenAmount: { amount: "30" },
  });
  transaction.meta.postTokenBalances.push({
    mint,
    owner: owner.toBase58(),
    uiTokenAmount: { amount: "75" },
  });
  const result = walletSettlementFromTransaction(transaction, owner, mint);
  assert.equal(result.tokenRawDelta, 55n);
});
