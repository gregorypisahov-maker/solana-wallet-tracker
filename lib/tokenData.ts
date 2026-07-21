import fetch from "node-fetch";

const configuredTokenDataTimeoutMs = Number(
  process.env.TOKEN_DATA_TIMEOUT_MS ?? 12_000
);
const TOKEN_DATA_TIMEOUT_MS = Number.isFinite(configuredTokenDataTimeoutMs)
  ? Math.max(3_000, configuredTokenDataTimeoutMs)
  : 12_000;

const configuredCacheTtlMs = Number(
  process.env.TOKEN_DATA_CACHE_TTL_SECONDS ?? 60
) * 1_000;
const TOKEN_DATA_CACHE_TTL_MS = Number.isFinite(configuredCacheTtlMs)
  ? Math.min(5 * 60_000, Math.max(30_000, configuredCacheTtlMs))
  : 60_000;

const configuredStaleCacheTtlMs = Number(
  process.env.TOKEN_DATA_STALE_CACHE_TTL_SECONDS ?? 180
) * 1_000;
const TOKEN_DATA_STALE_CACHE_TTL_MS = Number.isFinite(
  configuredStaleCacheTtlMs
)
  ? Math.min(
      15 * 60_000,
      Math.max(TOKEN_DATA_CACHE_TTL_MS + 30_000, configuredStaleCacheTtlMs)
    )
  : 180_000;

const configuredNegativeCacheTtlMs = Number(
  process.env.TOKEN_DATA_NEGATIVE_CACHE_TTL_SECONDS ?? 120
) * 1_000;
const TOKEN_DATA_NEGATIVE_CACHE_TTL_MS = Number.isFinite(
  configuredNegativeCacheTtlMs
)
  ? Math.min(10 * 60_000, Math.max(60_000, configuredNegativeCacheTtlMs))
  : 120_000;

const configuredFailureCooldownMs = Number(
  process.env.TOKEN_DATA_FAILURE_COOLDOWN_SECONDS ?? 15
) * 1_000;
const TOKEN_DATA_FAILURE_COOLDOWN_MS = Number.isFinite(
  configuredFailureCooldownMs
)
  ? Math.min(60_000, Math.max(5_000, configuredFailureCooldownMs))
  : 15_000;

const PROVIDER_MAX_ATTEMPTS = 3;
const PROVIDER_BASE_BACKOFF_MS = 1_000;
const PROVIDER_MAX_BACKOFF_MS = 15_000;

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

export type TokenMarketDataSource =
  | "dexscreener"
  | "geckoterminal"
  | "stale_cache";

export interface TokenMarketData {
  symbol: string | null;
  name: string | null;
  marketCap: number | null;
  liquidityUsd: number | null;
  holders: number | null;
  source?: TokenMarketDataSource;
  isStale?: boolean;
  fetchedAt?: string;
}

interface CachedTokenMarketData {
  value: TokenMarketData;
  expiresAt: number;
  staleUntil: number;
}

interface CachedFailure {
  message: string;
  expiresAt: number;
}

class HttpResponseError extends Error {
  constructor(
    public readonly provider: string,
    public readonly status: number,
    message: string,
    public readonly retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = "HttpResponseError";
  }
}

export class MarketDataUnavailableError extends Error {
  constructor(
    message: string,
    public readonly cacheTtlMs = TOKEN_DATA_FAILURE_COOLDOWN_MS
  ) {
    super(message);
    this.name = "MarketDataUnavailableError";
  }
}

const tokenDataCache = new Map<string, CachedTokenMarketData>();
const tokenDataInFlight = new Map<string, Promise<TokenMarketData>>();
const tokenDataFailureCache = new Map<string, CachedFailure>();
const providerBlockedUntilMs = new Map<string, number>();

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function positiveNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseRetryAfterMs(
  value: string | null,
  nowMs = Date.now()
): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - nowMs) : null;
}

function backoffDelayMs(attempt: number, retryAfterMs: number | null): number {
  const exponential = PROVIDER_BASE_BACKOFF_MS * 2 ** Math.max(0, attempt);
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(
    PROVIDER_MAX_BACKOFF_MS,
    Math.max(exponential + jitter, retryAfterMs ?? 0)
  );
}

