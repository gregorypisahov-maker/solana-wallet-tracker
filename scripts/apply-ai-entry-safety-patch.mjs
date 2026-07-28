import fs from "node:fs";

const path = "paper-trader/aiDiscoveryTrader.ts";
let source = fs.readFileSync(path, "utf8");

if (source.includes('from "../lib/tokenSafety"')) {
  console.log("token safety entry patch already applied");
  process.exit(0);
}

function replaceOnce(anchor, replacement, label) {
  const first = source.indexOf(anchor);
  if (first < 0) throw new Error(`anchor_missing:${label}`);
  if (source.indexOf(anchor, first + anchor.length) >= 0) {
    throw new Error(`anchor_not_unique:${label}`);
  }
  source = source.replace(anchor, replacement);
}

replaceOnce(
  'import { PAPER_COST_MODEL } from "./executionCosts";\n',
  'import { PAPER_COST_MODEL } from "./executionCosts";\nimport { checkTokenSafety } from "../lib/tokenSafety";\n',
  "imports"
);

replaceOnce(
  'const VERSION = "ai_discovery_trader_v1_8_dex_rate_limit_2026_07_28";\n',
  'const VERSION = "ai_discovery_trader_v1_9_entry_safety_s2_s4_2026_07_28";\nconst ENTRY_SCREEN_ENABLED = process.env.AI_TOKEN_SAFETY_ENABLED !== "false";\n',
  "version"
);

replaceOnce(
  'async function paperEntryTokenAmount(\n',
  `async function logEntryScreenRejection(\n  opportunity,\n  result\n) {\n  const { error } = await supabase.from("ai_entry_screen_rejections").insert({\n    mint: opportunity.mint,\n    symbol: opportunity.token_symbol ?? null,\n    check_failed: result.checkFailed ?? "rpc_unknown",\n    observed_value: result.observedValue == null ? null : result.observedValue,\n    snapshot: result.snapshot,\n  });\n  if (error) throw new Error(\`entry_screen_rejection_log_failed:\${error.message}\`);\n  console.warn(\n    \`[ai-discovery-trader] entry rejected \${opportunity.token_symbol ?? opportunity.mint} \` +\n      \`check=\${result.checkFailed ?? "rpc_unknown"} observed=\${JSON.stringify(result.observedValue)}\`\n  );\n}\n\nasync function paperEntryTokenAmount(\n`,
  "entry-helper"
);

replaceOnce(
  '        const market = await priceFor(opportunity.mint, opportunity.pair_address);\n        if (!market || market.changeM5 < 0 || market.changeM5 > 15) continue;\n        await openTrade(state, opportunity, market, observationId);\n',
  `        const market = await priceFor(opportunity.mint, opportunity.pair_address);\n        if (!market || market.changeM5 < 0 || market.changeM5 > 15) continue;\n\n        if (ENTRY_SCREEN_ENABLED) {\n          const safety = await checkTokenSafety(opportunity.mint);\n          if (!safety.passed) {\n            await logEntryScreenRejection(opportunity, safety);\n            continue;\n          }\n          opportunity.entry_safety = safety.snapshot;\n        }\n\n        await openTrade(state, opportunity, market, observationId);\n`,
  "entry-callsite"
);

replaceOnce(
  '      `size ${FIXED_SIZE_SOL.toFixed(2)} SOL; score ${MIN_SCORE}+`\n',
  '      `size ${FIXED_SIZE_SOL.toFixed(2)} SOL; score ${MIN_SCORE}+; entrySafety=${ENTRY_SCREEN_ENABLED}`\n',
  "startup-log"
);

fs.writeFileSync(path, source);
console.log("token safety entry patch applied successfully");
