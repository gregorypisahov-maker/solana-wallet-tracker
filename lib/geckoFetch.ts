const originalFetch = globalThis.fetch.bind(globalThis);
const GECKO_HOST = "api.geckoterminal.com";

// Conservative defaults for GeckoTerminal's public API. These can still be
// overridden in Railway, but the bot is safe even when no variables are set.
const MIN_INTERVAL_MS = Math.max(5_000, Number(process.env.GECKO_FETCH_MIN_INTERVAL_MS ?? 10_000));
const CACHE_MS = Math.max(60_000, Number(process.env.GECKO_FETCH_CACHE_MS ?? 5 * 60_000));
const STALE_CACHE_MS = Math.max(CACHE_MS, Number(process.env.GECKO_FETCH_STALE_CACHE_MS ?? 15 * 60_000));
const MAX_RETRIES = Math.max(0, Math.min(1, Number(process.env.GECKO_FETCH_MAX_RETRIES ?? 0)));
const COOLDOWN_MS = Math.max(60_000, Number(process.env.GECKO_FETCH_COOLDOWN_MS ?? 5 * 60_000));
const REQUEST_TIMEOUT_MS = Math.max(3_000, Number(process.env.GECKO_FETCH_TIMEOUT_MS ?? 12_000));
const TOKEN_BUCKET_CAPACITY = Math.max(1, Math.min(3, Number(process.env.GECKO_TOKEN_BUCKET_CAPACITY ?? 1)));

class GeckoHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "GeckoHttpError";
  }
}

export class GeckoCooldownError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`GeckoTerminal cooling down for ${retryAfterMs}ms`);
    this.name = "GeckoCooldownError";
  }
}

type CacheRow = { expiresAt: number; staleUntil: number; value: unknown };
const cache = new Map<string, CacheRow>();
const inFlight = new Map<string, Promise<unknown>>();
let queueTail: Promise<void> = Promise.resolve();
let bucketTokens = TOKEN_BUCKET_CAPACITY;
let bucketUpdatedAt = Date.now();
let cooldownUntil = 0;
let lastCooldownLogAt = 0;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function getGeckoCooldownRemainingMs(): number {
  return Math.max(0, cooldownUntil - Date.now());
}

function refillBucket(): void {
  const now = Date.now();
  const elapsed = now - bucketUpdatedAt;
  if (elapsed < MIN_INTERVAL_MS) return;
  const tokens = Math.floor(elapsed / MIN_INTERVAL_MS);
  bucketTokens = Math.min(TOKEN_BUCKET_CAPACITY, bucketTokens + tokens);
  bucketUpdatedAt += tokens * MIN_INTERVAL_MS;
}

async function takeToken(): Promise<void> {
  while (true) {
    const cooldownRemainingMs = getGeckoCooldownRemainingMs();
    if (cooldownRemainingMs > 0) throw new GeckoCooldownError(cooldownRemainingMs);

    refillBucket();
    if (bucketTokens >= 1) {
      bucketTokens -= 1;
      return;
    }
    await sleep(Math.max(25, MIN_INTERVAL_MS - (Date.now() - bucketUpdatedAt)));
  }
}

async function waitForTurn(): Promise<void> {
  const previous = queueTail;
  let release!: () => void;
  queueTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    // Never leave requests sleeping in the queue for the full host cooldown.
    // The caller can immediately use stale cache or another provider instead.
    const cooldownRemainingMs = getGeckoCooldownRemainingMs();
    if (cooldownRemainingMs > 0) throw new GeckoCooldownError(cooldownRemainingMs);
    await takeToken();
  } finally {
    release();
  }
}

function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
}

function enterCooldown(response?: Response): number {
  const duration = Math.max(COOLDOWN_MS, response ? (retryAfterMs(response) ?? 0) : 0);
  cooldownUntil = Math.max(cooldownUntil, Date.now() + duration);
  if (Date.now() - lastCooldownLogAt > 30_000) {
    lastCooldownLogAt = Date.now();
    console.warn(`[gecko-gateway] rate limited; global cooldown ${Math.ceil(duration / 1000)}s`);
  }
  return duration;
}

async function requestJson(url: string): Promise<unknown> {
  const cooldownRemainingMs = getGeckoCooldownRemainingMs();
  if (cooldownRemainingMs > 0) {
    throw new GeckoCooldownError(cooldownRemainingMs);
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    await waitForTurn();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await originalFetch(url, {
        cache: "no-store",
        signal: controller.signal,
        headers: {
          Accept: "application/vnd.api+json;version=20230302",
          "User-Agent": "solana-wallet-tracker/1.0",
        },
      });
      if (response.ok) return await response.json();

      const body = (await response.text()).slice(0, 160).replace(/\s+/g, " ");

      // A 429 is host-wide, not request-specific. Stop immediately instead of
      // multiplying traffic with retries, and let callers use stale cache/fallbacks.
      if (response.status === 429) {
        const duration = enterCooldown(response);
        throw new GeckoCooldownError(duration);
      }

      const retryable = response.status >= 500;
      if (!retryable || attempt === MAX_RETRIES) {
        throw new GeckoHttpError(response.status, `GeckoTerminal ${response.status}${body ? `: ${body}` : ""}`);
      }

      const delay = 5_000 * 2 ** attempt + Math.floor(Math.random() * 1_000);
      console.warn(`[gecko-gateway] HTTP ${response.status}; retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
      await sleep(delay);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error("GeckoTerminal retry loop exhausted");
}

export async function geckoFetchJson<T = any>(url: string): Promise<T> {
  const now = Date.now();
  const cached = cache.get(url);
  if (cached && cached.expiresAt > now) return cached.value as T;

  // During a global cooldown, return a recent stale value instead of creating
  // more traffic or failing the whole trading cycle.
  const cooldownRemainingMs = getGeckoCooldownRemainingMs();
  if (cooldownRemainingMs > 0) {
    if (cached && cached.staleUntil > now) return cached.value as T;
    throw new GeckoCooldownError(cooldownRemainingMs);
  }

  const existing = inFlight.get(url);
  if (existing) return existing as Promise<T>;

  const request = requestJson(url)
    .then((value) => {
      cache.set(url, {
        value,
        expiresAt: Date.now() + CACHE_MS,
        staleUntil: Date.now() + STALE_CACHE_MS,
      });
      return value;
    })
    .catch((error) => {
      const fallback = cache.get(url);
      if (fallback && fallback.staleUntil > Date.now()) {
        console.warn("[gecko-gateway] serving stale cache after upstream failure");
        return fallback.value;
      }
      throw error;
    })
    .finally(() => inFlight.delete(url));

  inFlight.set(url, request);
  return request as Promise<T>;
}

function requestUrl(input: RequestInfo | URL): URL | null {
  try {
    if (input instanceof Request) return new URL(input.url);
    return new URL(String(input));
  } catch {
    return null;
  }
}

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = requestUrl(input);
  if (!url || url.hostname !== GECKO_HOST) return originalFetch(input, init);
  return geckoFetchJson(url.toString()).then((value) =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
}) as typeof fetch;

console.log(
  `[gecko-gateway] active; minInterval=${MIN_INTERVAL_MS}ms cache=${CACHE_MS}ms ` +
    `staleCache=${STALE_CACHE_MS}ms retries=${MAX_RETRIES} cooldown=${COOLDOWN_MS}ms`
);