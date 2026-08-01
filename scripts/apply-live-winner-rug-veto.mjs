import fs from "node:fs";

const MARKER = "LIVE_WINNER_RUG_VETO_V1";
const safetyPath = "live-executor/liveSafety.ts";
const executorPath = "live-executor/liveExecutor.ts";
const onchainPath = "live-executor/onchainRugSafety.ts";

function read(path) {
  if (!fs.existsSync(path)) throw new Error(`[live-winner-rug-veto] missing ${path}`);
  return fs.readFileSync(path, "utf8");
}

function replaceOnce(source, anchor, replacement, label) {
  if (!source.includes(anchor)) {
    throw new Error(`[live-winner-rug-veto] patch anchor not found: ${label}`);
  }
  return source.replace(anchor, replacement);
}

let onchain = read(onchainPath);
if (!onchain.includes(MARKER)) {
  const pumpConstant = 'const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";';
  onchain = replaceOnce(
    onchain,
    pumpConstant,
    `${pumpConstant}\nconst PUMP_AMM_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"; // ${MARKER}\nconst WSOL_MINT = "So11111111111111111111111111111111111111112";`,
    "PumpSwap constants"
  );

  const classificationAnchor =
    '  if ((dex === "pumpfun" || dex === "pump.fun") && poolProgram === PUMP_PROGRAM) { verdict = "CURVE"; method = "pump_bonding_curve_program_owner"; }\n  else {';
  const classificationReplacement = `  const pumpProgramKey = new PublicKey(PUMP_PROGRAM);\n  const pumpAmmProgramKey = new PublicKey(PUMP_AMM_PROGRAM);\n  const mintKey = new PublicKey(input.mint);\n  const quoteMintKey = new PublicKey(WSOL_MINT);\n  const [pumpPoolAuthority] = PublicKey.findProgramAddressSync(\n    [Buffer.from("pool-authority"), mintKey.toBuffer()],\n    pumpProgramKey\n  );\n  const canonicalIndex = Buffer.alloc(2);\n  canonicalIndex.writeUInt16LE(0, 0);\n  const [canonicalPumpSwapPool] = PublicKey.findProgramAddressSync(\n    [\n      Buffer.from("pool"),\n      canonicalIndex,\n      pumpPoolAuthority.toBuffer(),\n      mintKey.toBuffer(),\n      quoteMintKey.toBuffer(),\n    ],\n    pumpAmmProgramKey\n  );\n  Object.assign(details, {\n    canonicalPumpSwapPool: canonicalPumpSwapPool.toBase58(),\n    pumpPoolAuthority: pumpPoolAuthority.toBase58(),\n    canonicalPumpSwapMatched: poolKey.equals(canonicalPumpSwapPool),\n  });\n\n  if ((dex === "pumpfun" || dex === "pump.fun") && poolProgram === PUMP_PROGRAM) { verdict = "CURVE"; method = "pump_bonding_curve_program_owner"; }\n  else if (poolProgram === PUMP_AMM_PROGRAM && poolKey.equals(canonicalPumpSwapPool)) {\n    verdict = "BURNED";\n    method = "pump_migrate_canonical_pool_lp_burned";\n    pctSafe = 100;\n  }\n  else {`;
  onchain = replaceOnce(
    onchain,
    classificationAnchor,
    classificationReplacement,
    "canonical PumpSwap classification"
  );
  fs.writeFileSync(onchainPath, onchain);
}

