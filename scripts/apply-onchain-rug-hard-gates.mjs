import fs from "node:fs";

const path = "live-executor/liveSafety.ts";
const marker = "ONCHAIN_RUG_HARD_GATE_PATCH_V1";
const source = fs.readFileSync(path, "utf8");
if (source.includes(marker)) {
  console.log("[onchain-rug-patch] already applied");
  process.exit(0);
}

const importAnchor = 'import { evaluateLiquiditySafety } from "./liquiditySafety";';
const authorityAnchor = '    if (info.freezeAuthority) return reject("freeze_authority_active", details);';
const lpAnchor = '      const liquiditySafety = await evaluateLiquiditySafety({ mint: input.mint, pairAddress: pair?.pairAddress ?? null, dexId: pair?.dexId ?? null });';
if (!source.includes(importAnchor)) throw new Error("onchain rug patch: liquiditySafety import anchor missing");
if (!source.includes(authorityAnchor)) throw new Error("onchain rug patch: authority anchor missing");
if (!source.includes(lpAnchor)) throw new Error("onchain rug patch: LP anchor missing");

let next = source.replace(
  importAnchor,
  `${importAnchor}\nimport { resolveOnchainLpSafety, resolveTokenControls, ONCHAIN_RUG_SAFETY_VERSION } from "./onchainRugSafety"; // ${marker}`
);
next = next.replace(
  authorityAnchor,
  `${authorityAnchor}\n\n    const rugGateEnabled = process.env.LIVE_ONCHAIN_RUG_GATE_ENABLED !== "false";\n    const authorityEnforce = process.env.LIVE_TOKEN2022_AUTHORITY_ENFORCE !== "false";\n    if (rugGateEnabled) {\n      const tokenControls = await resolveTokenControls(input.mint);\n      details.tokenControls = { ...tokenControls, version: ONCHAIN_RUG_SAFETY_VERSION, enforced: authorityEnforce };\n      if (authorityEnforce && !tokenControls.safe) return reject(tokenControls.reason ?? "token_control_unsafe", details);\n    }`
);
next = next.replace(
  lpAnchor,
  `      const onchainLp = rugGateEnabled\n        ? await resolveOnchainLpSafety({ mint: input.mint, pool: String(pair?.pairAddress ?? ""), dexId: pair?.dexId ?? null })\n        : null;\n      details.onchainLp = onchainLp ? { ...onchainLp, version: ONCHAIN_RUG_SAFETY_VERSION } : null;\n      const fallbackLiquiditySafety = onchainLp && onchainLp.verdict !== "UNKNOWN"\n        ? null\n        : await evaluateLiquiditySafety({ mint: input.mint, pairAddress: pair?.pairAddress ?? null, dexId: pair?.dexId ?? null });\n      const liquiditySafety = onchainLp && onchainLp.verdict !== "UNKNOWN"\n        ? {\n            verdict: onchainLp.verdict === "UNLOCKED" ? "UNLOCKED" as const : "LOCKED" as const,\n            method: onchainLp.method,\n            pctLocked: onchainLp.pctSafe,\n            poolAddress: onchainLp.pool,\n            unlockTime: onchainLp.unlockAt,\n            rawError: null,\n            status: onchainLp.verdict.toLowerCase(),\n            removablePct: onchainLp.pctSafe == null ? null : Math.max(0, 100 - onchainLp.pctSafe),\n            owner: null,\n            source: "onchain",\n            reason: onchainLp.verdict === "UNLOCKED" ? "liquidity_unlocked" : null,\n            details: onchainLp.details,\n          }\n        : fallbackLiquiditySafety!;`
);

if (next === source) throw new Error("onchain rug patch: no write performed");
fs.writeFileSync(path, next);
const written = fs.readFileSync(path, "utf8");
if (!written.includes(marker) || !written.includes("resolveOnchainLpSafety") || !written.includes("resolveTokenControls")) {
  throw new Error("onchain rug patch: post-write verification failed");
}
console.log("[onchain-rug-patch] applied and verified");
