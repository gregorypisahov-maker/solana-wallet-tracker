// paper-trader/config.ts
// Central place to tune every threshold. Nothing else in this project
// should hardcode a number — change behavior here.

export const config = {
  entry: {
    minScore: 8,                  // matches your real 0-10ish scoring scale (MIN_SCORE_FOR_ALERT=6 in monitor.ts)
    minWalletCount: 4,
    minAvgBuyPerWallet: 3,         // SOL, per wallet — not total
    minLiquidityToMcapRatio: 0.25, // liquidity must be >=25% of mcap
    maxMarketCapUsd: 60000,        // don't chase — already-pumped tokens are late entries
    minLiquidityUsd: 15000,
  },

  position: {
    simulatedBankrollSol: 10,
    sizePctPerTrade: 0.03,         // 3% of bankroll per trade, fixed
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
    maxLossesInARow: 4,
  },

  polling: {
    intervalMs: 5000,
    dexscreenerBase: 'https://api.dexscreener.com/latest/dex/tokens/',
  },

  telegram: {
    notifyOnEntry: true,
    notifyOnExit: true,
    dailySummaryHourUTC: 6, // ~9am Israel time (UTC+3), adjust if needed
  },
};
