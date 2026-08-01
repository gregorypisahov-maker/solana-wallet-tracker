import fs from "node:fs";

const target = new URL("../live-executor/liveSafety.ts", import.meta.url);
let source = fs.readFileSync(target, "utf8");

const marker = 'const LIVE_LP_UNKNOWN_PROBATION_VERSION = "live_lp_unknown_probation_v1_2026_08_01";';

if (source.includes(marker)) {
  console.log("[live-lp-probation-fix] already active; no-op");
  process.exit(0);
}

function replaceOnce(anchor, replacement, label) {
  if (!source.includes(anchor)) {
    throw new Error(`[live-lp-probation-fix] patch anchor not found: ${label}`);
  }
  source = source.replace(anchor, replacement);
}

const constantsAnchor =
  'const PAPER_HELIUS_MAX_AGE_MS = Math.max(60_000, Number(process.env.AI_PAPER_HELIUS_MAX_AGE_MS) || 15 * 60_000);\n';

replaceOnce(
  constantsAnchor,
  `${constantsAnchor}\n${marker}\nconst LIVE_LP_UNKNOWN_PROBATION_ENABLED = process.env.LIVE_LP_UNKNOWN_PROBATION_ENABLED !== "false";\nconst LIVE_LP_UNKNOWN_PROBATION_SIZE_SOL = Math.min(\n  0.05,\n  Math.max(0.01, Number(process.env.LIVE_LP_UNKNOWN_PROBATION_SIZE_SOL) || 0.03)\n);\nconst LIVE_LP_UNKNOWN_MIN_LIQUIDITY_USD = Math.max(\n  MIN_LIQUIDITY_USD,\n  Number(process.env.LIVE_LP_UNKNOWN_MIN_LIQUIDITY_USD) || 90_000\n);\nconst LIVE_LP_UNKNOWN_MIN_POOL_AGE_MS = Math.max(\n  MIN_POOL_AGE_MS,\n  Number(process.env.LIVE_LP_UNKNOWN_MIN_POOL_AGE_MS) || 20 * 60_000\n);\nconst LIVE_LP_UNKNOWN_MIN_M5_TRANSACTIONS = Math.max(\n  MIN_M5_TRANSACTIONS,\n  Number(process.env.LIVE_LP_UNKNOWN_MIN_M5_TRANSACTIONS) || 100\n);\nconst LIVE_LP_UNKNOWN_MIN_H24_VOLUME_USD = Math.max(\n  MIN_H24_VOLUME_USD,\n  Number(process.env.LIVE_LP_UNKNOWN_MIN_H24_VOLUME_USD) || 500_000\n);\nconst LIVE_LP_UNKNOWN_MAX_TOP_HOLDER_PCT = Math.min(\n  MAX_TOP_HOLDER_PCT,\n  Math.max(50, Number(process.env.LIVE_LP_UNKNOWN_MAX_TOP_HOLDER_PCT) || 78)\n);\nconst LIVE_LP_UNKNOWN_MAX_TOP5_HOLDER_PCT = Math.min(\n  MAX_TOP5_HOLDER_PCT,\n  Math.max(50, Number(process.env.LIVE_LP_UNKNOWN_MAX_TOP5_HOLDER_PCT) || 90)\n);\nconst LIVE_LP_UNKNOWN_MIN_BUY_SELL_RATIO = Math.max(\n  1,\n  Number(process.env.LIVE_LP_UNKNOWN_MIN_BUY_SELL_RATIO) || 1.15\n);\nconst LIVE_LP_UNKNOWN_MIN_ROUND_TRIP_RECOVERY_PCT = Math.min(\n  99.5,\n  Math.max(\n    MIN_ROUND_TRIP_RECOVERY_PCT,\n    Number(process.env.LIVE_LP_UNKNOWN_MIN_ROUND_TRIP_RECOVERY_PCT) || 97\n  )\n);\nconst LIVE_LP_UNKNOWN_MAX_BUY_PRICE_IMPACT_PCT = Math.min(\n  MAX_BUY_PRICE_IMPACT_PCT,\n  Math.max(0.1, Number(process.env.LIVE_LP_UNKNOWN_MAX_BUY_PRICE_IMPACT_PCT) || 1)\n);\nconst LIVE_LP_UNKNOWN_MAX_SELL_PRICE_IMPACT_PCT = Math.min(\n  MAX_SELL_PRICE_IMPACT_PCT,\n  Math.max(0.1, Number(process.env.LIVE_LP_UNKNOWN_MAX_SELL_PRICE_IMPACT_PCT) || 2)\n);\n`,
  "probation constants"
);

replaceOnce(
  "    const liveCall = !paperCall;\n",
  '    const liveCall = !paperCall;\n    let riskTier: "verified" | "lp_unknown_probation" = "verified";\n',
  "risk tier state"
);

replaceOnce(
  "      const action = !enforce\n",
  "      let action = !enforce\n",
  "mutable LP action"
);

const oldBlock = `      if (action === "block") {\n        return reject(\n          liquiditySafety.verdict === "UNLOCKED" ? "liquidity_unlocked" : "liquidity_lock_unknown",\n          details\n        );\n      }`;

