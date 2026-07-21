import { readFileSync, writeFileSync } from 'node:fs';

const path = 'paper-trader/engine.ts';
const source = readFileSync(path, 'utf8');
const before = '  const today = new Date().toDateString();';
const after = "  const today = new Date().toISOString().slice(0, 10);";

if (source.includes(before)) {
  writeFileSync(path, source.replace(before, after));
  console.log('[startup-patch] Paper daily rollover now uses one UTC YYYY-MM-DD key.');
} else if (source.includes(after)) {
  console.log('[startup-patch] Paper daily rollover UTC key already installed.');
} else {
  throw new Error('paper daily rollover patch target not found');
}
