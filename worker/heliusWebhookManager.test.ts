import assert from "node:assert/strict";
import test from "node:test";
import { ensureHeliusSwapWebhook } from "./heliusWebhookManager";

test("ensureHeliusSwapWebhook creates a filtered webhook when the slot is free", async () => {
  const requests: Array<{ url: string; method: string; body?: string }> = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    requests.push({
      url: input.toString(),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if ((init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response(JSON.stringify({ webhookID: "webhook-id" }), {
      status: 200,
    });
  }) as typeof fetch;

  const result = await ensureHeliusSwapWebhook({
    rpcUrl: "https://mainnet.helius-rpc.com/?api-key=secret",
    serviceRoleKey: "service-secret",
    webhookUrl: "https://example.com/api/helius",
    accountAddresses: ["wallet-b", "wallet-a"],
    fetchImpl,
  });

  assert.equal(result.active, true);
  assert.equal(result.action, "created");
  assert.equal(requests.length, 2);
  const body = JSON.parse(requests[1].body ?? "{}");
  assert.deepEqual(body.transactionTypes, ["SWAP"]);
  assert.deepEqual(body.accountAddresses, ["wallet-a", "wallet-b"]);
  assert.match(body.authHeader, /^Bearer [a-f0-9]{64}$/);
});

test("ensureHeliusSwapWebhook does not overwrite an unrelated Free-plan webhook", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify([
        { webhookID: "other", webhookURL: "https://other.example/hook" },
      ]),
      { status: 200 }
    )) as typeof fetch;

  const result = await ensureHeliusSwapWebhook({
    rpcUrl: "https://mainnet.helius-rpc.com/?api-key=secret",
    serviceRoleKey: "service-secret",
    webhookUrl: "https://example.com/api/helius",
    accountAddresses: ["wallet"],
    fetchImpl,
  });

  assert.equal(result.active, false);
  assert.equal(result.action, "conflict");
});

test("ensureHeliusSwapWebhook reactivates a disabled matching webhook", async () => {
  const methods: string[] = [];
  const fetchImpl = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    methods.push(method);
    if (method === "GET") {
      return new Response(
        JSON.stringify([
          {
            webhookID: "disabled",
            webhookURL: "https://example.com/api/helius",
            transactionTypes: ["SWAP"],
            accountAddresses: ["wallet"],
            active: false,
          },
        ]),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ active: true }), { status: 200 });
  }) as typeof fetch;

  const result = await ensureHeliusSwapWebhook({
    rpcUrl: "https://mainnet.helius-rpc.com/?api-key=secret",
    serviceRoleKey: "service-secret",
    webhookUrl: "https://example.com/api/helius",
    accountAddresses: ["wallet"],
    fetchImpl,
  });

  assert.equal(result.active, true);
  assert.equal(result.action, "reactivated");
  assert.deepEqual(methods, ["GET", "PATCH"]);
});

test("ensureHeliusSwapWebhook migrates the retired Vercel receiver", async () => {
  const methods: string[] = [];
  const fetchImpl = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    methods.push(method);
    if (method === "GET") {
      return new Response(
        JSON.stringify([
          {
            webhookID: "legacy",
            webhookURL: "https://solana-wallet-tracker.vercel.app/api/helius",
            transactionTypes: ["SWAP"],
            accountAddresses: ["wallet"],
            active: true,
          },
        ]),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ webhookID: "legacy" }), {
      status: 200,
    });
  }) as typeof fetch;

  const result = await ensureHeliusSwapWebhook({
    rpcUrl: "https://mainnet.helius-rpc.com/?api-key=secret",
    serviceRoleKey: "service-secret",
    webhookUrl:
      "https://project.supabase.co/functions/v1/helius-webhook",
    accountAddresses: ["wallet"],
    fetchImpl,
  });

  assert.equal(result.active, true);
  assert.equal(result.action, "updated");
  assert.deepEqual(methods, ["GET", "PUT"]);
});
