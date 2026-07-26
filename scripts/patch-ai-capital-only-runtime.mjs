import fs from "node:fs";

function update(path, transform) {
  const before = fs.readFileSync(path, "utf8");
  const after = transform(before);
  if (after === before) {
    console.log(`[capital-only] ${path} already patched or no matching change needed`);
    return;
  }
  fs.writeFileSync(path, after);
  console.log(`[capital-only] updated ${path}`);
}

update("paper-trader/marketDiscoveryAgent.ts", (text) => {
  text = text.replace(
    'const VERSION = "market_discovery_ai_v1_2026_07_26_dex_only";',
    'const VERSION = "market_discovery_ai_v1_2026_07_26_dex_batch";'
  );

  const oldBlock = `  const pairResults = await Promise.allSettled(
    mints.map((mint) => fetchJson(\`https://api.dexscreener.com/token-pairs/v1/solana/\${encodeURIComponent(mint)}\`, 30_000))
  );
  const byMint = new Map<string, Candidate>();

  pairResults.forEach((result, index) => {
    if (result.status === "rejected") {
      console.warn(\`[market-discovery-ai] token lookup skipped for \${mints[index]}:\`, result.reason);
      return;
    }
    const pairs = Array.isArray(result.value) ? result.value : Array.isArray(result.value?.pairs) ? result.value.pairs : [];
    for (const pair of pairs) {
      const candidate = parseDexPair(pair, mints[index]);
      if (!candidate) continue;
      const existing = byMint.get(candidate.mint);
      if (!existing || candidate.liquidityUsd > existing.liquidityUsd) byMint.set(candidate.mint, candidate);
    }
  });`;

  const newBlock = `  const requestedMints = new Set(mints);
  const batchUrl = \`https://api.dexscreener.com/tokens/v1/solana/\${mints.map(encodeURIComponent).join(",")}\`;
  const payload = await fetchJson(batchUrl, 30_000);
  const pairs = Array.isArray(payload) ? payload : Array.isArray(payload?.pairs) ? payload.pairs : [];
  const byMint = new Map<string, Candidate>();

  for (const pair of pairs) {
    const baseMint = String(pair?.baseToken?.address ?? "");
    const quoteMint = String(pair?.quoteToken?.address ?? "");
    const requestedMint = requestedMints.has(baseMint) ? baseMint : requestedMints.has(quoteMint) ? quoteMint : "";
    if (!requestedMint) continue;
    const candidate = parseDexPair(pair, requestedMint);
    if (!candidate) continue;
    const existing = byMint.get(candidate.mint);
    if (!existing || candidate.liquidityUsd > existing.liquidityUsd) byMint.set(candidate.mint, candidate);
  }`;

  if (text.includes(oldBlock)) text = text.replace(oldBlock, newBlock);
  return text;
});

update("paper-trader/aiDiscoveryTrader.ts", (text) => {
  text = text.replace('import { sendTelegramAlert } from "../lib/telegram";\n', "");
  if (!text.includes("async function sendTelegramAlert(_message: string)")) {
    text = text.replace(
      'const OUTCOME_QUEUE_MAX_BACKLOG = Math.max(1, Number(process.env.OUTCOME_TRACKING_QUEUE_MAX_BACKLOG) || 20);',
      'const OUTCOME_QUEUE_MAX_BACKLOG = Math.max(1, Number(process.env.OUTCOME_TRACKING_QUEUE_MAX_BACKLOG) || 20);\nasync function sendTelegramAlert(_message: string): Promise<void> { /* silent source controller */ }'
    );
  }

  text = text.replace(
    /export function startAiDiscoveryTrader\(\): void \{[^\n]*\}/,
    'export function startAiDiscoveryTrader(): void { if (!enabled()) { console.log("[ai-source-controller] disabled by ENABLE_AI_DISCOVERY_TRADER"); return; } console.log(`[ai-source-controller] ${VERSION} enabled internally; drives AI Capital only; source alerts and outcome tracking disabled; score ${MIN_SCORE}+`); void scanEntries().catch((error) => console.error("[ai-source-controller] initial scan failed", error)); void managePositions().catch((error) => console.error("[ai-source-controller] initial position check failed", error)); setInterval(() => void scanEntries().catch((error) => console.error("[ai-source-controller] scan failed", error)), 60_000); setInterval(() => void managePositions().catch((error) => console.error("[ai-source-controller] position check failed", error)), 10_000); }'
  );
  return text;
});

update("worker/workerEntrypoint.ts", (text) => text.replace(
  '[worker] AI-only mode enabled; legacy wallet and trading engines are disabled',
  '[worker] AI Capital-only mode enabled; discovery and silent source controller support the 1 SOL capital bot'
));

console.log("[capital-only] active: batched Dexscreener discovery, silent source controller, AI Capital is the only user-facing trading bot");
