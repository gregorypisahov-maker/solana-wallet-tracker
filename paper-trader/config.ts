// paper-trader/config.ts
// Central place to tune every threshold. Nothing else in this project
// should hardcode a number — change behavior here.

export const config = {
  entry: {
    // Paper-only quality profile based on the completed-trade sample. Real
    // trading remains disabled. Three-wallet consensus is standard; a very
    // strong two-wallet signal may still pass in entryFilter.ts.
    minScore: 10,
    maxScore: 65,
    minWalletCount: 3,
    minAvgBuyPerWallet: 0.75,
    minLiquidityToMcapRatio: 0.15,
    maxMarketCapUsd: 200_000,
    minLiquidityUsd: 15_000,
    minAverageTrustScore: 55,
  },

  position: {
    simulatedBankrollSol: 10,
    sizePctPerTrade: 0.03,
    maxConcurrentPositions: 3,
  },

  exit: {
    takeProfitLadder: [
      { atMultiple: 1.3, sellPct: 0.5 },
      { atMultiple: 1.6, sellPct: 0.5 },
    ],
    trailingStopPct: 0.12,
    hardStopLossPct: 0.12,
    maxHoldMinutes: 45,
  },

  risk: {
    // Keep the daily drawdown circuit breaker active.
    dailyLossLimitPct: 0.10,

    // Paper trading must keep collecting data automatically. Setting this
    // to Infinity disables the old permanent halt after four consecutive
    // losses, so /resume is no longer required for a loss streak. Re-enable
    // a finite limit before using real funds.
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
