import fs from "node:fs";

const path = "single-bot/marketBot.ts";
const source = fs.readFileSync(path, "utf8");
const before = 'const ENABLED = process.env.MARKET_BOT_ENABLED === "true";';
const after = 'const ENABLED = process.env.MARKET_BOT_ENABLED !== "false";';
if (!source.includes(before) && !source.includes(after)) {
  throw new Error("market bot enabled anchor not found");
}
if (source.includes(before)) fs.writeFileSync(path, source.replace(before, after));
console.log("[patch-market-bot-paper-default] applied");
