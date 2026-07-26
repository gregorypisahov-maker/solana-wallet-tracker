import fs from "node:fs";

const path = "paper-trader/aiDiscoveryTrader.ts";
let text = fs.readFileSync(path, "utf8");
let changed = false;

if (!text.includes('from "./moonshotIntelligence"')) {
  const anchor = 'import { FetchPriority, fetchJsonQueued, getFetchQueueDepth } from "./fetchQueue";';
  if (!text.includes(anchor)) throw new Error("moonshot import anchor missing");
  text = text.replace(anchor, `${anchor}\nimport { evaluateMoonshot, moonshotMode } from "./moonshotIntelligence";`);
  changed = true;
}

const oldBlock = 'const pullbackPct = (market.priceUsd / peak - 1) * 100; let reason: string | null = null; if (grossPct <= HARD_STOP_PCT) reason = "hard_stop"; else if (grossPct >= TAKE_PROFIT_PCT) reason = "take_profit"; else if (peakPct >= TRAIL_ARM_PCT && pullbackPct <= -TRAIL_DISTANCE_PCT) reason = "trailing_stop"; else if (heldMs >= MAX_HOLD_MS) reason = "max_hold";';
const newBlock = 'const pullbackPct = (market.priceUsd / peak - 1) * 100; const moonshot = evaluateMoonshot({ grossReturnPct: grossPct, peakReturnPct: peakPct, pullbackFromPeakPct: pullbackPct, heldMs, liquidityUsd: market.liquidityUsd }); let reason: string | null = null; if (grossPct <= HARD_STOP_PCT) reason = "hard_stop"; else if (moonshotMode() === "active" && moonshot.engaged) { if (moonshot.action === "exit") reason = moonshot.reason; } else if (grossPct >= TAKE_PROFIT_PCT) reason = "take_profit"; else if (peakPct >= TRAIL_ARM_PCT && pullbackPct <= -TRAIL_DISTANCE_PCT) reason = "trailing_stop"; else if (heldMs >= MAX_HOLD_MS) reason = "max_hold"; if (moonshotMode() === "shadow" && moonshot.engaged) console.log(`[moonshot-shadow] ${position.token_symbol} action=${moonshot.action} reason=${moonshot.reason} gross=${grossPct.toFixed(2)} peak=${peakPct.toFixed(2)} pullback=${pullbackPct.toFixed(2)}`);';

if (!text.includes("[moonshot-shadow]")) {
  if (!text.includes(oldBlock)) throw new Error("moonshot exit anchor missing");
  text = text.replace(oldBlock, newBlock);
  changed = true;
}

if (changed) fs.writeFileSync(path, text);
console.log(`[patch-moonshot-intelligence] ${changed ? "applied" : "already installed"}; mode=${process.env.MOONSHOT_INTELLIGENCE_MODE ?? "disabled"}`);
