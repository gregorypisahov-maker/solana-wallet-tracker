import fs from "node:fs";

const target = new URL("../paper-trader/aiDiscoveryTrader.ts", import.meta.url);
let source = fs.readFileSync(target, "utf8");

const replaceRegex = (pattern, replacement, label) => {
  if (source.includes(replacement)) return;
  if (!pattern.test(source)) {
    console.warn(`[runtime-patch] sniper anchor already transformed or unavailable: ${label}`);
    return;
  }
  source = source.replace(pattern, replacement);
};

replaceRegex(
  /const VERSION = "[^"]+";/,
  'const VERSION = "ai_memecoin_sniper_v1_hard_gates_2026_08_02";',
  "version"
);
replaceRegex(/const MIN_SCORE = \d+;/, 'const MIN_SCORE = 86;', "minimum score");
replaceRegex(
  /const MAX_OPPORTUNITY_AGE_MS = [^;]+;/,
  'const MAX_OPPORTUNITY_AGE_MS = 90_000;',
  "opportunity age"
);
replaceRegex(/const COOLDOWN_MS = [^;]+;/, 'const COOLDOWN_MS = 30 * 60_000;', "cooldown");
replaceRegex(/const HARD_STOP_PCT = [^;]+;/, 'const HARD_STOP_PCT = -3.5;', "hard stop");
replaceRegex(/const TAKE_PROFIT_PCT = [^;]+;/, 'const TAKE_PROFIT_PCT = 6;', "take profit");
replaceRegex(/const TRAIL_ARM_PCT = [^;]+;/, 'const TRAIL_ARM_PCT = 2.5;', "trail arm");
replaceRegex(/const TRAIL_DISTANCE_PCT = [^;]+;/, 'const TRAIL_DISTANCE_PCT = 1.5;', "trail distance");
replaceRegex(/const MAX_HOLD_MS = [^;]+;/, 'const MAX_HOLD_MS = 12 * 60_000;', "max hold");

if (!source.includes("async function passesDeployerGate(")) {
  const anchor = "async function openTrade(\n";
  if (source.includes(anchor)) {
    const helper = `async function passesDeployerGate(mint: string): Promise<{ passed: boolean; reason: string; deployer: string | null }> {\n  const { data: mapping, error: mappingError } = await supabase\n    .from("deployer_by_mint")\n    .select("deployer,resolved_at")\n    .eq("mint", mint)\n    .maybeSingle();\n  if (mappingError) throw new Error(mappingError.message);\n  const deployer = mapping?.deployer ? String(mapping.deployer) : null;\n  if (!deployer) return { passed: false, reason: "deployer_unresolved", deployer: null };\n\n  const { data: reputation, error: reputationError } = await supabase\n    .from("deployer_reputation")\n    .select("rugs,tokens_seen,last_rug_at")\n    .eq("deployer", deployer)\n    .maybeSingle();\n  if (reputationError) throw new Error(reputationError.message);\n  if (Number(reputation?.rugs ?? 0) > 0) {\n    return { passed: false, reason: "deployer_prior_rug", deployer };\n  }\n  return { passed: true, reason: "deployer_clean", deployer };\n}\n\nasync function openTrade(\n`;
    source = source.replace(anchor, helper);
  } else {
    console.warn("[runtime-patch] sniper anchor already transformed or unavailable: deployer helper");
  }
}

if (!source.includes("const heliusWouldBlock = safety.details?.heliusWouldBlock === true;")) {
  const safetyPattern = /          opportunity\.entry_safety = \{ passed: safety\.passed, reason: safety\.reason, \.\.\.safety\.details \};\n          if \(!safety\.passed && PAPER_ENTRY_SAFETY_ENFORCE\) \{[^\n]+\n/;
  const safetyReplacement = `          opportunity.entry_safety = { passed: safety.passed, reason: safety.reason, ...safety.details };\n          const heliusWouldBlock = safety.details?.heliusWouldBlock === true;\n          const lpAction = String((safety.details?.lp_lock as any)?.action ?? "");\n          if (!safety.passed || heliusWouldBlock || lpAction === "block" || lpAction === "shadow_would_block") {\n            const reason = safety.reason ?? (heliusWouldBlock ? "helius_not_trade_eligible" : "liquidity_not_proven_safe");\n            console.warn(\`[ai-discovery-trader] sniper hard-block \${opportunity.token_symbol ?? opportunity.mint}: \${reason}\`);\n            continue;\n          }\n\n          const deployerGate = await passesDeployerGate(opportunity.mint);\n          opportunity.deployer_gate = deployerGate;\n          if (!deployerGate.passed) {\n            console.warn(\`[ai-discovery-trader] sniper hard-block \${opportunity.token_symbol ?? opportunity.mint}: \${deployerGate.reason}\`);\n            continue;\n          }\n\n          await sleep(1_500);\n          const confirmation = await evaluateLiveEntrySafety({ mint: opportunity.mint, sizeSol: FIXED_SIZE_SOL, slippageBps: QUOTE_SLIPPAGE_BPS, mode: "paper" });\n          const confirmationHeliusBlock = confirmation.details?.heliusWouldBlock === true;\n          const confirmationLpAction = String((confirmation.details?.lp_lock as any)?.action ?? "");\n          if (!confirmation.passed || confirmationHeliusBlock || confirmationLpAction === "block" || confirmationLpAction === "shadow_would_block") {\n            console.warn(\`[ai-discovery-trader] sniper confirmation failed \${opportunity.token_symbol ?? opportunity.mint}: \${confirmation.reason ?? "unstable_safety_state"}\`);\n            continue;\n          }\n`;
  if (safetyPattern.test(source)) source = source.replace(safetyPattern, safetyReplacement);
  else console.warn("[runtime-patch] sniper anchor already transformed or unavailable: hard safety gate");
}

source = source.replace(
  /    60_000\n  \);\n  setInterval\(\n    \(\) =>\n      void managePositions\(\)/,
  '    15_000\n  );\n  setInterval(\n    () =>\n      void managePositions()'
);
source = source.replace(
  /    10_000\n  \);\n  setInterval\(\n    \(\) =>\n      void trackCandidateOutcomes\(\)/,
  '    2_000\n  );\n  setInterval(\n    () =>\n      void trackCandidateOutcomes()'
);

fs.writeFileSync(target, source);
console.log("[runtime-patch] memecoin sniper hard gates applied and verified");
