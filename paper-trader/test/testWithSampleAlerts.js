// test/testWithSampleAlerts.js
// Sanity check using the 3 real alerts from your screenshots (MASON, SATOSHI, PUNK).
// Price feed is mocked here since this sandbox has no network access —
// swap priceFeed.js back to the real DexScreener version to go live.

const path = require('path');
const Module = require('module');

// Mock priceFeed before engine.js requires it
const priceFeedPath = require.resolve('../priceFeed');
const mockPrices = {
  // mint -> sequence of prices returned on successive calls
  '4gqUH4qMtkZTjeenrtVmcQXKEYg9aBUC8j2kQao2pump': [0.0000539, 0.0000539], // MASON
  '2R8GSyFMz1xbJznogKyM11GfxD3de61bPbYoiip7pump': [0.0000188, 0.0000188], // SATOSHI
  '5NgaVXHoikb9e326MSCwo44DXKGuPiKVt9q9Tm51pump': [0.000114, 0.000148, 0.000182, 0.000114], // PUNK: pumps then dumps
};
const callCounts = {};

require.cache[priceFeedPath] = {
  id: priceFeedPath,
  filename: priceFeedPath,
  loaded: true,
  exports: {
    async getPriceUsd(mint) {
      callCounts[mint] = (callCounts[mint] || 0);
      const series = mockPrices[mint] || [0.0001];
      const idx = Math.min(callCounts[mint], series.length - 1);
      callCounts[mint]++;
      return { priceUsd: series[idx], liquidityUsd: null, marketCapUsd: null };
    },
  },
};

const { onAlert, checkPositions, getOpenPositions } = require('../engine');
const { summarize } = require('../statsReporter');
const fs = require('fs');

// Clean slate for the test
const dataDir = path.join(__dirname, '..', 'data');
if (fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });

const alerts = [
  {
    tokenSymbol: 'MASON',
    mint: '4gqUH4qMtkZTjeenrtVmcQXKEYg9aBUC8j2kQao2pump',
    score: 45,
    walletCount: 5,
    totalBoughtSol: 36.54,
    marketCapUsd: 53912,
    liquidityUsd: 30662,
  },
  {
    tokenSymbol: 'SATOSHI',
    mint: '2R8GSyFMz1xbJznogKyM11GfxD3de61bPbYoiip7pump',
    score: 31,
    walletCount: 3,
    totalBoughtSol: 2.41,
    marketCapUsd: 18856,
    liquidityUsd: 10330,
  },
  {
    tokenSymbol: 'PUNK',
    mint: '5NgaVXHoikb9e326MSCwo44DXKGuPiKVt9q9Tm51pump',
    score: 45,
    walletCount: 4,
    totalBoughtSol: 12.16,
    marketCapUsd: 114148,
    liquidityUsd: 28698,
  },
];

const strongAlert = {
  tokenSymbol: 'STRONG',
  mint: 'STRONGmintExampleAddress111111111111111111',
  score: 75,
  walletCount: 6,
  totalBoughtSol: 30,       // 5 SOL avg/wallet
  marketCapUsd: 45000,
  liquidityUsd: 18000,      // 40% ratio
};
mockPrices[strongAlert.mint] = [0.0001, 0.00013, 0.00016, 0.00013]; // pumps then trailing-stop triggers

(async () => {
  console.log('=== Testing entry filters against your 3 real alerts ===\n');
  for (const alert of alerts) {
    await onAlert(alert);
  }

  console.log('\n=== Open positions after filtering (real alerts) ===');
  console.log(getOpenPositions().map((p) => p.tokenSymbol));

  console.log('\n=== Now testing a synthetic alert that SHOULD pass filters ===\n');
  await onAlert(strongAlert);
  console.log('Open positions:', getOpenPositions().map((p) => p.tokenSymbol));

  console.log('\n=== Simulating price movement / exit ladder over time (mocked) ===');
  await checkPositions(); // price ticks to 1.3x -> ladder rung 1 fires
  await checkPositions(); // price ticks to 1.6x -> ladder rung 2 fires
  await checkPositions(); // price drops back to 1.3x -> trailing stop on remainder fires

  console.log('\n');
  summarize();
})();
