import assert from "node:assert/strict";
import test from "node:test";
import { TwelveDataMarketDataClient } from "./twelveDataClient";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("Twelve Data snapshot is chronological and applies a conservative paper spread", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return response({
      meta: {
        symbol: "XAU/USD",
        name: "Gold Spot / US Dollar",
        interval: "15min",
        exchange_timezone: "UTC",
      },
      values: [
        {
          datetime: "2026-08-05 12:15:00",
          open: "2001.00000",
          high: "2003.00000",
          low: "2000.00000",
          close: "2002.00000",
        },
        {
          datetime: "2026-08-05 12:00:00",
          open: "1998.00000",
          high: "2002.00000",
          low: "1997.00000",
          close: "2001.00000",
        },
      ],
      status: "ok",
    });
  }) as typeof fetch;

  const client = new TwelveDataMarketDataClient({
    apiKey: "test-key",
    symbol: "XAU/USD",
    syntheticSpreadUsd: 0.5,
    fetchImpl,
    now: () => new Date("2026-08-05T12:17:00.000Z"),
  });

  const snapshot = await client.getSnapshot("M15", 300);

  assert.equal(calls, 1);
  assert.deepEqual(snapshot.candles.map((candle) => candle.time), [
    "2026-08-05T12:00:00.000Z",
    "2026-08-05T12:15:00.000Z",
  ]);
  assert.deepEqual(snapshot.candles.map((candle) => candle.complete), [true, false]);
  assert.equal(snapshot.quote.bid, 2001.75);
  assert.equal(snapshot.quote.ask, 2002.25);
  assert.equal(snapshot.quote.time, "2026-08-05T12:15:00.000Z");
  assert.equal(snapshot.instrument.name, "XAU/USD");
  assert.equal(snapshot.instrument.minimumTradeSize, 0.01);
});

test("Twelve Data API errors are surfaced without exposing the API key", async () => {
  const fetchImpl = (async () => response({
    status: "error",
    code: 401,
    message: "invalid api key",
  })) as typeof fetch;

  const client = new TwelveDataMarketDataClient({
    apiKey: "secret-key-that-must-not-appear",
    symbol: "XAU/USD",
    syntheticSpreadUsd: 0.5,
    fetchImpl,
  });

  await assert.rejects(
    () => client.getSnapshot("M15", 300),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /invalid api key/i);
      assert.doesNotMatch(error.message, /secret-key-that-must-not-appear/);
      return true;
    },
  );
});