async function fetchJsonWithBackoff(
  provider: string,
  url: string,
  maxAttempts = PROVIDER_MAX_ATTEMPTS
): Promise<any> {
  const blockedUntil = providerBlockedUntilMs.get(provider) ?? 0;
  if (blockedUntil > Date.now()) {
    throw new HttpResponseError(
      provider,
      429,
      `${provider} cooling down after a rate limit`,
      blockedUntil - Date.now()
    );
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await fetchWithTimeout(url, {
      headers: { accept: "application/json" },
    });

    if (response.ok) return response.json();

    const retryAfterMs = parseRetryAfterMs(
      response.headers.get("retry-after")
    );
    const body = (await response.text())
      .slice(0, 160)
      .replace(/\s+/g, " ");
    const error = new HttpResponseError(
      provider,
      response.status,
      `${provider} ${response.status}${body ? `: ${body}` : ""}`,
      retryAfterMs
    );
    const retryable = response.status === 429 || response.status >= 500;
    const delayMs = backoffDelayMs(attempt, retryAfterMs);

    if (response.status === 429) {
      providerBlockedUntilMs.set(
        provider,
        Math.max(providerBlockedUntilMs.get(provider) ?? 0, Date.now() + delayMs)
      );
    }

    if (!retryable || attempt === maxAttempts - 1) throw error;
    await sleep(delayMs);
  }

  throw new Error(`${provider} retry loop exhausted`);
}

