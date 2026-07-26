import fs from "node:fs";

const path = "paper-trader/aiDiscoveryTrader.ts";
let text = fs.readFileSync(path, "utf8");
let changed = false;

if (!text.includes('from "./moonshotIntelligence"')) {
  const anchor = 'import { FetchPriority, fetchJsonQueued, getFetchQueueDepth } from "./fetchQueue";';
  if (text.includes(anchor)) {
    text = text.replace(anchor, `${anchor}\nimport { evaluateMoonshot, moonshotMode } from "./moonshotIntelligence";`);
    changed = true;
  } else {
    console.warn("[patch-moonshot-intelligence] import anchor missing; leaving import unchanged");
  }
}

if (!text.includes("[moonshot-shadow]")) {
  const pattern = /const pullbackPct = \(market\.priceUsd \/ peak - 1\) \* 100;\s*(?:await recordAiPositionSample\(position, market, peak\);\s*)?let reason: string \| null = null;\s*if \(grossPct <= HARD_STOP_PCT\) reason = "hard_stop";\s*else if \(grossPct >= TAKE_PROFIT_PCT\) reason = "take_profit";\s*else if \(peakPct >= TRAIL_ARM_PCT && pullbackPct <= -TRAIL_DISTANCE_PCT\) reason = "trailing_stop";\s*else if \(heldMs >= MAX_HOLD_MS\) reason = "max_hold";/;
  const match = text.match(pattern);
  if (match) {
    const sampleLine = match[0].includes("recordAiPositionSample")
      ? " await recordAiPositionSample(position, market, peak);"
      : "";
    const replacement = `const pullbackPct = (market.priceUsd / peak - 1) * 100;${sampleLine} const moonshot = evaluateMoonshot({ grossReturnPct: grossPct, peakReturnPct: peakPct, pullbackFromPeakPct: pullbackPct, heldMs, liquidityUsd: market.liquidityUsd }); let reason: string | null = null; if (grossPct <= HARD_STOP_PCT) reason = "hard_stop"; else if (moonshotMode() === "active" && moonshot.engaged) { if (moonshot.action === "exit") reason = moonshot.reason; } else if (grossPct >= TAKE_PROFIT_PCT) reason = "take_profit"; else if (peakPct >= TRAIL_ARM_PCT && pullbackPct <= -TRAIL_DISTANCE_PCT) reason = "trailing_stop"; else if (heldMs >= MAX_HOLD_MS) reason = "max_hold"; if (moonshotMode() === "shadow" && moonshot.engaged) console.log(\`[moonshot-shadow] \${position.token_symbol} action=\${moonshot.action} reason=\${moonshot.reason} gross=\${grossPct.toFixed(2)} peak=\${peakPct.toFixed(2)} pullback=\${pullbackPct.toFixed(2)}\`);`;
    text = text.replace(pattern, replacement);
    changed = true;
  } else {
    console.warn("[patch-moonshot-intelligence] exit anchor missing; leaving source unchanged");
  }
}

if (changed) fs.writeFileSync(path, text);
console.log(`[patch-moonshot-intelligence] ${changed ? "applied" : "already installed or safely skipped"}; mode=${process.env.MOONSHOT_INTELLIGENCE_MODE ?? "disabled"}`);
