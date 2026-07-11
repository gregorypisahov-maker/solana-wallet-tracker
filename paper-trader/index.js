// index.js
// Entry point. Wire this into wherever your existing tracker currently
// builds the "Smart Wallet Consensus" Telegram message — call onAlert()
// with the same data right before (or instead of) sending to Telegram.

const config = require('./config');
const { onAlert, checkPositions, getOpenPositions } = require('./engine');

// ---- Example: how to feed an alert in from your existing bot code ----
// In your wallet-tracker code, wherever you currently build the Telegram
// message payload (score, wallets, totalBought, marketCap, liquidity, mint),
// call this instead of / in addition to sending the Telegram message:
//
//   const { onAlert } = require('./paper-trader/engine');
//   await onAlert({
//     tokenSymbol: 'MASON',
//     mint: '4gqUH4qMtkZTjeenrtVmcQXKEYg9aBUC8j2kQao2pump',
//     score: 45,
//     walletCount: 5,
//     totalBoughtSol: 36.54,
//     marketCapUsd: 53912,
//     liquidityUsd: 30662,
//   });

// Poll open positions on an interval to check exit conditions.
setInterval(async () => {
  await checkPositions();
  const open = getOpenPositions();
  if (open.length > 0) {
    console.log(
      `[STATUS] ${open.length} open position(s): ${open.map((p) => p.tokenSymbol).join(', ')}`
    );
  }
}, config.polling.intervalMs);

console.log('Paper trading engine running. Feed alerts via onAlert(). Ctrl+C to stop.');
console.log(`Entry filters: minScore=${config.entry.minScore}, minWallets=${config.entry.minWalletCount}, ` +
  `minAvgBuy=${config.entry.minAvgBuyPerWallet} SOL, maxMcap=$${config.entry.maxMarketCapUsd}`);
