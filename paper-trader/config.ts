// paper-trader/config.ts
// Central place to tune every threshold. Nothing else in this project
// should hardcode a number — change behavior here.

export const config = {
  entry: {
    // Restored productive paper-trading profile. This keeps basic safety
    // protections while allowing the simulator to collect enough trades to
    // measure whether the strategy really has an edge.
    minScore: 8,
    minWalletCount: 3,
    minAvgBuyPerWallet: 1.0,
    minLiquidityToMcapRatio: 0.08,
    maxMarketCapUsd: 3_000_000,
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