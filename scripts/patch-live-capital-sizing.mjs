import { readFileSync, writeFileSync } from "node:fs";

const path = "live-executor/liveExecutor.ts";
let source = readFileSync(path, "utf8");
const marker = "LIVE_POSITION_SIZE_SOL";

if (source.includes(marker)) {
  console.log("[patch-live-capital-sizing] already installed");
  process.exit(0);
}

const anchor = "const SOURCE_ENTRY_MAX_AGE_MS = Math.max(15_000, Number(process.env.LIVE_SOURCE_ENTRY_MAX_AGE_MS) || 45_000);";
if (!source.includes(anchor)) {
  console.warn("[patch-live-capital-sizing] sizing constant anchor missing; leaving source unchanged");
  process.exit(0);
}
source = source.replace(
  anchor,
  `${anchor}\nconst LIVE_POSITION_SIZE_SOL = Math.max(0.01, Number(process.env.LIVE_POSITION_SIZE_SOL) || 1.0);`
);

const oldSizing = "requested_size_sol: Math.min(n(source.size_sol), n(state.max_position_sol)),";
const newSizing = "requested_size_sol: Math.min(LIVE_POSITION_SIZE_SOL, n(state.max_position_sol)),";
if (!source.includes(oldSizing)) {
  console.warn("[patch-live-capital-sizing] signal sizing anchor missing; leaving source unchanged");
  process.exit(0);
}
source = source.replace(oldSizing, newSizing);
writeFileSync(path, source);
console.log(`[patch-live-capital-sizing] installed; requested live size=${process.env.LIVE_POSITION_SIZE_SOL ?? "1.0"} SOL`);
