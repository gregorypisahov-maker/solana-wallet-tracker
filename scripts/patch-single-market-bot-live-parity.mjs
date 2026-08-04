import fs from "node:fs";

const path = "single-bot/marketBot.ts";
let source = fs.readFileSync(path, "utf8");

function replaceOnce(anchor, replacement, label) {
  if (source.includes(replacement)) return;
  if (!source.includes(anchor)) throw new Error(`[live-parity-patch] missing anchor: ${label}`);
  source = source.replace(anchor, replacement);
}

replaceOnce(
  'function confidenceSizing(candidate: Candidate, state: any) {',
  'async function confidenceSizing(candidate: Candidate, state: any) {',
  "async confidence sizing",
);

replaceOnce(
  '  const requested = MODE === "paper" && exceptional ? MAX_CONFIDENCE_MULTIPLIER : MODE === "paper" && strong ? 2 : 1;\n  const tier = exceptional ? "exceptional" : strong ? "strong" : "normal";\n  const cash = Math.max(0, n(state.cash_usdc));\n  const size = Math.min(TRADE_SIZE_USDC * requested, cash * MAX_POSITION_PCT / 100, cash);\n  return { tradeSizeUsdc: size, requestedMultiplier: requested, actualMultiplier: size / TRADE_SIZE_USDC, confidenceTier: tier };',
  `  const requested = exceptional ? MAX_CONFIDENCE_MULTIPLIER : strong ? 2 : 1;
  const tier = exceptional ? "exceptional" : strong ? "strong" : "normal";
  const paperCash = Math.max(0, n(state.cash_usdc));
  const liveBalance = MODE === "live" ? usdcFromRaw((await getTokenBalanceRaw(USDC_MINT)).amountRaw) : paperCash;
  const cash = MODE === "live" ? liveBalance : paperCash;
  const referenceCash = Math.max(1, paperCash);
  const proportionalBase = MODE === "live" ? TRADE_SIZE_USDC * (cash / referenceCash) : TRADE_SIZE_USDC;
  const config = MODE === "live" ? await loadLiveConfig() : null;
  const reserve = MODE === "live" ? Math.max(0, n(config?.minimum_wallet_reserve_usd)) : 0;
  const spendable = Math.max(0, cash - reserve);
  const databaseCap = MODE === "live" ? Math.max(0, n(config?.max_position_usd)) : Number.POSITIVE_INFINITY;
  const size = Math.min(proportionalBase * requested, cash * MAX_POSITION_PCT / 100, spendable, databaseCap);
  return {
    tradeSizeUsdc: size,
    requestedMultiplier: requested,
    actualMultiplier: proportionalBase > 0 ? size / proportionalBase : 0,
    confidenceTier: tier,
    proportionalBaseUsdc: proportionalBase,
    referencePaperCashUsdc: referenceCash,
    executionCashUsdc: cash,
  };`,
  "same confidence sizing in live",
);

replaceOnce(
  '  const sizing = confidenceSizing(candidate, state);',
  '  const sizing = await confidenceSizing(candidate, state);',
  "await confidence sizing",
);

replaceOnce(
  '  if (tradeSizeUsdc < Math.min(10, TRADE_SIZE_USDC)) throw new Error("insufficient_paper_cash_for_position");',
  '  if (tradeSizeUsdc <= 0) throw new Error(MODE === "live" ? "insufficient_live_spendable_balance" : "insufficient_paper_cash_for_position");',
  "mode-correct minimum size",
);

replaceOnce(
  'async function executableExitValue(position: Position, price: number): Promise<number> {\n  if (MODE !== "paper") return position.sizeUsdc * (price / position.entryPriceUsd);\n  const quote = await getQuote(position.mint, USDC_MINT, position.tokenAmountRaw);',
  'async function executableExitValue(position: Position, _price: number): Promise<number> {\n  const quote = await getQuote(position.mint, USDC_MINT, position.tokenAmountRaw);',
  "quote-based exit parity",
);

fs.writeFileSync(path, source);
console.log("[live-parity-patch] applied");
