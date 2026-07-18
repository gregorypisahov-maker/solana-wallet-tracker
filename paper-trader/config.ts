// paper-trader/config.ts
// Central place to tune every threshold. Nothing else in this project
// should hardcode a number — change behavior here.

export const config = {
  entry: {
    minScore: 10,
    maxScore: 65,
    minWalletCount: 3,
    minAvgBuyPerWallet: 1.25,
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
    sizePctPerTrade: 0.03,
    maxConcurrentPositions: 3,
  },

  exit: {
    takeProfitLadder: [
      { atMultiple: 1.35, sellPct: 1.0 },
    ],
    breakEvenActivationMultiple: 1.08,
    trailingActivationMultiple: 1.18,
    trailingStopPct: 0.10,
    hardStopLossPct: 0.12,
    maxHoldMinutes: 60,
  },

  risk: {
    dailyLossLimitPct: 0.10,

    // Keep automatic paper-data collection running. This preserves the newer
    // no-manual-resume safeguard while restoring the profitable strategy profile.
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
