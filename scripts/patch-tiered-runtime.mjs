import { readFileSync, writeFileSync } from 'node:fs';

const path = 'paper-trader/tieredEntryShadow.ts';
let source = readFileSync(path, 'utf8');

// Backward-compatible safety patch: old deployments must never run the legacy
// entry scanner. The recent signal pump is the only tiered entry owner.
source = source
  .replace('  void evaluateNewSignals();\n', '')
  .replace('  setInterval(() => void evaluateNewSignals(), EVALUATION_INTERVAL_MS);\n', '');

writeFileSync(path, source);
console.log('[startup-patch] Tiered scheduler is position-only; confirmed recent signal pump exclusively owns entries.');
