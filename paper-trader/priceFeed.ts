// paper-trader/priceFeed.ts
import { config } from './config';

export interface PriceData {
  priceUsd: number;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
}

const PRICE_TIMEOUT_MS = Math.max(
  3_000,
  Number(process.env.PRICE_FEED_TIMEOUT_MS ?? 12_000)
);

export async function getPriceUsd(mint: string): Promise<PriceData> {
  const url = `${config.polling.dexscreenerBase}${mint}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PRICE_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      throw new Error(`DexScreener request failed: ${res.status}`);
    }

    const data: any = await res.json();
    const pairs = Array.isArray(data?.pairs) ? data.pairs : [];

    // Prefer the most liquid Solana pair instead of blindly taking pairs[0].
    const pair = pairs
      .filter((candidate: any) => candidate?.chainId === "solana" && candidate?.priceUsd)
      .sort(
        (a: any, b: any) =>
          Number(b?.liquidity?.usd ?? 0) - Number(a?.liquidity?.usd ?? 0)
      )[0];

    if (!pair) {
      throw new Error(`No Solana price data for mint ${mint}`);
    }

    const priceUsd = Number(pair.priceUsd);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
      throw new Error(`Invalid price data for mint ${mint}`);
    }

    return {
      priceUsd,
      liquidityUsd:
        pair.liquidity?.usd == null ? null : Number(pair.liquidity.usd),
      marketCapUsd:
        pair.fdv == null && pair.marketCap == null
          ? null
          : Number(pair.fdv ?? pair.marketCap),
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`DexScreener request timed out after ${PRICE_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
