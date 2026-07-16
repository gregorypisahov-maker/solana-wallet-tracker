import fs from "node:fs";

const path = "worker/monitor.ts";
let source = fs.readFileSync(path, "utf8");

const marker = "const candidateReviewState = new Map<string, CandidateReviewState>();";
if (source.includes(marker)) {
  console.log("[patch] consensus cooldown already applied");
  process.exit(0);
}

function replaceOnce(search, replacement, label) {
  if (!source.includes(search)) {
    throw new Error(`[patch] could not find ${label}`);
  }
  source = source.replace(search, replacement);
}

replaceOnce(
  "const MIN_TOTAL_SOL = 1;\n",
  `const MIN_TOTAL_SOL = 1;\n\ninterface CandidateReviewState {\n  lastBuyMs: number;\n  nextReviewAtMs: number;\n}\n\n// Prevent the same unchanged rejected token from being rescored every refresh.\n// A genuinely newer wallet buy bypasses the cooldown immediately.\nconst candidateReviewState = new Map<string, CandidateReviewState>();\nconst LOW_LIQUIDITY_REVIEW_MS = 60_000;\nconst LOW_SCORE_REVIEW_MS = 120_000;\nconst DUMP_REVIEW_MS = 300_000;\nconst MARKET_DATA_RETRY_MS = 60_000;\n`,
  "candidate cooldown state insertion point"
);

replaceOnce(
  `  const candidates = Array.from(byToken.entries()).filter(\n    ([tokenMint, agg]) =>\n      agg.wallets.size >= MIN_WALLETS_FOR_ALERT &&\n      agg.totalSol >= MIN_TOTAL_SOL &&\n      agg.last >= freshSignalCutoff &&\n      !recentlyAlertedMints.has(tokenMint)\n  );\n\n  console.log(\n    \`[consensus] \${byToken.size} tokens in window; \` +\n      \`\${candidates.length} new raw candidates\`\n  );`,
  `  const nowMs = Date.now();\n  const candidates = Array.from(byToken.entries()).filter(\n    ([tokenMint, agg]) => {\n      if (\n        agg.wallets.size < MIN_WALLETS_FOR_ALERT ||\n        agg.totalSol < MIN_TOTAL_SOL ||\n        agg.last < freshSignalCutoff ||\n        recentlyAlertedMints.has(tokenMint)\n      ) {\n        return false;\n      }\n\n      const previous = candidateReviewState.get(tokenMint);\n      const lastBuyMs = agg.last.getTime();\n      return !previous || lastBuyMs > previous.lastBuyMs || nowMs >= previous.nextReviewAtMs;\n    }\n  );\n\n  // Keep long-running worker memory bounded as old signal windows expire.\n  for (const [mint, state] of candidateReviewState) {\n    if (nowMs - state.lastBuyMs > SIGNAL_MAX_AGE_MS + DUMP_REVIEW_MS) {\n      candidateReviewState.delete(mint);\n    }\n  }\n\n  console.log(\n    \`[consensus] \${byToken.size} tokens in window; \` +\n      \`\${candidates.length} actionable candidates\`\n  );`,
  "candidate selection block"
);

replaceOnce(
  `    if (!market) {\n      continue;\n    }`,
  `    if (!market) {\n      candidateReviewState.set(tokenMint, {\n        lastBuyMs: agg.last.getTime(),\n        nextReviewAtMs: Date.now() + MARKET_DATA_RETRY_MS,\n      });\n      continue;\n    }`,
  "market-data failure cooldown"
);

replaceOnce(
  `    if (!passesAlertFilter) {\n      continue;\n    }`,
  `    if (!passesAlertFilter) {\n      const reviewDelayMs = dumpDetected\n        ? DUMP_REVIEW_MS\n        : liquidity < MIN_LIQUIDITY_USD\n          ? LOW_LIQUIDITY_REVIEW_MS\n          : score < MIN_SCORE_FOR_ALERT\n            ? LOW_SCORE_REVIEW_MS\n            : LOW_LIQUIDITY_REVIEW_MS;\n\n      candidateReviewState.set(tokenMint, {\n        lastBuyMs: agg.last.getTime(),\n        nextReviewAtMs: Date.now() + reviewDelayMs,\n      });\n      continue;\n    }`,
  "rejection cooldown"
);

fs.writeFileSync(path, source);
console.log("[patch] consensus candidate cooldown applied");
