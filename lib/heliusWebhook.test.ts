import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveHeliusWebhookToken,
  extractHeliusApiKey,
  extractTradesFromEnhancedTransaction,
  isValidHeliusWebhookAuthorization,
} from "./heliusWebhook";

const wallet = "wallet-address";
const mint = "token-mint";

test("extractTradesFromEnhancedTransaction extracts a wallet buy", () => {
  const result = extractTradesFromEnhancedTransaction(
    {
      type: "SWAP",
      signature: "signature",
      timestamp: 1_700_000_000,
      fee: 5_000,
      accountData: [
        { account: wallet, nativeBalanceChange: -1_000_005_000 },
        {
          account: "token-account",
          tokenBalanceChanges: [
            {
              mint,
              userAccount: wallet,
              rawTokenAmount: { tokenAmount: "2500000", decimals: 6 },
            },
          ],
        },
      ],
    },
    new Set([wallet])
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].trade.side, "buy");
  assert.equal(result[0].trade.solAmount, 1.000005);
  assert.equal(result[0].trade.tokenAmount, 2.5);
});

test("extractTradesFromEnhancedTransaction ignores non-swap payloads", () => {
  assert.deepEqual(
    extractTradesFromEnhancedTransaction(
      { type: "TRANSFER", signature: "signature", timestamp: 1 },
      new Set([wallet])
    ),
    []
  );
});

test("webhook authentication is derived without exposing the service key", () => {
  const token = deriveHeliusWebhookToken("service-secret");
  assert.equal(
    isValidHeliusWebhookAuthorization(`Bearer ${token}`, "service-secret"),
    true
  );
  assert.equal(
    isValidHeliusWebhookAuthorization("Bearer wrong", "service-secret"),
    false
  );
  assert.equal(
    extractHeliusApiKey(
      "https://mainnet.helius-rpc.com/?api-key=helius-secret"
    ),
    "helius-secret"
  );
});
