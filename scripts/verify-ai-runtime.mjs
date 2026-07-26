import fs from "node:fs";

const checks = [
  {
    path: "worker/workerEntrypoint.ts",
    required: [
      'import { startAiDiscoveryTrader } from "../paper-trader/aiDiscoveryTrader";',
      'import { startAiCapitalMirror } from "../paper-trader/aiCapitalMirror";',
      "startAiDiscoveryTrader();",
      "startAiCapitalMirror();",
    ],
  },
  {
    path: "paper-trader/aiDiscoveryTrader.ts",
    required: [
      "const FIXED_SIZE_SOL = 0.2;",
      "const MIN_SCORE = 82;",
      "const HARD_STOP_PCT = -6;",
      "const TAKE_PROFIT_PCT = 10;",
      "const TRAIL_ARM_PCT = 6;",
      "const TRAIL_DISTANCE_PCT = 4;",
      "const MAX_HOLD_MS = 45 * 60_000;",
      "peakPct >= TRAIL_ARM_PCT && pullbackPct <= -TRAIL_DISTANCE_PCT",
      "startAiDiscoveryTrader",
    ],
  },
  {
    path: "paper-trader/aiCapitalMirror.ts",
    required: [
      "const FIXED_SIZE_SOL = 1;",
      "startAiCapitalMirror",
      'from("ai_discovery_positions")',
      'from("ai_discovery_trades")',
    ],
  },
];

const failures = [];
for (const check of checks) {
  if (!fs.existsSync(check.path)) {
    failures.push(`${check.path}: file missing`);
    continue;
  }
  const text = fs.readFileSync(check.path, "utf8");
  for (const marker of check.required) {
    if (!text.includes(marker)) failures.push(`${check.path}: missing ${marker}`);
  }
}

if (failures.length) {
  console.error("[verify-ai-runtime] REQUIRED AI RUNTIME CHECKS FAILED");
  for (const failure of failures) console.error(`[verify-ai-runtime] ${failure}`);
  process.exit(1);
}

console.log("[verify-ai-runtime] required AI runtime markers verified; strategy constants unchanged");
