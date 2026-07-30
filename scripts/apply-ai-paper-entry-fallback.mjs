import fs from "node:fs";

const file = "paper-trader/aiDiscoveryTrader.ts";
let source = fs.readFileSync(file, "utf8");

const oldVersion = 'const VERSION = "ai_discovery_trader_v1_9_shared_entry_safety_2026_07_28";';
const newVersion = 'const VERSION = "ai_discovery_trader_v1_10_paper_snapshot_fallback_2026_07_30";';
if (source.includes(oldVersion)) source = source.replace(oldVersion, newVersion);

const oldBlock = `  const fallback = await pairFor(mint, pairAddress, 25_000);\n  if (fallback) console.log(\`[ai-discovery-trader] price \${mint} src=dex poolProgram=fallback\`);\n  return fallback;`;

const newBlock = `  const fallback = await pairFor(mint, pairAddress, 25_000);\n  if (fallback) {\n    console.log(\`[ai-discovery-trader] price \${mint} src=dex poolProgram=fallback\`);\n    return fallback;\n  }\n\n  const snapshotPriceUsd = n(opportunity.price_usd, Number.NaN);\n  const snapshotLiquidityUsd = n(opportunity.liquidity_usd, Number.NaN);\n  const snapshotChangeM5 = n(opportunity.price_change_m5, Number.NaN);\n  if (\n    Number.isFinite(snapshotPriceUsd) &&\n    snapshotPriceUsd > 0 &&\n    Number.isFinite(snapshotLiquidityUsd) &&\n    snapshotLiquidityUsd >= 25_000 &&\n    Number.isFinite(snapshotChangeM5)\n  ) {\n    console.warn(\n      \`[ai-discovery-trader] price \${mint} src=opportunity_snapshot ` +\n        \`liquidity=\${snapshotLiquidityUsd} changeM5=\${snapshotChangeM5}\`\n    );\n    return {\n      priceUsd: snapshotPriceUsd,\n      liquidityUsd: snapshotLiquidityUsd,\n      marketCapUsd: n(opportunity.market_cap_usd, 0),\n      changeM5: snapshotChangeM5,\n    };\n  }\n\n  console.warn(\n    \`[ai-discovery-trader] price unavailable \${opportunity.token_symbol ?? mint} ` +\n      \`snapshotPrice=\${snapshotPriceUsd} liquidity=\${snapshotLiquidityUsd} changeM5=\${snapshotChangeM5}\`\n  );\n  return null;`;

if (source.includes(oldBlock)) {
  source = source.replace(oldBlock, newBlock);
} else if (!source.includes("src=opportunity_snapshot")) {
  throw new Error("aiDiscoveryTrader price fallback target not found");
}

const oldGate = "        if (!market || market.changeM5 < 0 || market.changeM5 > 15) continue;";
const newGate = `        if (!market) {\n          console.warn(\`[ai-discovery-trader] candidate \${opportunity.token_symbol} skipped: market_unavailable\`);\n          continue;\n        }\n        if (market.changeM5 < 0 || market.changeM5 > 15) {\n          console.warn(\n            \`[ai-discovery-trader] candidate \${opportunity.token_symbol} skipped: momentum_gate changeM5=\${market.changeM5}\`\n          );\n          continue;\n        }`;
if (source.includes(oldGate)) source = source.replace(oldGate, newGate);

fs.writeFileSync(file, source);
console.log("[patch] AI paper entry snapshot fallback applied");
