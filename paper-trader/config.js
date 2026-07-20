// paper-trader/config.js
// Compatibility build for code paths that resolve JavaScript before TypeScript.
// Keep these values aligned with paper-trader/config.ts.

const config = {
  entry: {
    minScore: 10,
    maxScore: 65,
    minWalletCount: 3,
    minAvgBuyPerWallet: 1.5,
    minAvgTrustScore: 55,
    eliteTwoWalletMinAvgBuySol: 1.5,
    eliteTwoWalletMinAvgTrustScore: 60,
    minLiquidityToMcapRatio: 0.25,
    minMarketCapUsd: 20_000,
    maxMarketCapUsd: 200_000,
    minLiquidityUsd: 15_000,
    blockedConfidenceGrades: new Set(["D"]),
  },

  position: {
    simulatedBankrollSol: 10,
    sizePctPerTrade: 0.02,
    provenTraderSizeMultiplier: 0.5,
    maxConcurrentPositions: 2,
  },

  execution: {
    entryFrictionPct: 0.006,
    exitFrictionPct: 0.006,
  },

  exit: {
    takeProfitLadder: [{ atMultiple: 1.3, sellPct: 1.0 }],
    breakEvenActivationMultiple: 1.07,
    trailingActivationMultiple: 1.15,
    trailingStopPct: 0.08,
    hardStopLossPct: 0.08,
    maxHoldMinutes: 45,
  },

  risk: {
    dailyLossLimitPct: 0.06,
    maxLossesInARow: Number.POSITIVE_INFINITY,
  },

  polling: {
    intervalMs: 5000,
    dexscreenerBase: "https://api.dexscreener.com/latest/dex/tokens/",
  },

  telegram: {
    notifyOnEntry: true,
    notifyOnExit: true,
    notifyOnReject: true,
    dailySummaryHourUTC: 6,
  },
};

// Support both legacy `require("./config")` and modern named imports.
module.exports = config;
module.exports.config = config;
module.exports.default = config;
