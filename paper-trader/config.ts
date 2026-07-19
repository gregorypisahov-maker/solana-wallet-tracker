// paper-trader/config.ts
// Central place to tune every threshold. Nothing else in this project
// should hardcode a number — change behavior here.

const config = {
  entry: {
    minScore: 10,
    maxScore: 65,
    minWalletCount: 3,
    minAvgBuyPerWallet: 1.5,
    // Historical paper results were profitable from trust 55 upward; the
    // temporary 58 floor suppressed otherwise valid three-wallet signals.
    minAvgTrustScore: 55,
    eliteTwoWalletMinAvgBuySol: 1.5,
    eliteTwoWalletMinAvgTrustScore: 60,
    // The strongest historical band had at least 25% liquidity backing.
    minLiquidityToMcapRatio: 0.25,
    minMarketCapUsd: 20_000,
    // The 180k-200k band remained profitable; losses concentrated above 200k.
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
    // Charge 1.2% round-trip paper friction before reporting performance.
    entryFrictionPct: 0.006,
    exitFrictionPct: 0.006,
  },

  exit: {
    takeProfitLadder: [
      { atMultiple: 1.3, sellPct: 1.0 },
    ],
    breakEvenActivationMultiple: 1.07,
    trailingActivationMultiple: 1.15,
    trailingStopPct: 0.08,
    hardStopLossPct: 0.10,
    maxHoldMinutes: 45,
  },

  risk: {
    dailyLossLimitPct: 0.06,
    // Keep paper collection automatic, but daily loss protection remains active.
    maxLossesInARow: Number.POSITIVE_INFINITY,
  },

  polling: {
    intervalMs: 5000,
    dexscreenerBase:
      "https://api.dexscreener.com/latest/dex/tokens/",
  },

  telegram: {
    notifyOnEntry: true,
    notifyOnExit: true,
    notifyOnReject: true,
    dailySummaryHourUTC: 6,
  },
};

export { config };
export default config;
