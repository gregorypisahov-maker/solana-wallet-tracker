import fetch from "node-fetch";

const configuredTokenDataTimeoutMs = Number(
  process.env.TOKEN_DATA_TIMEOUT_MS ?? 12_000
);
const TOKEN_DATA_TIMEOUT_MS = Number.isFinite(configuredTokenDataTimeoutMs)
  ? Math.max(3_000, configuredTokenDataTimeoutMs)
  : 12_000;

async function fetchWithTimeout(
  url: string,
  init: NonNullable<Parameters<typeof fetch>[1]> = {}
) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    TOKEN_DATA_TIMEOUT_MS
  );

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export interface TokenMarketData {
  symbol: string | null;
  name: string | null;
  marketCap: number | null;
  liquidityUsd: number | null;
  holders: number | null;
}

/**
 * DexScreener is free and needs no API key — used as the default source for
 * price/market cap/liquidity. It does not return holder counts.
 */
export async function fetchDexScreenerData(tokenMint: string): Promise<TokenMarketData> {
  try {
    const res = await fetchWithTimeout(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`);
    if (!res.ok) throw new Error(`DexScreener ${res.status}`);
    const data: any = await res.json();
    const pairs = data?.pairs ?? [];
    if (!pairs.length) {
      return { symbol: null, name: null, marketCap: null, liquidityUsd: null, holders: null };
    }
    // Use the pair with the highest liquidity as the canonical source
    const best = pairs.reduce((a: any, b: any) =>
      (b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a
    );
    return {
      symbol: best.baseToken?.symbol ?? null,
      name: best.baseToken?.name ?? null,
      marketCap: best.fdv ?? best.marketCap ?? null,
      liquidityUsd: best.liquidity?.usd ?? null,
      holders: null,
    };
  } catch (err) {
    console.error("DexScreener fetch failed for", tokenMint, err);
    return { symbol: null, name: null, marketCap: null, liquidityUsd: null, holders: null };
  }
}

/**
 * Optional: Birdeye fills in holder counts if BIRDEYE_API_KEY is set.
 * Free DexScreener data is used regardless; this only adds holders on top.
 */
export async function fetchBirdeyeHolders(tokenMint: string): Promise<number | null> {
  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetchWithTimeout(
      `https://public-api.birdeye.so/defi/token_overview?address=${tokenMint}`,
      { headers: { "X-API-KEY": apiKey, "x-chain": "solana" } }
    );
    if (!res.ok) throw new Error(`Birdeye ${res.status}`);
    const data: any = await res.json();
    return data?.data?.holder ?? null;
  } catch (err) {
    console.error("Birdeye fetch failed for", tokenMint, err);
    return null;
  }
}

export async function fetchTokenMarketData(tokenMint: string): Promise<TokenMarketData> {
  const base = await fetchDexScreenerData(tokenMint);
  const holders = await fetchBirdeyeHolders(tokenMint);
  return { ...base, holders: holders ?? base.holders };
}
