// paper-trader/config.ts
// Central place to tune every threshold. Nothing else in this project
// should hardcode a number — change behavior here.

export const config = {
  entry: {
    minScore: 10,
    maxScore: 65,
    minWalletCount: 3,
    // Match the profitable Shadow forward-test entry discipline.
    minAvgBuyPerWallet: 0.75,
    minAvgTrustScore: 55,
    eliteTwoWalletMinAvgBuySol: 1.25,
    eliteTwoWalletMinAvgTrustScore: 60,
    minLiquidityToMcapRatio: 0.15,
    minMarketCapUsd: 20_000,
    maxMarketCapUsd: 200_000,
    minLiquidityUsd: 15_000,
    blockedConfidenceGrades: new Set(["D"]),
  },

  position: {
    simulatedBankrollSol: 10,
    // Match Shadow: 3% of available paper cash with at most three positions.
    sizePctPerTrade: 0.03,
    provenTraderSizeMultiplier: 0.5,
    maxConcurrentPositions: 3,
  },

  execution: {
    // Charge 1.2% round-trip paper friction before reporting performance.
    entryFrictionPct: 0.006,
    exitFrictionPct: 0.006,
  },

  exit: {
    takeProfitLadder: [
      // 1.075x after paper friction corresponds to roughly a +9% chart move.
      { atMultiple: 1.075, sellPct: 0.5 },
      // Close everything still open if the larger Shadow target is reached.
      { atMultiple: 1.35, sellPct: 1.0 },
    ],
    // Once the first profit zone has been reached, protect the remaining half at entry.
    breakEvenActivationMultiple: 1.075,
    trailingActivationMultiple: 1.18,
    trailingStopPct: 0.10,
    hardStopLossPct: 0.12,
    maxHoldMinutes: 60,
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

export default config;
