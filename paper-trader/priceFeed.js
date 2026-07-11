// priceFeed.js
// Thin wrapper around DexScreener's public API for price polling.
// Swap this out for Birdeye if you prefer — same shape (getPriceUsd(mint)).

const config = require('./config');

// Node 18+ has global fetch. If running on an older runtime, install node-fetch.
async function getPriceUsd(mint) {
  const url = `${config.polling.dexscreenerBase}${mint}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`DexScreener request failed: ${res.status}`);
  }
  const data = await res.json();
  const pair = data?.pairs?.[0];
  if (!pair || !pair.priceUsd) {
    throw new Error(`No price data for mint ${mint}`);
  }
  return {
    priceUsd: parseFloat(pair.priceUsd),
    liquidityUsd: pair.liquidity?.usd ?? null,
    marketCapUsd: pair.fdv ?? pair.marketCap ?? null,
  };
}

module.exports = { getPriceUsd };