let safety = read(safetyPath);
if (!safety.includes(MARKER)) {
  safety = replaceOnce(
    safety,
    'import { evaluateLiquiditySafety } from "./liquiditySafety";',
    `import { evaluateLiquiditySafety } from "./liquiditySafety";\nimport { resolveOnchainLpSafety, resolveTokenControls } from "./onchainRugSafety"; // ${MARKER}`,
    "on-chain safety import"
  );

  safety = replaceOnce(
    safety,
    'Number(process.env.LIVE_MIN_LIQUIDITY_USD) || 75_000',
    'Number(process.env.LIVE_MIN_LIQUIDITY_USD) || 40_000',
    "winner-aligned liquidity default"
  );
  safety = replaceOnce(
    safety,
    'Number(process.env.LIVE_LP_UNKNOWN_MIN_LIQUIDITY_USD) || 90_000',
    'Number(process.env.LIVE_LP_UNKNOWN_MIN_LIQUIDITY_USD) || 40_000',
    "unknown LP liquidity default"
  );

  safety = replaceOnce(
    safety,
    '  mode?: "live" | "paper";\n}',
    '  mode?: "live" | "paper";\n  sourceEntrySnapshot?: Record<string, any> | null;\n}',
    "source snapshot input"
  );

  safety = replaceOnce(
    safety,
    '    let riskTier: "verified" | "lp_unknown_probation" = "verified";\n',
    `    let riskTier: "verified" | "lp_unknown_probation" | "lp_unknown_mature" = "verified";\n    if (liveCall) {\n      const tokenControls = await resolveTokenControls(input.mint);\n      details.onchainTokenControls = tokenControls;\n      if (!tokenControls.safe) {\n        return reject(tokenControls.reason || "unsafe_token_controls", details);\n      }\n    }\n`,
    "token controls and risk tiers"
  );

  safety = replaceOnce(
    safety,
    '      const liquiditySafety = await evaluateLiquiditySafety({ mint: input.mint, pairAddress: pair?.pairAddress ?? null, dexId: pair?.dexId ?? null });\n',
    `      const liquiditySafety = await evaluateLiquiditySafety({ mint: input.mint, pairAddress: pair?.pairAddress ?? null, dexId: pair?.dexId ?? null });\n      const onchainLpSafety = await resolveOnchainLpSafety({\n        mint: input.mint,\n        pool: String(pair?.pairAddress ?? ""),\n        dexId: pair?.dexId ?? null,\n      });\n      details.onchainLpSafety = onchainLpSafety;\n`,
    "on-chain LP resolution"
  );

  const actionAnchor = `      let action = !enforce\n        ? liquiditySafety.verdict === "LOCKED" ? "pass" : "shadow_would_block"\n        : liquiditySafety.verdict === "UNLOCKED" || (liquiditySafety.verdict === "UNKNOWN" && blockOnUnknown)\n          ? "block"\n          : "pass";`;
  const actionReplacement = `${actionAnchor}\n      if (liveCall) {\n        if (onchainLpSafety.verdict === "UNLOCKED") action = "block";\n        else if (["LOCKED", "BURNED", "CURVE"].includes(onchainLpSafety.verdict)) action = "pass";\n      }`;
  safety = replaceOnce(safety, actionAnchor, actionReplacement, "combined LP verdict");

  safety = replaceOnce(
    safety,
    '        if (liquiditySafety.verdict === "UNLOCKED") {\n          return reject("liquidity_unlocked", details);\n        }',
    '        if (liquiditySafety.verdict === "UNLOCKED" || onchainLpSafety.verdict === "UNLOCKED") {\n          return reject("liquidity_unlocked", details);\n        }',
    "explicit unlocked veto"
  );

  safety = replaceOnce(
    safety,
    `        const knownPumpSwapClassificationGap =\n          normalizedDex === "pumpswap" &&\n          liquiditySafety.method === "goplus_lock_state_unrecognized" &&\n          !liquiditySafety.rawError;`,
    `        const knownPumpSwapClassificationGap =\n          normalizedDex === "pumpswap" &&\n          onchainLpSafety.verdict === "UNKNOWN" &&\n          liquiditySafety.method === "goplus_lock_state_unrecognized" &&\n          !liquiditySafety.rawError;`,
    "non-canonical PumpSwap fallback"
  );

  safety = replaceOnce(
    safety,
    `          reducedSizePassed:\n            input.sizeSol > 0 &&\n            input.sizeSol <= LIVE_LP_UNKNOWN_PROBATION_SIZE_SOL + 1e-9,`,
    `          requestedSizeValid: input.sizeSol > 0,\n          sourceSnapshotAvailable: Boolean(input.sourceEntrySnapshot?.opportunity),`,
    "deferred probation sizing"
  );

  safety = replaceOnce(
    safety,
    '        const probationEligible = Object.values(probationChecks).every(Boolean);',
    `        const sourceOpportunity = input.sourceEntrySnapshot?.opportunity ?? {};\n        const sourcePoolAgeMinutes = n(\n          sourceOpportunity.pool_age_minutes,\n          poolAgeMs / 60_000\n        );\n        const sourceBuyersM5 = n(sourceOpportunity.buyers_m5, Number.NaN);\n        const sourceBuyRatio = n(\n          sourceOpportunity.signal_snapshot?.buyRatio,\n          Number.NaN\n        );\n        const sourceH1Change = n(sourceOpportunity.price_change_h1, Number.NaN);\n        const sourceRisks = Array.isArray(sourceOpportunity.risks)\n          ? sourceOpportunity.risks.map((value: unknown) => String(value))\n          : [];\n        const youngUnknownPool = sourcePoolAgeMinutes < 90;\n        const historicalRugPattern =\n          youngUnknownPool &&\n          sourceH1Change >= 35 &&\n          (sourceBuyersM5 < 100 ||\n            sourceBuyRatio <= 0.57 ||\n            sourceRisks.includes("possible_churn_or_fake_volume"));\n        const fullSizeEligible = sourcePoolAgeMinutes >= 90;\n        const approvedSizeSol = fullSizeEligible\n          ? input.sizeSol\n          : Math.min(input.sizeSol, LIVE_LP_UNKNOWN_PROBATION_SIZE_SOL);\n        const baseProbationEligible = Object.values(probationChecks).every(Boolean);\n        const probationEligible = baseProbationEligible && !historicalRugPattern;`,
    "historical rug pattern"
  );

  safety = replaceOnce(
    safety,
    `          eligible: probationEligible,\n          requestedSizeSol: input.sizeSol,\n          maximumSizeSol: LIVE_LP_UNKNOWN_PROBATION_SIZE_SOL,`,
    `          eligible: probationEligible,\n          requestedSizeSol: input.sizeSol,\n          maximumSizeSol: approvedSizeSol,\n          fullSizeEligible,\n          historicalRugPattern,\n          sourcePattern: {\n            poolAgeMinutes: sourcePoolAgeMinutes,\n            buyersM5: Number.isFinite(sourceBuyersM5) ? sourceBuyersM5 : null,\n            buyRatio: Number.isFinite(sourceBuyRatio) ? sourceBuyRatio : null,\n            priceChangeH1: Number.isFinite(sourceH1Change) ? sourceH1Change : null,\n            risks: sourceRisks,\n          },`,
    "probation evidence metadata"
  );

  safety = replaceOnce(
    safety,
    `        if (!probationEligible) {\n          return reject("liquidity_lock_unknown", details);\n        }\n\n        riskTier = "lp_unknown_probation";`,
    `        if (!probationEligible) {\n          return reject(\n            historicalRugPattern ? "historical_rug_pattern" : "liquidity_lock_unknown",\n            details\n          );\n        }\n\n        details.approvedSizeSol = approvedSizeSol;\n        riskTier = fullSizeEligible ? "lp_unknown_mature" : "lp_unknown_probation";`,
    "probation decision and approved size"
  );

  fs.writeFileSync(safetyPath, safety);
}

