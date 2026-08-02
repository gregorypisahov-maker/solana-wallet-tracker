import fs from "node:fs";

const path = "single-bot/marketBot.ts";
let source = fs.readFileSync(path, "utf8");

const storeImport = 'import { getMarketStore } from "./marketStore";';
const telegramImport = 'import { sendTelegramAlert } from "../lib/telegram";';
if (!source.includes(telegramImport)) {
  if (!source.includes(storeImport)) throw new Error("market store import anchor not found");
  source = source.replace(storeImport, `${storeImport}\n${telegramImport}`);
}

const functionStart = source.indexOf("async function telegram(text: string): Promise<void> {");
const functionEndAnchor = "\n\ntype Position = {";
if (functionStart >= 0) {
  const functionEnd = source.indexOf(functionEndAnchor, functionStart);
  if (functionEnd < 0) throw new Error("telegram function end anchor not found");
  source = `${source.slice(0, functionStart)}async function telegram(text: string): Promise<void> {\n  await sendTelegramAlert(text);\n}${source.slice(functionEnd)}`;
} else if (!source.includes("await sendTelegramAlert(text);")) {
  throw new Error("telegram function anchor not found");
}

source = source.replace(
  "Market bot ${MODE.toUpperCase()} entry",
  "MARKET BOT ${MODE.toUpperCase()} TRADE OPENED"
);
source = source.replace(
  "Market bot ${MODE.toUpperCase()} exit",
  "MARKET BOT ${MODE.toUpperCase()} TRADE CLOSED"
);

fs.writeFileSync(path, source);
console.log("[patch-single-market-bot-telegram] applied");
