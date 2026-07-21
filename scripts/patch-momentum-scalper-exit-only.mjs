import { readFileSync, writeFileSync } from 'node:fs';

const path = 'paper-trader/momentumScalper.ts';
const source = readFileSync(path, 'utf8');

const before = `export function startMomentumScalperScheduler(): void {
  if (!envEnabled("ENABLE_MOMENTUM_SCALPER", true)) {
    console.log("[momentum-scalper] disabled by ENABLE_MOMENTUM_SCALPER");
    return;
  }
  console.log(\`[momentum-scalper] \${STRATEGY_VERSION} paper-only strategy enabled; scan \${SCAN_INTERVAL_MS / 1000}s; position check \${POSITION_CHECK_INTERVAL_MS / 1000}s; size \${SCALP_RULES.fixedSizeSol.toFixed(2)} SOL\`);
  void scanSafely().catch((error) => console.error("[momentum-scalper] initial scan failed:", error));
  void checkPositionsSafely().catch((error) => console.error("[momentum-scalper] initial position check failed:", error));
  setInterval(() => void scanSafely().catch((error) => console.error("[momentum-scalper] scheduled scan failed:", error)), SCAN_INTERVAL_MS);
  setInterval(() => void checkPositionsSafely().catch((error) => console.error("[momentum-scalper] scheduled position check failed:", error)), POSITION_CHECK_INTERVAL_MS);
}`;

const after = `export function startMomentumScalperScheduler(): void {
  const entriesEnabled = envEnabled("ENABLE_MOMENTUM_SCALPER_ENTRIES", false);
  console.log(\`[momentum-scalper] \${STRATEGY_VERSION} exit manager active; new entries \${entriesEnabled ? "enabled" : "disabled"}; position check \${POSITION_CHECK_INTERVAL_MS / 1000}s\`);
  if (entriesEnabled) {
    void scanSafely().catch((error) => console.error("[momentum-scalper] initial scan failed:", error));
    setInterval(() => void scanSafely().catch((error) => console.error("[momentum-scalper] scheduled scan failed:", error)), SCAN_INTERVAL_MS);
  }
  void checkPositionsSafely().catch((error) => console.error("[momentum-scalper] initial position check failed:", error));
  setInterval(() => void checkPositionsSafely().catch((error) => console.error("[momentum-scalper] scheduled position check failed:", error)), POSITION_CHECK_INTERVAL_MS);
}`;

if (!source.includes(before)) {
  throw new Error('momentum scalper scheduler patch target not found');
}

writeFileSync(path, source.replace(before, after));
console.log('[startup-patch] Momentum Scalper entries are disabled by default; exit checks remain active.');
