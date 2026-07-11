// config.js
// Central place to tune every threshold. Nothing else in this project
// should hardcode a number — change behavior here.

module.exports = {
  // ---- ENTRY FILTERS (all must pass or the alert is skipped) ----
  entry: {
    minScore: 60,                 // was letting 31-45 through before — raise the bar
    minWalletCount: 4,
    minAvgBuyPerWallet: 3,        // SOL, per wallet — not total. Kills low-conviction noise.
    minLiquidityToMcapRatio: 0.25,// liquidity must be >=25% of mcap or you can't exit clean
    maxMarketCapUsd: 60000,       // don't chase — if it's already >60k you're late
    minLiquidityUsd: 15000,       // absolute floor, avoid unsellable micro-pools
  },

  // ---- POSITION SIZING ----
  position: {
    simulatedBankrollSol: 10,     // fake starting bankroll for the paper account
    sizePctPerTrade: 0.03,        // 3% of bankroll per trade, fixed — never scale up on streaks
    maxConcurrentPositions: 5,
  },

  // ---- EXIT LOGIC ----
  exit: {
    // Take-profit ladder: sell portions as price multiples are hit
    takeProfitLadder: [
      { atMultiple: 1.3, sellPct: 0.5 },  // +30%: sell half
      { atMultiple: 1.6, sellPct: 0.5 },  // +60% (of remainder): sell half of what's left
      // remaining runs with a trailing stop, see trailingStopPct below
    ],
    trailingStopPct: 0.15,        // once in profit, trail 15% below peak price
    hardStopLossPct: 0.15,        // -15% from entry, no questions asked
    maxHoldMinutes: 45,           // memecoin moves are fast — force-close stale positions
  },

  // ---- RISK CIRCUIT BREAKERS ----
  risk: {
    dailyLossLimitPct: 0.10,      // halt new entries if down 10% of bankroll for the day
    maxLossesInARow: 4,           // halt and flag for review after 4 consecutive losses
  },

  // ---- PRICE POLLING ----
  polling: {
    intervalMs: 5000,             // how often to check price on open positions
    dexscreenerBase: 'https://api.dexscreener.com/latest/dex/tokens/',
  },

  // ---- STORAGE ----
  storage: {
    tradesLogPath: './data/trades.json',
    stateLogPath: './data/state.json',
  },
};
