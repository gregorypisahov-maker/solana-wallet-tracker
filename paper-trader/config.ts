// paper-trader/config.ts
// Central place to tune every threshold. Nothing else in this project
// should hardcode a number — change behavior here.

export const config = {
  entry: {
    // Keep the paper engine aligned with the monitor's consensus gate.
    // Previously the monitor accepted a signal and sent an alert, but the
    // simulator silently rejected many of the same tokens because these
    // limits were stricter and inconsistent.
    minScore: 8,
    minWalletCount: 3,
    minAvgBuyPerWallet: 0.5,
    minLiquidityToMcapRatio: 0.05,
    maxMarketCapUsd: 3_000_000,
    minLiquidityUsd: 10_000,
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