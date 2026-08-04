import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const buildRoot = path.join(root, ".single-market-live-build");
rmSync(buildRoot, { recursive: true, force: true });
mkdirSync(buildRoot, { recursive: true });

for (const dir of ["single-bot", "lib", "scripts"]) {
  cpSync(path.join(root, dir), path.join(buildRoot, dir), { recursive: true });
}
for (const file of ["package.json", "tsconfig.json"]) {
  if (existsSync(path.join(root, file))) cpSync(path.join(root, file), path.join(buildRoot, file));
}
symlinkSync(path.join(root, "node_modules"), path.join(buildRoot, "node_modules"), "dir");

const patches = [
  "patch-market-bot-paper-default.mjs",
  "patch-single-market-bot-keyless.mjs",
  "patch-single-market-bot-store.mjs",
  "patch-single-market-bot-stablecoins.mjs",
  "patch-single-market-bot-telegram.mjs",
  "patch-single-market-bot-v3-core.mjs",
  "patch-single-market-bot-token2022-safety.mjs",
  "patch-single-market-bot-v3-dashboard.mjs",
  "patch-single-market-bot-v3-normalized-stats.mjs",
  "patch-single-market-bot-v3-mobile-dashboard.mjs",
  "patch-single-market-bot-continuous-paper.mjs",
  "patch-separate-single-market-live.mjs",
];

for (const patch of patches) {
  const result = spawnSync(process.execPath, [path.join(buildRoot, "scripts", patch)], {
    cwd: buildRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const tsx = path.join(root, "node_modules", ".bin", "tsx");
const run = spawnSync(tsx, [path.join(buildRoot, "single-bot", "marketBot.ts")], {
  cwd: buildRoot,
  stdio: "inherit",
  env: { ...process.env, MARKET_BOT_MODE: "live" },
});
process.exit(run.status ?? 1);