const newBlock = `      if (action === "block") {\n        if (liquiditySafety.verdict === "UNLOCKED") {\n          return reject("liquidity_unlocked", details);\n        }\n\n        const normalizedDex = String(pair?.dexId ?? "").trim().toLowerCase();\n        const buySellRatio = m5Sells > 0 ? m5Buys / m5Sells : m5Buys > 0 ? 999 : 0;\n        const knownPumpSwapClassificationGap =\n          normalizedDex === "pumpswap" &&\n          liquiditySafety.method === "goplus_lock_state_unrecognized" &&\n          !liquiditySafety.rawError;\n        const probationChecks = {\n          enabled: LIVE_LP_UNKNOWN_PROBATION_ENABLED,\n          liveCall,\n          knownPumpSwapClassificationGap,\n          reducedSizePassed:\n            input.sizeSol > 0 &&\n            input.sizeSol <= LIVE_LP_UNKNOWN_PROBATION_SIZE_SOL + 1e-9,\n          liquidityPassed: liquidityUsd >= LIVE_LP_UNKNOWN_MIN_LIQUIDITY_USD,\n          poolAgePassed: poolAgeMs >= LIVE_LP_UNKNOWN_MIN_POOL_AGE_MS,\n          volumePassed: h24VolumeUsd >= LIVE_LP_UNKNOWN_MIN_H24_VOLUME_USD,\n          transactionCountPassed:\n            m5Transactions >= LIVE_LP_UNKNOWN_MIN_M5_TRANSACTIONS,\n          liquidityToFdvPassed,\n          top1Passed: top1Pct <= LIVE_LP_UNKNOWN_MAX_TOP_HOLDER_PCT,\n          top5Passed: top5Pct <= LIVE_LP_UNKNOWN_MAX_TOP5_HOLDER_PCT,\n          buyPressurePassed:\n            buySellRatio >= LIVE_LP_UNKNOWN_MIN_BUY_SELL_RATIO,\n        };\n        const probationEligible = Object.values(probationChecks).every(Boolean);\n\n        details.lpUnknownProbation = {\n          version: LIVE_LP_UNKNOWN_PROBATION_VERSION,\n          eligible: probationEligible,\n          requestedSizeSol: input.sizeSol,\n          maximumSizeSol: LIVE_LP_UNKNOWN_PROBATION_SIZE_SOL,\n          observed: {\n            liquidityUsd,\n            poolAgeMinutes: poolAgeMs / 60_000,\n            h24VolumeUsd,\n            m5Transactions,\n            liquidityToFdv,\n            top1HolderPct: top1Pct,\n            top5HolderPct: top5Pct,\n            m5BuySellRatio: buySellRatio,\n          },\n          checks: probationChecks,\n          thresholds: {\n            minimumLiquidityUsd: LIVE_LP_UNKNOWN_MIN_LIQUIDITY_USD,\n            minimumPoolAgeMinutes: LIVE_LP_UNKNOWN_MIN_POOL_AGE_MS / 60_000,\n            minimumH24VolumeUsd: LIVE_LP_UNKNOWN_MIN_H24_VOLUME_USD,\n            minimumM5Transactions: LIVE_LP_UNKNOWN_MIN_M5_TRANSACTIONS,\n            maximumTop1HolderPct: LIVE_LP_UNKNOWN_MAX_TOP_HOLDER_PCT,\n            maximumTop5HolderPct: LIVE_LP_UNKNOWN_MAX_TOP5_HOLDER_PCT,\n            minimumM5BuySellRatio: LIVE_LP_UNKNOWN_MIN_BUY_SELL_RATIO,\n          },\n        };\n\n        if (!probationEligible) {\n          return reject("liquidity_lock_unknown", details);\n        }\n\n        riskTier = "lp_unknown_probation";\n        action = "probation";\n        lpLock.action = action;\n        details.liquiditySafety = {\n          ...liquiditySafety,\n          enforced: enforce,\n          blockOnUnknown,\n          action,\n          mode: "live",\n        };\n      }`;

replaceOnce(oldBlock, newBlock, "unknown LP probation decision");

replaceOnce(
  '    if (buyImpact > MAX_BUY_PRICE_IMPACT_PCT) return reject("buy_price_impact_too_high", details);',
  `    const maximumBuyImpactPct =\n      riskTier === "lp_unknown_probation"\n        ? LIVE_LP_UNKNOWN_MAX_BUY_PRICE_IMPACT_PCT\n        : MAX_BUY_PRICE_IMPACT_PCT;\n    details.maximumBuyPriceImpactPct = maximumBuyImpactPct;\n    if (buyImpact > maximumBuyImpactPct) return reject("buy_price_impact_too_high", details);`,
  "probation buy impact"
);

replaceOnce(
  `    if (sellImpact > MAX_SELL_PRICE_IMPACT_PCT) return reject("sell_price_impact_too_high", details);\n    if (recoveryPct < MIN_ROUND_TRIP_RECOVERY_PCT) return reject("round_trip_recovery_too_low", details);\n    return { passed: true, reason: null, details };`,
  `    const maximumSellImpactPct =\n      riskTier === "lp_unknown_probation"\n        ? LIVE_LP_UNKNOWN_MAX_SELL_PRICE_IMPACT_PCT\n        : MAX_SELL_PRICE_IMPACT_PCT;\n    const minimumRoundTripRecoveryPct =\n      riskTier === "lp_unknown_probation"\n        ? LIVE_LP_UNKNOWN_MIN_ROUND_TRIP_RECOVERY_PCT\n        : MIN_ROUND_TRIP_RECOVERY_PCT;\n    Object.assign(details, {\n      riskTier,\n      requestedSizeSol: input.sizeSol,\n      maximumSellPriceImpactPct: maximumSellImpactPct,\n      minimumRoundTripRecoveryPct,\n    });\n    if (sellImpact > maximumSellImpactPct) return reject("sell_price_impact_too_high", details);\n    if (recoveryPct < minimumRoundTripRecoveryPct) return reject("round_trip_recovery_too_low", details);\n    return { passed: true, reason: null, details };`,
  "probation sell impact and return metadata"
);

fs.writeFileSync(target, source);
console.log(
  "[live-lp-probation-fix] active: PumpSwap LP-unknown entries require <=0.03 SOL and stricter safety checks"
);
