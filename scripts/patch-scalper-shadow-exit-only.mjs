import { readFileSync, writeFileSync } from "node:fs";

const path = "paper-trader/scalperShadow.ts";
let source = readFileSync(path, "utf8");
let changed = false;

function replaceIfPresent(before, after, label, installedMarker) {
  if (installedMarker && source.includes(installedMarker)) {
    console.log(`[startup-patch] Scalper Shadow ${label} already installed.`);
    return;
  }
  if (!source.includes(before)) {
    console.warn(`[startup-patch] Scalper Shadow ${label} target not found; leaving source unchanged.`);
    return;
  }
  source = source.replace(before, after);
  changed = true;
}

replaceIfPresent(
  'const strip = (v: unknown) => String(v ?? "").replace(/^solana_/, "");',
  `const strip = (v: unknown) => String(v ?? "").replace(/^solana_/, "");
const envEnabled = (name: string, fallback = false) => {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return !["0", "false", "no", "off"].includes(value);
};`,
  "entry flag",
  'envEnabled("ENABLE_SCALPER_SHADOW_ENTRIES"'
);

replaceIfPresent(
  `  try {
    const { enabled, rules } = await enabledContext();
    if (!enabled) { console.log("[scalper-shadow] idle: disabled"); return; }`,
  `  try {
    if (!envEnabled("ENABLE_SCALPER_SHADOW_ENTRIES", false)) return;
    const { enabled, rules } = await enabledContext();
    if (!enabled) { console.log("[scalper-shadow] idle: disabled"); return; }`,
  "scan gate",
  'if (!envEnabled("ENABLE_SCALPER_SHADOW_ENTRIES", false)) return;'
);

replaceIfPresent(
  `    const { enabled, rules } = await enabledContext();
    if (!enabled) { console.log("[scalper-shadow] idle: disabled"); return; }
    const { data: positions, error } = await supabase.from("scalper_shadow_positions").select("*");`,
  `    const { rules } = await enabledContext();
    const { data: positions, error } = await supabase.from("scalper_shadow_positions").select("*");`,
  "exit gate",
  'const { rules } = await enabledContext();\n    const { data: positions'
);

replaceIfPresent(
  `        const { enabled: stillEnabled } = await enabledContext();
        if (!stillEnabled) return;
        const pnl = n(p.size_sol) * net / 100;`,
  `        const pnl = n(p.size_sol) * net / 100;`,
  "close gate",
  null
);

replaceIfPresent(
  "[scalper-shadow] guarded scheduler loaded; database enabled flags control activity",
  "[scalper-shadow] exit manager active; new entries controlled by ENABLE_SCALPER_SHADOW_ENTRIES",
  "scheduler log",
  "[scalper-shadow] exit manager active; new entries controlled by ENABLE_SCALPER_SHADOW_ENTRIES"
);

if (changed) writeFileSync(path, source);
console.log(`[startup-patch] Scalper Shadow exit-only patch ${changed ? "updated" : "already safe"}; exit checks remain active.`);
