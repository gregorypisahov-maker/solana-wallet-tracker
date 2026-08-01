import { spawnSync } from "node:child_process";

console.log("[onchain-rug-replay] automatic startup replay beginning");
const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "onchain-rug:replay"], {
  stdio: "inherit",
  env: process.env,
});

if (result.error) {
  console.error("[onchain-rug-replay] replay could not start:", result.error);
} else if (result.status === 0) {
  console.log("[onchain-rug-replay] GO result recorded; live gate remains disabled pending reviewed enablement");
} else {
  console.warn(`[onchain-rug-replay] NO-GO or incomplete result (exit=${result.status}); live gate remains disabled`);
}

process.exit(0);
