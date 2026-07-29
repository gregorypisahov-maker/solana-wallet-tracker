// Process-wide guard for GeckoTerminal discovery requests.
// marketDiscoveryAgent asks for several Gecko feeds concurrently; this wrapper
// serializes only GeckoTerminal traffic and retries bounded 429/5xx responses.

const originalFetch = globalThis.fetch.bind(globalThis);
const GECKO_HOST = "api.geckoterminal.com";
const MIN_INTERVAL_MS = Math.max(
  1_000,
  Number(process.env.GECKO_MIN_INTERVAL_MS ?? 2_500)
);
const MAX_RETRIES = Math.max(
  0,
  Math.min(5, Number(process.env.GECKO_MAX_RETRIES ?? 3))
);
const BASE_BACKOFF_MS = Math.max(
  1_000,
  Number(process.env.GECKO_BACKOFF_MS ?? 5_000)
);

let queueTail: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestUrl(input: RequestInfo | URL): URL | null {
  try {
    if (input instanceof Request) return new URL(input.url);
    return new URL(String(input));
  } catch {
    return null;
  }
}

function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);

  const dateMs = Date.parse(raw);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

async function waitForTurn(): Promise<void> {
  const previous = queueTail;
  let release!: () => void;
  queueTail = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  const waitMs = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastRequestAt));
  if (waitMs > 0) await sleep(waitMs);
  lastRequestAt = Date.now();
  release();
}

async function guardedGeckoFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  let lastResponse: Response | null = null;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    await waitForTurn();

    try {
      const response = await originalFetch(input, init);
      lastResponse = response;

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === MAX_RETRIES) return response;

      // Drain the body before retrying so the underlying connection can be reused.
      try {
        await response.arrayBuffer();
      } catch {
        // A failed drain is harmless; the next attempt uses a fresh request.
      }

      const headerDelay = retryAfterMs(response);
      const exponential = BASE_BACKOFF_MS * 2 ** attempt;
      const jitter = Math.floor(Math.random() * 1_000);
      const delay = Math.max(headerDelay ?? 0, exponential + jitter);
      console.warn(
        `[gecko-fetch-guard] HTTP ${response.status}; retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`
      );
      await sleep(delay);
    } catch (error) {
      lastError = error;
      if (attempt === MAX_RETRIES) throw error;

      const delay = BASE_BACKOFF_MS * 2 ** attempt + Math.floor(Math.random() * 1_000);
      console.warn(
        `[gecko-fetch-guard] network failure; retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`,
        error
      );
      await sleep(delay);
    }
  }

  if (lastResponse) return lastResponse;
  throw lastError instanceof Error ? lastError : new Error("gecko_fetch_failed");
}

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = requestUrl(input);
  if (!url || url.hostname !== GECKO_HOST) return originalFetch(input, init);
  return guardedGeckoFetch(input, init);
}) as typeof fetch;

console.log(
  `[gecko-fetch-guard] active; minInterval=${MIN_INTERVAL_MS}ms retries=${MAX_RETRIES}`
);
