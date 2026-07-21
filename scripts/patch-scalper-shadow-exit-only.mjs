import { readFileSync, writeFileSync } from 'node:fs';

const path = 'paper-trader/scalperShadow.ts';
let source = readFileSync(path, 'utf8');

function replaceExact(before, after, label) {
  if (!source.includes(before)) throw new Error(`${label} patch target not found`);
  source = source.replace(before, after);
}

replaceExact(
  'const strip = (v: unknown) => String(v ?? "").replace(/^solana_/, "");',
  `const strip = (v: unknown) => String(v ?? "").replace(/^solana_/, "");
const envEnabled = (name: string, fallback = false) => {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return !["0", "false", "no", "off"].includes(value);
};`,
  'entry flag'
);

replaceExact(
  `  try {
    const { enabled, rules } = await enabledContext();
    if (!enabled) { console.log("[scalper-shadow] idle: disabled"); return; }`,
  `  try {
    if (!envEnabled("ENABLE_SCALPER_SHADOW_ENTRIES", false)) return;
    const { enabled, rules } = await enabledContext();
    if (!enabled) { console.log("[scalper-shadow] idle: disabled"); return; }`,
  'scan gate'
);

replaceExact(
  `    const { enabled, rules } = await enabledContext();
    if (!enabled) { console.log("[scalper-shadow] idle: disabled"); return; }
    const { data: positions, error } = await supabase.from("scalper_shadow_positions").select("*");`,
  `    const { rules } = await enabledContext();
    const { data: positions, error } = await supabase.from("scalper_shadow_positions").select("*");`,
  'exit gate'
);

replaceExact(
  `        const { enabled: stillEnabled } = await enabledContext();
        if (!stillEnabled) return;
        const pnl = n(p.size_sol) * net / 100;`,
  `        const pnl = n(p.size_sol) * net / 100;`,
  'close gate'
);

replaceExact(
  '[scalper-shadow] guarded scheduler loaded; database enabled flags control activity',
  '[scalper-shadow] exit manager active; new entries controlled by ENABLE_SCALPER_SHADOW_ENTRIES',
  'scheduler log'
);

writeFileSync(path, source);
console.log('[startup-patch] Scalper Shadow entries are disabled by default; exit checks remain active.');
