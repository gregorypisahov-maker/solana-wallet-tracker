// paper-trader/config.ts
// Central place to tune every threshold. Nothing else in this project
// should hardcode a number — change behavior here.

export const config = {
  entry: {
    minScore: 8,
    minWalletCount: 3,
    minAvgBuyPerWallet: 1.5,
    minLiquidityToMcapRatio: 0.08,
    maxMarketCapUsd: 1_000_000,
    minLiquidityUsd: 15_000,
  },

  position: {
    simulatedBankrollSol: 10,
    sizePctPerTrade: 0.03,
    maxConcurrentPositions: 5,
  },

  exit: {
    takeProfitLadder: [
      { atMultiple: 1.3, sellPct: 0.5 },
      { atMultiple: 1.6, sellPct: 0.5 },
    ],
    trailingStopPct: 0.15,
    hardStopLossPct: 0.15,
    maxHoldMinutes: 45,
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
