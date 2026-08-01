import fs from "node:fs";
import path from "node:path";

const target = path.resolve(process.cwd(), "worker/telegramBot.ts");
if (!fs.existsSync(target)) {
  console.log("[patch-telegram-sol-spot] target missing; skipped");
  process.exit(0);
}

let source = fs.readFileSync(target, "utf8");
const replacements = [
  [
    '    "/binancestats — BTCUSDT futures paper bot",',
    '    "/binancestats — SOL/USDT spot + legacy BTC paper",',
  ],
  [
    '[{ text: "📉 Binance Paper", callback_data: "/binancestats" }],',
    '[{ text: "🟣 SOL + Binance", callback_data: "/binancestats" }],',
  ],
];

let changed = false;
for (const [before, after] of replacements) {
  if (source.includes(after)) continue;
  if (!source.includes(before)) throw new Error(`[patch-telegram-sol-spot] anchor missing: ${before}`);
  source = source.replace(before, after);
  changed = true;
}

if (changed) {
  fs.writeFileSync(target, source);
  console.log("[patch-telegram-sol-spot] applied");
} else {
  console.log("[patch-telegram-sol-spot] already applied");
}
