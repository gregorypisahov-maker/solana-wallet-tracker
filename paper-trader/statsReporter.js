// statsReporter.js
// Run this any time to see how the paper account is doing:
//   node statsReporter.js

const { loadTrades, loadState } = require('./storage');

function summarize() {
  const trades = loadTrades();
  const state = loadState();

  if (trades.length === 0) {
    console.log('No trades logged yet.');
    return;
  }

  const wins = trades.filter((t) => t.pnlSol > 0);
  const losses = trades.filter((t) => t.pnlSol <= 0);
  const totalPnl = trades.reduce((sum, t) => sum + t.pnlSol, 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnlSol, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnlSol, 0) / losses.length : 0;
  const winRate = (wins.length / trades.length) * 100;

  const reasonCounts = {};
  for (const t of trades) {
    reasonCounts[t.reason] = (reasonCounts[t.reason] || 0) + 1;
  }

  console.log('--- Paper Trading Report ---');
  console.log(`Total sell events: ${trades.length}`);
  console.log(`Win rate: ${winRate.toFixed(1)}% (${wins.length}W / ${losses.length}L)`);
  console.log(`Total PnL: ${totalPnl.toFixed(3)} SOL`);
  console.log(`Avg win: ${avgWin.toFixed(3)} SOL | Avg loss: ${avgLoss.toFixed(3)} SOL`);
  console.log(`Current simulated bankroll: ${state.bankrollSol.toFixed(3)} SOL`);
  console.log(`Exit reason breakdown:`, reasonCounts);
  console.log('----------------------------');
}

if (require.main === module) {
  summarize();
}

module.exports = { summarize };
