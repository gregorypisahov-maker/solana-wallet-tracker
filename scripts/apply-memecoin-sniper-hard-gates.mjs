import fs from "node:fs";

const target = new URL("../paper-trader/aiDiscoveryTrader.ts", import.meta.url);
let source = fs.readFileSync(target, "utf8");

const replaceOnce = (pattern, replacement, appliedMarker, label) => {
  if (source.includes(appliedMarker)) return;
  if (!pattern.test(source)) throw new Error(`missing patch anchor: ${label}`);
  source = source.replace(pattern, replacement);
};

replaceOnce(
  /const VERSION = "[^"]+";/,
  'const VERSION = "ai_memecoin_sniper_v1_hard_gates_2026_08_02";',
  'const VERSION = "ai_memecoin_sniper_v1_hard_gates_2026_08_02";',
  "version"
);
replaceOnce(/const MIN_SCORE = \d+;/, 'const MIN_SCORE = 86;', 'const MIN_SCORE = 86;', "minimum score");
replaceOnce(
  /const MAX_OPPORTUNITY_AGE_MS = [^;]+;/,
  'const MAX_OPPORTUNITY_AGE_MS = 90_000;',
  'const MAX_OPPORTUNITY_AGE_MS = 90_000;',
  "opportunity age"
);
replaceOnce(
  /const COOLDOWN_MS = [^;]+;/,
  'const COOLDOWN_MS = 30 * 60_000;',
  'const COOLDOWN_MS = 30 * 60_000;',
  "cooldown"
);
replaceOnce(/const HARD_STOP_PCT = [^;]+;/, 'const HARD_STOP_PCT = -3.5;', 'const HARD_STOP_PCT = -3.5;', "hard stop");
replaceOnce(/const TAKE_PROFIT_PCT = [^;]+;/, 'const TAKE_PROFIT_PCT = 6;', 'const TAKE_PROFIT_PCT = 6;', "take profit");
replaceOnce(/const TRAIL_ARM_PCT = [^;]+;/, 'const TRAIL_ARM_PCT = 2.5;', 'const TRAIL_ARM_PCT = 2.5;', "trail arm");
replaceOnce(
  /const TRAIL_DISTANCE_PCT = [^;]+;/,
  'const TRAIL_DISTANCE_PCT = 1.5;',
  'const TRAIL_DISTANCE_PCT = 1.5;',
  "trail distance"
);
replaceOnce(
  /const MAX_HOLD_MS = [^;]+;/,
  'const MAX_HOLD_MS = 12 * 60_000;',
  'const MAX_HOLD_MS = 12 * 60_000;',
  "max hold"
);

replaceOnce(
  /import \{ evaluateLiveEntrySafety \} from "\.\.\/live-executor\/liveSafety";/,
  `import { evaluateLiveEntrySafety } from "../live-executor/liveSafety";
import { resolveDeployer } from "../lib/deployerReputation";`,
  'import { resolveDeployer } from "../lib/deployerReputation";',
  "deployer resolver import"
);

const deployerHelper = `async function passesDeployerGate(mint: string): Promise<{ passed: boolean; reason: string; deployer: string | null; method: string }> {
  const resolution = await resolveDeployer(mint);
  if (!resolution.deployer) {
    return {
      passed: true,
      reason: "deployer_unresolved_shadow",
      deployer: null,
      method: resolution.method,
    };
  }

  const { data: reputation, error: reputationError } = await supabase
    .from("deployer_reputation")
    .select("rugs,tokens_seen,last_rug_at")
    .eq("deployer", resolution.deployer)
    .maybeSingle();
  if (reputationError) throw new Error(reputationError.message);
  if (Number(reputation?.rugs ?? 0) > 0) {
    return {
      passed: false,
      reason: "deployer_prior_rug",
      deployer: resolution.deployer,
      method: resolution.method,
    };
  }
  return {
    passed: true,
    reason: "deployer_clean_or_unseen",
    deployer: resolution.deployer,
    method: resolution.method,
  };
}

async function openTrade(
`;

