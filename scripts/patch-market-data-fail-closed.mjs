import { readFileSync, writeFileSync } from 'node:fs';

const path = 'worker/monitor.ts';
const source = readFileSync(path, 'utf8');

const before = `    if (!market) {
      continue;
    }

    const marketCap =
      market.marketCap ?? 0;

    const liquidity =
      market.liquidityUsd ?? 0;`;

const after = `    const marketCap = Number(market?.marketCap);
    const liquidity = Number(market?.liquidityUsd);

    if (
      !market ||
      !Number.isFinite(marketCap) ||
      marketCap <= 0 ||
      !Number.isFinite(liquidity) ||
      liquidity <= 0
    ) {
      console.warn(
        \`[consensus-skip] \${tokenMint.slice(0, 6)} skip_reason=market_data_unavailable\`
      );
      continue;
    }`;

if (!source.includes(before)) {
  throw new Error('market-data fail-closed patch target not found');
}

writeFileSync(path, source.replace(before, after));
console.log('[startup-patch] Consensus market data now fails closed with an explicit skip reason.');
