import fs from "node:fs";

const path = "single-bot/marketBot.ts";
let source = fs.readFileSync(path, "utf8");

function replaceOnce(before, after, label) {
  if (source.includes(after)) return;
  if (!source.includes(before)) throw new Error(`[paper-spot-valuation] missing ${label}`);
  source = source.replace(before, after);
}

function replaceBlock(start, end, replacement, label) {
  if (source.includes(replacement)) return;
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`[paper-spot-valuation] missing ${label}`);
  source = source.slice(0, a) + replacement + source.slice(b);
}

replaceOnce(
  'const COOLDOWN_MINUTES = positiveInt("MARKET_REENTRY_COOLDOWN_MINUTES", 120);',
  `const COOLDOWN_MINUTES = positiveInt("MARKET_REENTRY_COOLDOWN_MINUTES", 120);
const PAPER_ROUND_TRIP_COST_PCT = positiveNumber("MARKET_PAPER_ROUND_TRIP_COST_PCT", 1.5);
const PAPER_MAX_QUOTE_ABOVE_SPOT_PCT = positiveNumber("MARKET_PAPER_MAX_QUOTE_ABOVE_SPOT_PCT", 0.5);`,
  "paper valuation constants",
);

const executableReplacement = `function paperSpotValue(position: Position, price: number): number {
  const decimals = Math.max(0, Math.min(18, Number(position.tokenDecimals ?? 0)));
  const raw = Number(position.tokenAmountRaw);
  if (!Number.isFinite(raw) || raw < 0 || !Number.isFinite(price) || price <= 0) {
    throw new Error("paper_spot_value_invalid");
  }
  const tokensHeld = raw / (10 ** decimals);
  const grossSpotUsdc = tokensHeld * price;
  const costMultiplier = Math.max(0, 1 - PAPER_ROUND_TRIP_COST_PCT / 100);
  const netSpotUsdc = grossSpotUsdc * costMultiplier;
  if (!Number.isFinite(netSpotUsdc) || netSpotUsdc < 0) throw new Error("paper_spot_value_invalid");
  return netSpotUsdc;
}

async function executableExitValue(position: Position, price: number): Promise<number> {
  if (MODE !== "paper") return position.sizeUsdc * (price / position.entryPriceUsd);

  const grossSpotUsdc = paperSpotValue(position, price) / Math.max(0.000001, 1 - PAPER_ROUND_TRIP_COST_PCT / 100);
  const netSpotUsdc = paperSpotValue(position, price);
  const quote = await getQuote(position.mint, USDC_MINT, position.tokenAmountRaw);
  const quotedUsdc = usdcFromRaw(quote.outAmount);
  if (!Number.isFinite(quotedUsdc) || quotedUsdc < 0) throw new Error("paper_exit_quote_invalid");

  const quoteAboveSpotPct = grossSpotUsdc > 0 ? ((quotedUsdc / grossSpotUsdc) - 1) * 100 : 0;
  if (quoteAboveSpotPct > PAPER_MAX_QUOTE_ABOVE_SPOT_PCT) {
    console.warn(
      \`[single-market-bot] paper quote above spot ignored mint=\${position.mint} quote=\${quotedUsdc.toFixed(6)} grossSpot=\${grossSpotUsdc.toFixed(6)} above=\${quoteAboveSpotPct.toFixed(3)}%\`,
    );
  }

  // Paper accounting is always based on independently priced spot value, net of
  // the configured round-trip cost. A Jupiter quote may be lower, but can never
  // increase the booked paper value above spot.
  return Math.min(quotedUsdc, netSpotUsdc);
}

`;
replaceBlock(
  "async function executableExitValue(position: Position, price: number): Promise<number> {",
  "async function closePosition(",
  executableReplacement,
  "executableExitValue",
);

replaceOnce(
  "  let exitUsdc = quotedExitUsdc ?? position.sizeUsdc * (price / position.entryPriceUsd);",
  `  let exitUsdc = quotedExitUsdc ?? position.sizeUsdc * (price / position.entryPriceUsd);
  if (MODE === "paper") {
    const spotCappedExitUsdc = paperSpotValue(position, price);
    exitUsdc = Math.min(exitUsdc, spotCappedExitUsdc);
  }`,
  "close-position paper clamp",
);

replaceOnce(
  'const STRATEGY_VERSION = "market_timing_v3_2026_08_03";',
  'const STRATEGY_VERSION = "market_timing_v3_spot_valuation_2026_08_04";',
  "strategy version",
);

fs.writeFileSync(path, source);
console.log("[patch-single-market-bot-paper-spot-valuation] applied");