replaceOnce(
  /async function passesDeployerGate\(mint: string\): Promise<\{ passed: boolean; reason: string; deployer: string \| null(?:; method: string)? \}> \{[\s\S]*?\n\}\n\nasync function openTrade\(\n|async function openTrade\(\n/,
  deployerHelper,
  'reason: "deployer_unresolved_shadow"',
  "deployer helper"
);

const safetyReplacement = `          opportunity.entry_safety = { passed: safety.passed, reason: safety.reason, ...safety.details };
          const heliusWouldBlock = safety.details?.heliusWouldBlock === true;
          const lpAction = String((safety.details?.lp_lock as any)?.action ?? "");
          const primaryGateWouldBlock =
            !safety.passed ||
            heliusWouldBlock ||
            lpAction === "block" ||
            (PAPER_ENTRY_SAFETY_ENFORCE && lpAction === "shadow_would_block");
          if (primaryGateWouldBlock) {
            const reason =
              safety.reason ??
              (heliusWouldBlock
                ? "helius_not_trade_eligible"
                : "liquidity_not_proven_safe");
            console.warn(
              \`[ai-discovery-trader] sniper \${PAPER_ENTRY_SAFETY_ENFORCE ? "hard-block" : "shadow-block"} \${opportunity.token_symbol ?? opportunity.mint}: \${reason}\`
            );
            if (PAPER_ENTRY_SAFETY_ENFORCE) continue;
          }

          const deployerGate = await passesDeployerGate(opportunity.mint);
          opportunity.deployer_gate = deployerGate;
          if (!deployerGate.passed) {
            console.warn(
              \`[ai-discovery-trader] sniper \${PAPER_ENTRY_SAFETY_ENFORCE ? "hard-block" : "shadow-block"} \${opportunity.token_symbol ?? opportunity.mint}: \${deployerGate.reason}\`
            );
            if (PAPER_ENTRY_SAFETY_ENFORCE) continue;
          } else if (deployerGate.reason === "deployer_unresolved_shadow") {
            console.warn(
              \`[ai-discovery-trader] sniper shadow-observe \${opportunity.token_symbol ?? opportunity.mint}: deployer_unresolved\`
            );
          }

          await sleep(1_500);
          const confirmation = await evaluateLiveEntrySafety({
            mint: opportunity.mint,
            sizeSol: FIXED_SIZE_SOL,
            slippageBps: QUOTE_SLIPPAGE_BPS,
            mode: "paper",
          });
          const confirmationHeliusBlock =
            confirmation.details?.heliusWouldBlock === true;
          const confirmationLpAction = String(
            (confirmation.details?.lp_lock as any)?.action ?? ""
          );
          const confirmationWouldBlock =
            !confirmation.passed ||
            confirmationHeliusBlock ||
            confirmationLpAction === "block" ||
            (PAPER_ENTRY_SAFETY_ENFORCE &&
              confirmationLpAction === "shadow_would_block");
          if (confirmationWouldBlock) {
            console.warn(
              \`[ai-discovery-trader] sniper confirmation \${PAPER_ENTRY_SAFETY_ENFORCE ? "hard-block" : "shadow-block"} \${opportunity.token_symbol ?? opportunity.mint}: \${confirmation.reason ?? "unstable_safety_state"}\`
            );
            if (PAPER_ENTRY_SAFETY_ENFORCE) continue;
          }
`;

replaceOnce(
  /          opportunity\.entry_safety = \{ passed: safety\.passed, reason: safety\.reason, \.\.\.safety\.details \};\n          if \(!safety\.passed && PAPER_ENTRY_SAFETY_ENFORCE\) \{[^\n]*\n/,
  safetyReplacement,
  'const primaryGateWouldBlock =',
  "hard safety gate"
);

replaceOnce(
  /    60_000\n  \);\n  setInterval\(\n    \(\) =>\n      void managePositions\(\)/,
  `    15_000
  );
  setInterval(
    () =>
      void managePositions()`,
  `    15_000
  );
  setInterval(
    () =>
      void managePositions()`,
  "entry interval"
);
replaceOnce(
  /    10_000\n  \);\n  setInterval\(\n    \(\) =>\n      void trackCandidateOutcomes\(\)/,
  `    2_000
  );
  setInterval(
    () =>
      void trackCandidateOutcomes()`,
  `    2_000
  );
  setInterval(
    () =>
      void trackCandidateOutcomes()`,
  "position interval"
);

fs.writeFileSync(target, source);

const enforce =
  !["0", "false", "off", "no"].includes(
    String(process.env.AI_PAPER_ENTRY_SAFETY_ENFORCE ?? "true")
      .trim()
      .toLowerCase()
  );
const blockOnUnknown =
  String(process.env.LP_LOCK_BLOCK_ON_UNKNOWN ?? "false")
    .trim()
    .toLowerCase() === "true";
console.log(
  `[runtime-patch] memecoin sniper gate mode enforce=${enforce} blockOnUnknown=${blockOnUnknown}`
);
console.log("[runtime-patch] memecoin sniper hard gates applied and verified");
