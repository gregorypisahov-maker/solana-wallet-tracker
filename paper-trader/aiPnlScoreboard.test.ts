import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateAiPnlScoreboard,
  parseAiPnlWindow,
} from "./aiPnlScoreboard";

test("parseAiPnlWindow defaults to 14d and accepts hours", () => {
  assert.deepEqual(parseAiPnlWindow(), {
    label: "14d",
    milliseconds: 14 * 24 * 60 * 60_000,
  });
  assert.deepEqual(parseAiPnlWindow("72h"), {
    label: "72h",
    milliseconds: 72 * 60 * 60_000,
  });
});

test("scoreboard applies explicit round-trip friction to recorded prices", () => {
  const nowMs = Date.parse("2026-07-30T07:00:00.000Z");
  const scoreboard = calculateAiPnlScoreboard({
    window: parseAiPnlWindow("14d"),
    nowMs,
    feeBps: 100,
    entries: 3,
    openPositions: 1,
    closedTrades: [
      {
        size_sol: 0.2,
        entry_price_usd: 1,
        exit_price_usd: 1.1,
        opened_at: "2026-07-30T05:00:00.000Z",
        closed_at: "2026-07-30T05:30:00.000Z",
      },
      {
        size_sol: 0.2,
        entry_price_usd: 1,
        exit_price_usd: 0.9,
        opened_at: "2026-07-30T06:00:00.000Z",
        closed_at: "2026-07-30T06:30:00.000Z",
      },
    ],
  });

  assert.equal(scoreboard.entries, 3);
  assert.equal(scoreboard.exits, 2);
  assert.equal(scoreboard.openPositions, 1);
  assert.equal(scoreboard.pricedExits, 2);
  assert.equal(scoreboard.wins, 1);
  assert.equal(scoreboard.losses, 1);
  assert.equal(scoreboard.winRatePct, 50);
  assert.ok(Math.abs((scoreboard.averageNetReturnPct ?? 0) - -1) < 1e-9);
  assert.ok(Math.abs((scoreboard.medianNetReturnPct ?? 0) - -1) < 1e-9);
  assert.ok(Math.abs((scoreboard.bestNetReturnPct ?? 0) - 8.9) < 1e-9);
  assert.ok(Math.abs((scoreboard.worstNetReturnPct ?? 0) - -10.9) < 1e-9);
  assert.ok(Math.abs(scoreboard.cumulativeNetPnlSol - -0.004) < 1e-9);
  assert.equal(scoreboard.averageHoldMinutes, 30);
});

test("scoreboard never fabricates a return when recorded prices are missing", () => {
  const scoreboard = calculateAiPnlScoreboard({
    window: parseAiPnlWindow("24h"),
    nowMs: Date.parse("2026-07-30T07:00:00.000Z"),
    feeBps: 100,
    entries: 1,
    openPositions: 0,
    closedTrades: [
      {
        size_sol: 0.2,
        entry_price_usd: 0,
        exit_price_usd: null,
        opened_at: "2026-07-30T06:00:00.000Z",
        closed_at: "2026-07-30T06:10:00.000Z",
      },
    ],
  });

  assert.equal(scoreboard.exits, 1);
  assert.equal(scoreboard.pricedExits, 0);
  assert.equal(scoreboard.unpricedExits, 1);
  assert.equal(scoreboard.winRatePct, null);
  assert.equal(scoreboard.averageNetReturnPct, null);
  assert.equal(scoreboard.cumulativeNetPnlSol, 0);
});
