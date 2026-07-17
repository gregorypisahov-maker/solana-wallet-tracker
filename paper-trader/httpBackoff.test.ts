import assert from "node:assert/strict";
import test from "node:test";
import {
  HttpResponseError,
  RateLimitGate,
  exponentialBackoffMs,
  fetchJsonWithBackoff,
  parseRetryAfterMs,
} from "./httpBackoff";

test("parses Retry-After seconds and dates", () => {
  const nowMs = Date.parse("2026-07-17T12:00:00.000Z");
  assert.equal(parseRetryAfterMs("2", nowMs), 2_000);
  assert.equal(
    parseRetryAfterMs("Fri, 17 Jul 2026 12:00:05 GMT", nowMs),
    5_000
  );
  assert.equal(parseRetryAfterMs("invalid", nowMs), null);
});

test("caps exponential backoff and uses bounded jitter", () => {
  assert.equal(exponentialBackoffMs(0, 1_000, 15_000, 0), 1_000);
  assert.equal(exponentialBackoffMs(1, 1_000, 15_000, 0.5), 2_500);
  assert.equal(exponentialBackoffMs(10, 1_000, 15_000, 1), 15_000);
});

test("retries GeckoTerminal 429 using Retry-After and then succeeds", async () => {
  const sleeps: number[] = [];
  let attempts = 0;
  const gate = new RateLimitGate();
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "3" },
      });
    }
    return Response.json({ ok: true });
  };

  const result = await fetchJsonWithBackoff("https://api.geckoterminal.com/test", {
    fetchImpl: fetchImpl as typeof fetch,
    sleepImpl: async (ms) => { sleeps.push(ms); },
    randomImpl: () => 0,
    rateLimitGate: gate,
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [3_000]);
  assert.ok(gate.remainingMs() > 0);
});

test("does not retry non-retryable client errors", async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    return new Response("bad request", { status: 400 });
  };

  await assert.rejects(
    fetchJsonWithBackoff("https://example.test", {
      fetchImpl: fetchImpl as typeof fetch,
      sleepImpl: async () => undefined,
    }),
    (error: unknown) => error instanceof HttpResponseError && error.status === 400
  );
  assert.equal(attempts, 1);
});

test("retries server errors with exponential delay", async () => {
  const sleeps: number[] = [];
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts < 3) return new Response("temporary", { status: 503 });
    return Response.json({ recovered: true });
  };

  const result = await fetchJsonWithBackoff("https://example.test", {
    fetchImpl: fetchImpl as typeof fetch,
    sleepImpl: async (ms) => { sleeps.push(ms); },
    randomImpl: () => 0,
    baseDelayMs: 500,
  });

  assert.deepEqual(result, { recovered: true });
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [500, 1_000]);
});
