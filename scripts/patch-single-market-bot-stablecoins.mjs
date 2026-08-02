import fs from "node:fs";

const path = "single-bot/marketBot.ts";
let source = fs.readFileSync(path, "utf8");
const before = 'const stableSymbols = new Set(["USDC", "USDT", "USDG", "PYUSD", "USDS", "DAI", "SOL", "WSOL"]);';
const after = 'const stableSymbols = new Set(["USDC", "USDT", "USDG", "PYUSD", "USDS", "DAI", "USD1", "USDY", "USDE", "FDUSD", "EURC", "USDP", "TUSD", "GUSD", "SOL", "WSOL"]);';

if (source.includes(before)) {
  source = source.replace(before, after);
  fs.writeFileSync(path, source);
  console.log("[patch-single-market-bot-stablecoins] applied");
} else if (source.includes(after)) {
  console.log("[patch-single-market-bot-stablecoins] already applied");
} else {
  throw new Error("[patch-single-market-bot-stablecoins] expected anchor missing");
}
