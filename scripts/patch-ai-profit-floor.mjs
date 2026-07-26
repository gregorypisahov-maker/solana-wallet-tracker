import fs from "node:fs";

function patch(path, replacements) {
  let text = fs.readFileSync(path, "utf8");
  let changed = false;
  for (const { from, to, marker } of replacements) {
    if (marker && text.includes(marker)) continue;
    if (!text.includes(from)) {
      console.warn(`[patch-ai-profit-floor] pattern missing in ${path}: ${from.slice(0, 140)}`);
      continue;
    }
    text = text.replace(from, to);
    changed = true;
  }
  if (changed) fs.writeFileSync(path, text);
}

patch("paper-trader/aiDiscoveryTrader.ts", [
  {
    from: "const TRAIL_DISTANCE_PCT = 4;",
    to: `const TRAIL_DISTANCE_PCT = 4;
const PROFIT_FLOOR_NET_PCT = 3;
const PROFIT_FLOOR_GROSS_PCT = PROFIT_FLOOR_NET_PCT + ENTRY_FRICTION_PCT + EXIT_FRICTION_PCT;`,
    marker: "const PROFIT_FLOOR_NET_PCT = 3;",
  },
  {
    from: 'else if (peakPct >= TRAIL_ARM_PCT && pullbackPct <= -TRAIL_DISTANCE_PCT) reason = "trailing_stop";',
    to: 'else if (peakPct >= TRAIL_ARM_PCT && grossPct <= PROFIT_FLOOR_GROSS_PCT) reason = "profit_floor"; else if (peakPct >= TRAIL_ARM_PCT && pullbackPct <= -TRAIL_DISTANCE_PCT) reason = "trailing_stop";',
    marker: 'reason = "profit_floor"',
  },
  {
    from: "const trailingFloorPriceUsd = trailingArmed ? peak * (1 - TRAIL_DISTANCE_PCT / 100) : null;",
    to: "const trailingFloorPriceUsd = trailingArmed ? Math.max(peak * (1 - TRAIL_DISTANCE_PCT / 100), entry * (1 + PROFIT_FLOOR_GROSS_PCT / 100)) : null;",
    marker: "entry * (1 + PROFIT_FLOOR_GROSS_PCT / 100)",
  },
]);

patch("app/api/ai-position-live/route.ts", [
  {
    from: "const TRAIL_DISTANCE_PCT = 4;",
    to: `const TRAIL_DISTANCE_PCT = 4;
const PROFIT_FLOOR_NET_PCT = 3;
const PROFIT_FLOOR_GROSS_PCT = PROFIT_FLOOR_NET_PCT + ENTRY_FRICTION_PCT + EXIT_FRICTION_PCT;`,
    marker: "const PROFIT_FLOOR_NET_PCT = 3;",
  },
  {
    from: "const trailingFloorPrice = trailingArmed ? peakPrice * (1 - TRAIL_DISTANCE_PCT / 100) : null;",
    to: "const trailingFloorPrice = trailingArmed ? Math.max(peakPrice * (1 - TRAIL_DISTANCE_PCT / 100), entryPrice * (1 + PROFIT_FLOOR_GROSS_PCT / 100)) : null;",
    marker: "entryPrice * (1 + PROFIT_FLOOR_GROSS_PCT / 100)",
  },
  {
    from: 'else if (trailingArmed && trailingFloorPrice !== null && currentPrice <= trailingFloorPrice) exitStatus = "Trailing stop should execute";',
    to: 'else if (trailingArmed && grossReturnPct <= PROFIT_FLOOR_GROSS_PCT) exitStatus = "Profit floor should execute"; else if (trailingArmed && trailingFloorPrice !== null && currentPrice <= trailingFloorPrice) exitStatus = "Trailing stop should execute";',
    marker: 'exitStatus = "Profit floor should execute"',
  },
  {
    from: "        trailDistancePct: TRAIL_DISTANCE_PCT,",
    to: `        trailDistancePct: TRAIL_DISTANCE_PCT,
        profitFloorNetPct: PROFIT_FLOOR_NET_PCT,
        profitFloorGrossPct: PROFIT_FLOOR_GROSS_PCT,`,
    marker: "profitFloorNetPct: PROFIT_FLOOR_NET_PCT",
  },
]);

patch("app/page.tsx", [
  {
    from: 'trailFloor ? "4% below the highest price" : "Appears after trail is armed"',
    to: 'trailFloor ? "Higher of 4% trail or +3% net floor" : "Appears after trail is armed"',
    marker: "Higher of 4% trail or +3% net floor",
  },
  {
    from: "The bot sells when the first rule is hit: hard stop, take profit, armed trailing stop, maximum hold, or your manual paper sell.",
    to: "The bot sells when the first rule is hit: hard stop, take profit, +3% net profit floor after trailing arms, armed trailing stop, maximum hold, or your manual paper sell.",
    marker: "+3% net profit floor after trailing arms",
  },
  {
    from: 'sub={price > 0 ? `Realized PnL since this bot started · USD at current SOL price (${usd(price)})` : "Realized PnL since this bot started · SOL/USD price temporarily unavailable"}',
    to: 'sub={price > 0 ? `Exact internal 24-hour cycles · USD at current SOL price (${usd(price)})` : "Exact internal 24-hour cycles · SOL/USD price temporarily unavailable"}',
    marker: "Exact internal 24-hour cycles",
  },
  {
    from: '<small>{row.complete ? "Complete 24h" : "Current 24h · live"}</small>',
    to: '<small>{row.complete ? "Complete 24h" : `Current 24h · ends ${exactIsraelTime(row.endedAt)}`}</small>',
    marker: "Current 24h · ends",
  },
]);

console.log("[patch-ai-profit-floor] applied: +3% net floor after +6% trail arm; mirror follows source exits");
