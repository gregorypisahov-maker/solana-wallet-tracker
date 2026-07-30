import fs from "node:fs";
import path from "node:path";

const file = path.resolve(process.cwd(), "paper-trader/aiDiscoveryTrader.ts");
let source = fs.readFileSync(file, "utf8");
const marker = "ai_discovery_helius_shadow_outcomes_v11_2026_07_30";

if (source.includes(marker)) {
  console.log("[patch-ai-helius-shadow-outcomes] already applied");
  process.exit(0);
}

function replaceOnce(from, to, label) {
  if (!source.includes(from)) {
    throw new Error(`[patch-ai-helius-shadow-outcomes] missing anchor: ${label}`);
  }
  source = source.replace(from, to);
}

replaceOnce(
  "  const snapshot = {\n    version: VERSION,",
  [
    "  const snapshot = {",
    "    version: VERSION,",
    `    runtimePatch: "${marker}",`,
    "    heliusEligible: (opportunity.entry_safety as any)?.heliusEligible ?? null,",
    "    heliusRecommendation: (opportunity.entry_safety as any)?.heliusRecommendation ?? null,",
    "    heliusSignalVersion: (opportunity.entry_safety as any)?.heliusSignalVersion ?? null,",
    "    heliusWouldBlock: Boolean((opportunity.entry_safety as any)?.heliusWouldBlock),",
  ].join("\n"),
  "entry snapshot Helius shadow fields"
);

replaceOnce(
  "async function trackCandidateOutcomes(): Promise<void> {\n  if (outcomeRunning) return;",
  [
    "async function trackCandidateOutcomes(): Promise<void> {",
    `  // ${marker}: the dedicated v11 tracker owns all horizon writes.`,
    "  // Keep the old scheduler harmless until this legacy function is deleted from source.",
    "  return;",
    "  if (outcomeRunning) return;",
  ].join("\n"),
  "legacy outcome tracker disable"
);

fs.writeFileSync(file, source);
console.log(
  "[patch-ai-helius-shadow-outcomes] applied: Helius eligibility is recorded in entry snapshots and legacy horizon writes are disabled"
);
