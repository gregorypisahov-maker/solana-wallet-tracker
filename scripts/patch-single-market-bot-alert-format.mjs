import fs from "node:fs";

const path = "single-bot/marketBot.ts";
let source = fs.readFileSync(path, "utf8");

const oldOpenVariants = [
  '  await telegram(`🟢 MARKET BOT ${MODE.toUpperCase()} TRADE OPENED\\n${candidate.symbol}\\nScore: ${candidate.score}\\nSize: ${TRADE_SIZE_USDC} USDC\\nPrice: $${candidate.price}\\nReasons: ${candidate.reasons.join(", ")}\\nTx: ${entryTx ?? "paper"}`);',
  '  await telegram(`🟢 Market bot ${MODE.toUpperCase()} entry\\n${candidate.symbol}\\nScore: ${candidate.score}\\nSize: ${TRADE_SIZE_USDC} USDC\\nPrice: $${candidate.price}\\nReasons: ${candidate.reasons.join(", ")}\\nTx: ${entryTx ?? "paper"}`);',
];

const newOpen = `  const targetPrice = candidate.price * (1 + TAKE_PROFIT_PCT / 100);\n  const stopPrice = candidate.price * (1 - STOP_LOSS_PCT / 100);\n  const targetProfitUsdc = TRADE_SIZE_USDC * TAKE_PROFIT_PCT / 100;\n  const stopLossUsdc = TRADE_SIZE_USDC * STOP_LOSS_PCT / 100;\n  const cashAfterEntry = MODE === "paper" ? n(state.cash_usdc) - TRADE_SIZE_USDC : n(state.cash_usdc);\n  await telegram([\n    \`🟢 MARKET BOT \\${MODE.toUpperCase()} TRADE OPENED\`,\n    "",\n    \`Token: \\${candidate.symbol} (\\${candidate.name})\`,\n    \`Amount used: \\${TRADE_SIZE_USDC.toFixed(2)} USDC\`,\n    \`Buy price: $\\${candidate.price.toFixed(4)}\`,\n    "",\n    \`🎯 Profit target: $\\${targetPrice.toFixed(4)} (+\\${TAKE_PROFIT_PCT.toFixed(1)}%)\`,\n    \`Possible profit: +\\${targetProfitUsdc.toFixed(2)} USDC\`,\n    \`🛑 Stop price: $\\${stopPrice.toFixed(4)} (-\\${STOP_LOSS_PCT.toFixed(1)}%)\`,\n    \`Maximum planned loss: -\\${stopLossUsdc.toFixed(2)} USDC\`,\n    \`⏱ Maximum hold: \\${MAX_HOLD_MINUTES} minutes\`,\n    "",\n    \`Score: \\${candidate.score}/100\`,\n    \`Why selected: \\${candidate.reasons.join(", ")}\`,\n    MODE === "paper" ? \`Paper cash left: \\${cashAfterEntry.toFixed(2)} USDC\` : \`Transaction: \\${entryTx ?? "pending"}\`,\n    MODE === "paper" ? "PAPER MODE — no real money was used." : "LIVE MODE — real money was used.",\n  ].join("\\n"));`;

let openPatched = false;
for (const oldOpen of oldOpenVariants) {
  if (source.includes(oldOpen)) {
    source = source.replace(oldOpen, newOpen);
    openPatched = true;
    break;
  }
}
if (!openPatched && !source.includes("Possible profit:")) {
  throw new Error("market bot open-alert anchor not found");
}

const helperAnchor = "async function closePosition(position: Position, price: number, reason: string): Promise<void> {";
const helper = `function humanExitReason(reason: string): string {\n  const labels: Record<string, string> = {\n    take_profit: "Profit target reached",\n    hard_stop: "Stop loss reached",\n    trailing_stop: "Trailing stop protected the gain",\n    max_hold: "Maximum holding time reached",\n  };\n  return labels[reason] ?? reason.replace(/_/g, " ");\n}\n\n`;
if (!source.includes("function humanExitReason(")) {
  if (!source.includes(helperAnchor)) throw new Error("market bot close-position anchor not found");
  source = source.replace(helperAnchor, `${helper}${helperAnchor}`);
}

const oldCloseVariants = [
  '  await telegram(`${pnl >= 0 ? "🟢" : "🔴"} MARKET BOT ${MODE.toUpperCase()} TRADE CLOSED\\n${position.symbol}\\nReason: ${reason}\\nPnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(3)} USDC (${pnlPct.toFixed(2)}%)\\nTx: ${exitTx ?? "paper"}`);',
  '  await telegram(`${pnl >= 0 ? "🟢" : "🔴"} Market bot ${MODE.toUpperCase()} exit\\n${position.symbol}\\nReason: ${reason}\\nPnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(3)} USDC (${pnlPct.toFixed(2)}%)\\nTx: ${exitTx ?? "paper"}`);',
];

const newClose = `  const heldMinutes = Math.max(0, (Date.now() - Date.parse(position.openedAt)) / 60_000);\n  const balanceAfterExit = MODE === "paper" ? n(state.cash_usdc) + exitUsdc : n(state.cash_usdc);\n  await telegram([\n    \`\\${pnl >= 0 ? "🟢" : "🔴"} MARKET BOT \\${MODE.toUpperCase()} TRADE CLOSED — \\${pnl >= 0 ? "PROFIT" : "LOSS"}\`,\n    "",\n    \`Token: \\${position.symbol} (\\${position.name})\`,\n    \`Why closed: \\${humanExitReason(reason)}\`,\n    \`Buy price: $\\${position.entryPriceUsd.toFixed(4)}\`,\n    \`Sell price: $\\${price.toFixed(4)}\`,\n    \`Time held: \\${heldMinutes.toFixed(0)} minutes\`,\n    "",\n    \`Result: \\${pnl >= 0 ? "+" : ""}\\${pnl.toFixed(3)} USDC (\\${pnlPct >= 0 ? "+" : ""}\\${pnlPct.toFixed(2)}%)\`,\n    MODE === "paper" ? \`Paper balance: \\${balanceAfterExit.toFixed(2)} USDC\` : \`Transaction: \\${exitTx ?? "pending"}\`,\n    MODE === "paper" ? "PAPER MODE — no real money was used." : "LIVE MODE — real money was used.",\n  ].join("\\n"));`;

let closePatched = false;
for (const oldClose of oldCloseVariants) {
  if (source.includes(oldClose)) {
    source = source.replace(oldClose, newClose);
    closePatched = true;
    break;
  }
}
if (!closePatched && !source.includes("Why closed:")) {
  throw new Error("market bot close-alert anchor not found");
}

fs.writeFileSync(path, source);
console.log("[patch-single-market-bot-alert-format] applied");
