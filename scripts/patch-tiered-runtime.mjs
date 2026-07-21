import { readFileSync, writeFileSync } from 'node:fs';

const path = 'paper-trader/tieredEntryShadow.ts';
let source = readFileSync(path, 'utf8');

source = source
  .replace('else if (trust < 65) skipReasons.push("entry_wallet_trust_below_65");', 'else if (trust < 55) skipReasons.push("entry_wallet_trust_below_55");')
  .replace('  void evaluateNewSignals();\n', '')
  .replace('  setInterval(() => void evaluateNewSignals(), EVALUATION_INTERVAL_MS);\n', '');

writeFileSync(path, source);
console.log('[startup-patch] Tiered legacy scheduler is position-only; recent signal pump owns entries and retries.');
