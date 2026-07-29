const MIN_INTERVAL_MS = Math.max(1_000, Number(process.env.GECKO_FETCH_MIN_INTERVAL_MS ?? 2_500));
const CACHE_MS = Math.max(0, Number(process.env.GECKO_FETCH_CACHE_MS ?? 20_000));
const MAX_RETRIES = Math.max(0, Math.min(5, Number(process.env.GECKO_FETCH_MAX_RETRIES ?? 3)));
const COOLDOWN_MS = Math.max(10_000, Number(process.env.GECKO_FETCH_COOLDOWN_MS ?? 300_000));
const REQUEST_TIMEOUT_MS = Math.max(3_000, Number(process.env.GECKO_FETCH_TIMEOUT_MS ?? 12_000));

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

type CacheRow = { expiresAt: number; value: unknown };
const cache = new Map<string, CacheRow>();
const inFlight = new Map<string, Promise<unknown>>();
let queueTail: Promise<void> = Promise.resolve();
let lastRequestAt = 0;
let cooldownUntil = 0;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitForTurn(): Promise<void> {
  const previous = queueTail;
  let release!: () => void;
  queueTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  const waitMs = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastRequestAt));
  if (waitMs > 0) await sleep(waitMs);
  lastRequestAt = Date.now();
  release();
}

function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
}

async function requestJson(url: string): Promise<unknown> {
  if (cooldownUntil > Date.now()) throw new GeckoCooldownError(cooldownUntil - Date.now());

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    await waitForTurn();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        cache: "no-store",
        signal: controller.signal,
        headers: {
          Accept: "application/vnd.api+json;version=20230302",
          "User-Agent": "solana-wallet-tracker/1.0",
        },
      });
      if (response.ok) return await response.json();

      const body = (await response.text()).slice(0, 160).replace(/\s+/g, " ");
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === MAX_RETRIES) {
        if (response.status === 429) cooldownUntil = Date.now() + COOLDOWN_MS;
        throw new GeckoHttpError(response.status, `GeckoTerminal ${response.status}${body ? `: ${body}` : ""}`);
      }

      const delay = Math.max(
        retryAfterMs(response) ?? 0,
        5_000 * 2 ** attempt + Math.floor(Math.random() * 1_000)
      );
      console.warn(`[gecko-gateway] HTTP ${response.status}; retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
      await sleep(delay);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error("GeckoTerminal retry loop exhausted");
}

export async function geckoFetchJson<T = any>(url: string): Promise<T> {
  const cached = cache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.value as T;

  const existing = inFlight.get(url);
  if (existing) return existing as Promise<T>;

  const request = requestJson(url)
    .then((value) => {
      if (CACHE_MS > 0) cache.set(url, { value, expiresAt: Date.now() + CACHE_MS });
      return value;
    })
    .finally(() => inFlight.delete(url));

  inFlight.set(url, request);
  return request as Promise<T>;
}

console.log(`[gecko-gateway] active; minInterval=${MIN_INTERVAL_MS}ms cache=${CACHE_MS}ms retries=${MAX_RETRIES}`);