function isUsableMarketData(value: TokenMarketData): boolean {
  return (
    positiveNumber(value.marketCap) !== null &&
    positiveNumber(value.liquidityUsd) !== null
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pruneExpiredCache(now: number): void {
  // Keep memory bounded in a long-running Railway worker.
  if (tokenDataCache.size >= 1_000) {
    for (const [mint, cached] of tokenDataCache) {
      if (cached.staleUntil <= now) tokenDataCache.delete(mint);
    }
  }

  if (tokenDataFailureCache.size >= 1_000) {
    for (const [mint, cached] of tokenDataFailureCache) {
      if (cached.expiresAt <= now) tokenDataFailureCache.delete(mint);
    }
  }
}

function staleCachedValue(
  tokenMint: string,
  now = Date.now()
): TokenMarketData | null {
  const cached = tokenDataCache.get(tokenMint);
  if (!cached || cached.staleUntil <= now || !isUsableMarketData(cached.value)) {
    return null;
  }

  const staleValue: TokenMarketData = {
    ...cached.value,
    source: "stale_cache",
    isStale: true,
  };
  cached.value = staleValue;
  cached.expiresAt = Math.min(
    cached.staleUntil,
    now + TOKEN_DATA_FAILURE_COOLDOWN_MS
  );
  return staleValue;
}

/**
 * DexScreener is free and needs no API key — used as the primary source for
 * market cap/liquidity. Retryable failures are thrown so callers can fall back
 * instead of treating a provider outage as real zero-valued market data.
 */
export async function fetchDexScreenerData(
  tokenMint: string
): Promise<TokenMarketData> {
  const data = await fetchJsonWithBackoff(
    "DexScreener",
    `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(tokenMint)}`
  );
  const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
  if (!pairs.length) {
    return {
      symbol: null,
      name: null,
      marketCap: null,
      liquidityUsd: null,
      holders: null,
      source: "dexscreener",
      isStale: false,
      fetchedAt: new Date().toISOString(),
    };
  }

  const best = pairs.reduce((a: any, b: any) =>
    (positiveNumber(b?.liquidity?.usd) ?? 0) >
    (positiveNumber(a?.liquidity?.usd) ?? 0)
      ? b
      : a
  );
  return {
    symbol: best?.baseToken?.symbol ?? null,
    name: best?.baseToken?.name ?? null,
    // Preserve the existing strategy behavior: FDV is preferred when present.
    marketCap: positiveNumber(best?.fdv) ?? positiveNumber(best?.marketCap),
    liquidityUsd: positiveNumber(best?.liquidity?.usd),
    holders: null,
    source: "dexscreener",
    isStale: false,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Keyless GeckoTerminal fallback. The token endpoint returns token metadata and
 * can include top-pool reserves, allowing us to recover market cap/liquidity
 * without relying on DexScreener during a temporary 429 window.
 */
export async function fetchGeckoTerminalData(
  tokenMint: string
): Promise<TokenMarketData> {
  const data = await fetchJsonWithBackoff(
    "GeckoTerminal",
    `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${encodeURIComponent(tokenMint)}?include=top_pools`,
    2
  );
  const attributes = data?.data?.attributes ?? null;
  if (!attributes) {
    return {
      symbol: null,
      name: null,
      marketCap: null,
      liquidityUsd: null,
      holders: null,
      source: "geckoterminal",
      isStale: false,
      fetchedAt: new Date().toISOString(),
    };
  }

  const includedPools = Array.isArray(data?.included)
    ? data.included.filter((item: any) => item?.type === "pool")
    : [];
  const topPoolLiquidity = includedPools.reduce(
    (largest: number | null, pool: any) => {
      const reserve = positiveNumber(pool?.attributes?.reserve_in_usd);
      return reserve !== null && (largest === null || reserve > largest)
        ? reserve
        : largest;
    },
    null as number | null
  );

  return {
    symbol: attributes.symbol ?? null,
    name: attributes.name ?? null,
    marketCap:
      positiveNumber(attributes.market_cap_usd) ??
      positiveNumber(attributes.fdv_usd),
    liquidityUsd:
      topPoolLiquidity ?? positiveNumber(attributes.total_reserve_in_usd),
    holders: null,
    source: "geckoterminal",
    isStale: false,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Optional: Birdeye fills in holder counts if BIRDEYE_API_KEY is set.
 * Free market data is used regardless; this only adds holders on top.
 */
export async function fetchBirdeyeHolders(
  tokenMint: string
): Promise<number | null> {
  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetchWithTimeout(
      `https://public-api.birdeye.so/defi/token_overview?address=${encodeURIComponent(tokenMint)}`,
      { headers: { "X-API-KEY": apiKey, "x-chain": "solana" } }
    );
    if (!res.ok) throw new Error(`Birdeye ${res.status}`);
    const data: any = await res.json();
    return positiveNumber(data?.data?.holder);
  } catch (err) {
    console.error("Birdeye fetch failed for", tokenMint, err);
    return null;
  }
}

async function loadTokenMarketData(tokenMint: string): Promise<TokenMarketData> {
  const failures: string[] = [];
  let hadProviderFailure = false;

  try {
    const dex = await fetchDexScreenerData(tokenMint);
    if (isUsableMarketData(dex)) {
      const holders = await fetchBirdeyeHolders(tokenMint);
      return { ...dex, holders: holders ?? dex.holders };
    }
    failures.push("DexScreener returned no usable market data");
  } catch (error) {
    hadProviderFailure = true;
    failures.push(formatError(error));
    console.warn(
      `[token-data] DexScreener failed for ${tokenMint.slice(0, 6)}; trying GeckoTerminal: ${formatError(error)}`
    );
  }

  try {
    const gecko = await fetchGeckoTerminalData(tokenMint);
    if (isUsableMarketData(gecko)) {
      const holders = await fetchBirdeyeHolders(tokenMint);
      console.log(
        `[token-data] GeckoTerminal fallback used for ${tokenMint.slice(0, 6)}`
      );
      return { ...gecko, holders: holders ?? gecko.holders };
    }
    failures.push("GeckoTerminal returned no usable market data");
  } catch (error) {
    hadProviderFailure = true;
    failures.push(formatError(error));
  }

  const stale = hadProviderFailure ? staleCachedValue(tokenMint) : null;
  if (stale) {
    console.warn(
      `[token-data] using short stale cache for ${tokenMint.slice(0, 6)} after provider failure`
    );
    return stale;
  }

  throw new MarketDataUnavailableError(
    `market data unavailable for ${tokenMint.slice(0, 6)} (${failures.join("; ")})`,
    hadProviderFailure
      ? TOKEN_DATA_FAILURE_COOLDOWN_MS
      : TOKEN_DATA_NEGATIVE_CACHE_TTL_MS
  );
}

export async function fetchTokenMarketData(
  tokenMint: string
): Promise<TokenMarketData> {
  const now = Date.now();
  const cached = tokenDataCache.get(tokenMint);

  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const cachedFailure = tokenDataFailureCache.get(tokenMint);
  if (cachedFailure && cachedFailure.expiresAt > now) {
    throw new MarketDataUnavailableError(cachedFailure.message);
  }

  const existingRequest = tokenDataInFlight.get(tokenMint);
  if (existingRequest) return existingRequest;

  const request = loadTokenMarketData(tokenMint)
    .then((value) => {
      tokenDataFailureCache.delete(tokenMint);
      if (value.source === "stale_cache") return value;

      tokenDataCache.set(tokenMint, {
        value,
        expiresAt: Date.now() + TOKEN_DATA_CACHE_TTL_MS,
        staleUntil: Date.now() + TOKEN_DATA_STALE_CACHE_TTL_MS,
      });
      pruneExpiredCache(Date.now());
      return value;
    })
    .catch((error: unknown) => {
      const message = formatError(error);
      const cacheTtlMs =
        error instanceof MarketDataUnavailableError
          ? error.cacheTtlMs
          : TOKEN_DATA_FAILURE_COOLDOWN_MS;
      tokenDataFailureCache.set(tokenMint, {
        message,
        expiresAt: Date.now() + cacheTtlMs,
      });
      pruneExpiredCache(Date.now());
      throw error;
    })
    .finally(() => {
      tokenDataInFlight.delete(tokenMint);
    });

  tokenDataInFlight.set(tokenMint, request);
  return request;
}
