import assert from "node:assert/strict";
import test from "node:test";
import {
  HeliusProfileTransaction,
  profileProvenTraderTransactions,
} from "./provenTraderProfile";

const wallet = "LeaderWallet111111111111111111111111111111";
const counterparty = "Counterparty111111111111111111111111111";

function swap(
  timestamp: number,
  mint: string,
  tokenDelta: number,
  solDelta: number
): HeliusProfileTransaction {
  return {
    timestamp,
    accountData: [
      {
        account: wallet,
        nativeBalanceChange: solDelta * 1_000_000_000,
      },
    ],
    tokenTransfers: [
      tokenDelta > 0
        ? {
            mint,
            fromUserAccount: counterparty,
            toUserAccount: wallet,
            tokenAmount: tokenDelta,
          }
        : {
            mint,
            fromUserAccount: wallet,
            toUserAccount: counterparty,
            tokenAmount: Math.abs(tokenDelta),
          },
    ],
  };
}

test("qualifies a diversified wallet with repeat realized SOL profits", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const transactions: HeliusProfileTransaction[] = [];

  for (let index = 0; index < 8; index += 1) {
    const mint = `Mint${index % 4}111111111111111111111111111111111`;
    const opened = nowSec - (20 - index * 2) * 3_600;
    transactions.push(swap(opened, mint, 100, -1));
    transactions.push(
      swap(opened + 1_800, mint, -100, index < 6 ? 1.4 : 0.7)
    );
  }

  const profile = profileProvenTraderTransactions(transactions, wallet);
  assert.equal(profile.closedTrades, 8);
  assert.equal(profile.wins, 6);
  assert.equal(profile.losses, 2);
  assert.equal(profile.distinctClosedTokens, 4);
  assert.ok((profile.profitFactor ?? 0) > 3.9);
  assert.ok(profile.realizedPnlSol > 1.7);
  assert.equal(profile.eligible, true);
  assert.deepEqual(profile.rejectionReasons, []);
});

test("rejects activity without enough closed profitable trades", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const profile = profileProvenTraderTransactions(
    [
      swap(nowSec - 3_600, "MintA111111111111111111111111111111111", 100, -1),
      swap(nowSec - 1_800, "MintA111111111111111111111111111111111", -100, 0.8),
    ],
    wallet
  );

  assert.equal(profile.eligible, false);
  assert.ok(profile.rejectionReasons.includes("leader_closed_trades_below_8"));
  assert.ok(profile.rejectionReasons.includes("leader_realized_pnl_too_low"));
});

test("ignores sells whose cost basis predates the lookback", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const profile = profileProvenTraderTransactions(
    [
      swap(nowSec - 20 * 86_400, "OldMint1111111111111111111111111111111", 100, -1),
      swap(nowSec - 3_600, "OldMint1111111111111111111111111111111", -100, 2),
    ],
    wallet
  );

  assert.equal(profile.closedTrades, 0);
  assert.equal(profile.realizedPnlSol, 0);
});
