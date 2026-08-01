import fs from "node:fs";

const path = "live-executor/liveSafety.ts";
const marker = "DEPLOYER_BLACKLIST_PATCH_V1";
if (!fs.existsSync(path)) throw new Error(`[deployer-blacklist-patch] missing ${path}`);
let source = fs.readFileSync(path, "utf8");
if (source.includes(marker)) {
  console.log("[deployer-blacklist-patch] already applied");
  process.exit(0);
}

const importAnchor = 'import { evaluateLiquiditySafety } from "./liquiditySafety";';
const finalAnchor = '    return { passed: true, reason: null, details };';
if (!source.includes(importAnchor)) throw new Error("[deployer-blacklist-patch] missing import anchor");
if (!source.includes(finalAnchor)) throw new Error("[deployer-blacklist-patch] missing final passed:true anchor");

source = source.replace(importAnchor, `${importAnchor}\nimport { DEPLOYER_BLACKLIST_VERSION, evaluateDeployerReputation } from "../lib/deployerReputation"; // ${marker}`);
source = source.replace(finalAnchor, `    const deployerBlacklistEnabled = process.env.LIVE_DEPLOYER_BLACKLIST_ENABLED !== "false";\n    if (deployerBlacklistEnabled) {\n      const minRugs = Math.max(1, Number(process.env.DEPLOYER_BLACKLIST_MIN_RUGS) || 1);\n      const enforce = process.env.LIVE_DEPLOYER_BLACKLIST_ENFORCE === "true";\n      const reputation = await evaluateDeployerReputation(input.mint);\n      const blacklisted = Boolean(reputation.deployer && reputation.rugs >= minRugs);\n      const action = blacklisted ? (enforce && !paperCall ? "block" : "shadow_would_block") : "clear";\n      const symbol = String(pair?.baseToken?.symbol ?? input.mint);\n      details.deployerReputation = { deployer: reputation.deployer, rugs: reputation.rugs, tokensSeen: reputation.tokensSeen, action, method: reputation.method, version: DEPLOYER_BLACKLIST_VERSION };\n      console.log(\`[deployer-blacklist] \${symbol} deployer=\${reputation.deployer ?? "unresolved"} rugs=\${reputation.rugs} action=\${action}\`);\n      if (action === "block") return reject("deployer_blacklisted", details);\n    }\n\n${finalAnchor}`);

fs.writeFileSync(path, source);
const verify = fs.readFileSync(path, "utf8");
if (!verify.includes(marker) || !verify.includes('return reject("deployer_blacklisted", details)')) throw new Error("[deployer-blacklist-patch] verification failed after write");
console.log("[deployer-blacklist-patch] applied and verified");
