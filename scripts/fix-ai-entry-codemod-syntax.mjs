import fs from "node:fs";

const path = "scripts/apply-ai-entry-feature-snapshot.mjs";
let source = fs.readFileSync(path, "utf8");

function replaceRequired(before, after, label) {
  if (!source.includes(before)) throw new Error(`missing ${label}`);
  source = source.replace(before, after);
}

replaceRequired(
  '/type Candidate = \\{[\\s\\S]*?\\n\\};\\n\\ntype Ranked = \\{[\\s\\S]*?\\n\\};\\n\\ntype DiscoveryMeta/',
  '/type Candidate = \\{[\\s\\S]*?\\n\\};\\n\\ntype Ranked = Candidate & \\{[\\s\\S]*?\\n\\};\\n\\ntype DiscoveryMeta/',
  "candidate type matcher"
);
replaceRequired(
  '      `[ai-discovery-trader] entry feature join failed entry_id=${entryId} observation_id=${id}`,',
  '      "[ai-discovery-trader] entry feature join failed entry_id=" + entryId + " observation_id=" + id,',
  "join error log"
);
replaceRequired(
  '  const positionId = `ai_${randomUUID()}`;',
  '  const positionId = "ai_" + randomUUID();',
  "position id"
);
replaceRequired(
  '    `[ai-discovery-trader] features ${opportunity.token_symbol ?? opportunity.mint} ` +',
  '    "[ai-discovery-trader] features " + (opportunity.token_symbol ?? opportunity.mint) + " " +',
  "feature log prefix"
);
replaceRequired(
  '      `score=${entryFeatures.discovery_score ?? "null"} ` +',
  '      "score=" + (entryFeatures.discovery_score ?? "null") + " " +',
  "feature score log"
);
replaceRequired(
  '      `liq=${entryFeatures.liquidity_usd ?? "null"} ` +',
  '      "liq=" + (entryFeatures.liquidity_usd ?? "null") + " " +',
  "feature liquidity log"
);
replaceRequired(
  '      `age=${entryFeatures.token_age_sec ?? "null"}s ` +',
  '      "age=" + (entryFeatures.token_age_sec ?? "null") + "s " +',
  "feature age log"
);
replaceRequired(
  '      `holders=${entryFeatures.holder_count ?? "null"} ` +',
  '      "holders=" + (entryFeatures.holder_count ?? "null") + " " +',
  "feature holders log"
);
replaceRequired(
  '      `vol5m=${entryFeatures.vol_5m ?? "null"} ` +',
  '      "vol5m=" + (entryFeatures.vol_5m ?? "null") + " " +',
  "feature volume log"
);
replaceRequired(
  '      `captured=${entryFeatures.capture.nonnull}/${entryFeatures.capture.total}`',
  '      "captured=" + entryFeatures.capture.nonnull + "/" + entryFeatures.capture.total',
  "feature capture log"
);
replaceRequired(
  '      `Token: <b>${opportunity.token_symbol}</b>`,',
  '      "Token: <b>" + opportunity.token_symbol + "</b>",',
  "telegram token"
);
replaceRequired(
  '      `Score: <b>${opportunity.score}/100</b>`,',
  '      "Score: <b>" + opportunity.score + "/100</b>",',
  "telegram score"
);
replaceRequired(
  '      `Size: <b>${sizeSol.toFixed(3)} SOL</b>`,',
  '      "Size: <b>" + sizeSol.toFixed(3) + " SOL</b>",',
  "telegram size"
);
replaceRequired(
  '      `Liquidity: <b>$${Math.round(market.liquidityUsd).toLocaleString()}</b>`,',
  '      "Liquidity: <b>$" + Math.round(market.liquidityUsd).toLocaleString() + "</b>",',
  "telegram liquidity"
);
replaceRequired(
  '      `Reasons: ${(opportunity.reasons ?? []).slice(0, 3).join(", ")}`,',
  '      "Reasons: " + (opportunity.reasons ?? []).slice(0, 3).join(", "),',
  "telegram reasons"
);
replaceRequired(
  '      `<a href="https://dexscreener.com/solana/${opportunity.pair_address}">Open chart</a>`,',
  '      "<a href=\\"https://dexscreener.com/solana/" + opportunity.pair_address + "\\">Open chart</a>",',
  "telegram chart"
);
replaceRequired(
  '    ].join("\\n")',
  '    ].join("\\\\n")',
  "telegram newline escape"
);

fs.writeFileSync(path, source);
console.log("Entry feature codemod syntax fixed.");
