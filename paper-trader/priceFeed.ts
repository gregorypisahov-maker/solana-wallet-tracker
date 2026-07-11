// paper-trader/priceFeed.ts
import { config } from './config';

export interface PriceData {
  priceUsd: number;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
}

export async function getPriceUsd(mint: string): Promise<PriceData> {
  const url = `${config.polling.dexscreenerBase}${mint}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`DexScreener request failed: ${res.status}`);
  }
  const data: any = await res.json();
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
