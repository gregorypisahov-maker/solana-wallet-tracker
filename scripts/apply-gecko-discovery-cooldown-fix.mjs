import fs from "node:fs";

const path = "paper-trader/marketDiscoveryAgent.ts";
const marker = "GECKO_DISCOVERY_COOLDOWN_FIX_V1";
const source = fs.readFileSync(path, "utf8");

if (source.includes(marker)) {
  console.log("[gecko-discovery-patch] already applied");
  process.exit(0);
}

const importAnchor = 'import { GeckoCooldownError, geckoFetchJson } from "../lib/geckoFetch";';
const discoverAnchor = `async function discover(): Promise<DiscoveryResult> {\n  const now = Date.now();`;

if (!source.includes(importAnchor)) {
  throw new Error("gecko discovery patch: import anchor missing");
}
if (!source.includes(discoverAnchor)) {
  throw new Error("gecko discovery patch: discover anchor missing");
}

let next = source.replace(
  importAnchor,
  'import { GeckoCooldownError, geckoFetchJson, getGeckoCooldownRemainingMs } from "../lib/geckoFetch"; // ' + marker
);

next = next.replace(
  discoverAnchor,
  `async function discover(): Promise<DiscoveryResult> {\n  const now = Date.now();\n  const cooldownRemainingMs = getGeckoCooldownRemainingMs();\n  if (cooldownRemainingMs > 0) {\n    const cacheAge = lastGoodDiscovery ? now - lastGoodDiscovery.savedAt : Number.POSITIVE_INFINITY;\n    if (lastGoodDiscovery && cacheAge <= DISCOVERY_CACHE_MAX_STALE_MS) {\n      console.warn(\n        \`[market-discovery-ai] Gecko cooldown active remaining=\${cooldownRemainingMs}ms; \` +\n          \`served_from=cache age=\${cacheAge}ms stale=true\`\n      );\n      return {\n        candidates: lastGoodDiscovery.candidates.map((item) => ({ ...item })),\n        meta: { servedFrom: "cache", stale: true, cacheAgeMs: cacheAge, failedFeeds: 0 },\n      };\n    }\n\n    console.warn(\n      \`[market-discovery-ai] Gecko cooldown active remaining=\${cooldownRemainingMs}ms; scan skipped (no usable cache)\`\n    );\n    return {\n      candidates: [],\n      meta: { servedFrom: "cooldown_skip", stale: true, cacheAgeMs: null, failedFeeds: 0 },\n    };\n  }`
);

if (next === source) {
  throw new Error("gecko discovery patch: no write performed");
}

fs.writeFileSync(path, next);
const written = fs.readFileSync(path, "utf8");
if (
  !written.includes(marker) ||
  !written.includes("getGeckoCooldownRemainingMs") ||
  !written.includes('servedFrom: "cooldown_skip"')
) {
  throw new Error("gecko discovery patch: post-write verification failed");
}

console.log("[gecko-discovery-patch] applied and verified");
