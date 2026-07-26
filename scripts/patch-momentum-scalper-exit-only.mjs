import { readFileSync, writeFileSync } from "node:fs";

const path = "paper-trader/momentumScalper.ts";
const source = readFileSync(path, "utf8");
const marker = 'envEnabled("ENABLE_MOMENTUM_SCALPER_ENTRIES", false)';

if (source.includes(marker)) {
  console.log("[startup-patch] Momentum Scalper exit-only patch already installed; exit checks remain active.");
  process.exit(0);
}

const functionStart = "export function startMomentumScalperScheduler(): void {";
const startIndex = source.indexOf(functionStart);

if (startIndex < 0) {
  console.warn("[startup-patch] Momentum Scalper scheduler not found; skipping obsolete exit-only patch without stopping the worker.");
  process.exit(0);
}

let depth = 0;
let functionEnd = -1;
let seenOpeningBrace = false;

for (let index = startIndex; index < source.length; index += 1) {
  const character = source[index];
  if (character === "{") {
    depth += 1;
    seenOpeningBrace = true;
  } else if (character === "}") {
    depth -= 1;
    if (seenOpeningBrace && depth === 0) {
      functionEnd = index + 1;
      break;
    }
  }
}

if (functionEnd < 0) {
  console.warn("[startup-patch] Momentum Scalper scheduler boundary could not be resolved; skipping patch without stopping the worker.");
  process.exit(0);
}

const replacement = `export function startMomentumScalperScheduler(): void {
  const entriesEnabled = envEnabled("ENABLE_MOMENTUM_SCALPER_ENTRIES", false);
  console.log(\`[momentum-scalper] \${STRATEGY_VERSION} exit manager active; new entries \${entriesEnabled ? "enabled" : "disabled"}; position check \${POSITION_CHECK_INTERVAL_MS / 1000}s\`);
  if (entriesEnabled) {
    void scanSafely().catch((error) => console.error("[momentum-scalper] initial scan failed:", error));
    setInterval(() => void scanSafely().catch((error) => console.error("[momentum-scalper] scheduled scan failed:", error)), SCAN_INTERVAL_MS);
  }
  void checkPositionsSafely().catch((error) => console.error("[momentum-scalper] initial position check failed:", error));
  setInterval(() => void checkPositionsSafely().catch((error) => console.error("[momentum-scalper] scheduled position check failed:", error)), POSITION_CHECK_INTERVAL_MS);
}`;

const updated = source.slice(0, startIndex) + replacement + source.slice(functionEnd);
writeFileSync(path, updated);
console.log("[startup-patch] Momentum Scalper entries are disabled by default; exit checks remain active.");