let executor = read(executorPath);
if (!executor.includes(MARKER)) {
  executor = replaceOnce(
    executor,
    '  const expectedTokenAmount =\n',
    `  const { data: sourcePosition, error: sourcePositionError } = await supabase\n    .from("ai_discovery_positions")\n    .select("entry_snapshot")\n    .eq("position_id", signal.source_position_id)\n    .maybeSingle();\n  if (sourcePositionError) {\n    return {\n      reason: "source_entry_snapshot_query_failed",\n      details: { error: sourcePositionError.message },\n    };\n  }\n\n  const expectedTokenAmount =\n`,
    "source entry snapshot query"
  );

  executor = replaceOnce(
    executor,
    '    expectedTokenAmount,\n    mode: "live",\n  });',
    `    expectedTokenAmount,\n    sourceEntrySnapshot: (sourcePosition?.entry_snapshot as Record<string, any> | null) ?? null,\n    mode: "live",\n  }); // ${MARKER}`,
    "source snapshot pass-through"
  );

  const safetyLogAnchor = `      console.log(\n        \`[live-executor] safety passed \${signal.token_symbol ?? signal.mint}: \${JSON.stringify(safety.details)}\`\n      );`;
  const safetyLogReplacement = `      const approvedSizeSol = n(safety.details.approvedSizeSol);\n      const requestedSizeSol = n(signal.requested_size_sol);\n      if (\n        approvedSizeSol > 0 &&\n        requestedSizeSol > 0 &&\n        approvedSizeSol < requestedSizeSol\n      ) {\n        const { error: resizeError } = await supabase\n          .from("live_trade_signals")\n          .update({ requested_size_sol: approvedSizeSol })\n          .eq("id", signal.id)\n          .eq("status", "pending");\n        if (resizeError) throw new Error(resizeError.message);\n        signal.requested_size_sol = approvedSizeSol;\n        console.log(\n          \`[live-executor] probation size \${signal.token_symbol ?? signal.mint}: \` +\n            \`\${requestedSizeSol.toFixed(4)} -> \${approvedSizeSol.toFixed(4)} SOL\`\n        );\n      }\n\n${safetyLogAnchor}`;
  executor = replaceOnce(
    executor,
    safetyLogAnchor,
    safetyLogReplacement,
    "approved live size enforcement"
  );

  fs.writeFileSync(executorPath, executor);
}

const verifyOnchain = read(onchainPath);
const verifySafety = read(safetyPath);
const verifyExecutor = read(executorPath);
if (
  !verifyOnchain.includes("pump_migrate_canonical_pool_lp_burned") ||
  !verifySafety.includes("historical_rug_pattern") ||
  !verifySafety.includes("approvedSizeSol") ||
  !verifyExecutor.includes("probation size")
) {
  throw new Error("[live-winner-rug-veto] verification failed after patch");
}

console.log(
  "[live-winner-rug-veto] active: mature winner-style entries preserved; young unknown pools use 0.03 SOL probation; historical rug pattern blocked"
);
