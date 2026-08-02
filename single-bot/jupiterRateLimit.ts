type FetchInit = RequestInit & { headers?: HeadersInit };

const JUPITER_API_KEY = process.env.JUPITER_API_KEY?.trim() || null;
const MIN_INTERVAL_MS = positiveInt(
  "JUPITER_MIN_INTERVAL_MS",
  JUPITER_API_KEY ? 1_100 : 2_200
);
const MAX_RETRIES = positiveInt("JUPITER_MAX_RETRIES", 4);

let queue: Promise<void> = Promise.resolve();
let lastRequestStartedAt = 0;

function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  const retryAfterSeconds = retryAfter == null ? NaN : Number(retryAfter);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.max(1_000, retryAfterSeconds * 1_000) + 250;
  }
  return Math.min(30_000, 2_000 * (2 ** attempt)) + 250;
}

async function waitForSlot(): Promise<void> {
  const elapsed = Date.now() - lastRequestStartedAt;
  const waitMs = Math.max(0, MIN_INTERVAL_MS - elapsed);
  if (waitMs > 0) await sleep(waitMs);
  lastRequestStartedAt = Date.now();
}

/**
 * Shared Jupiter request queue for the market scanner, price checks, and quotes.
 * This prevents the keyless/free API from receiving request bursts and retries 429s
 * with exponential backoff without changing any trading rules.
 */
export async function jupiterFetchJson(url: string, init: FetchInit = {}): Promise<any> {
  let release!: () => void;
  const previous = queue;
  queue = new Promise<void>((resolve) => { release = resolve; });
  await previous;

  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      await waitForSlot();
      const response = await fetch(url, {
        ...init,
        headers: {
          accept: "application/json",
          ...(JUPITER_API_KEY ? { "x-api-key": JUPITER_API_KEY } : {}),
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(12_000),
      });
      const text = await response.text();

      if (response.status === 429 && attempt < MAX_RETRIES) {
        const delayMs = retryDelayMs(response, attempt);
        console.warn(`[single-market-bot] Jupiter 429; retrying in ${delayMs}ms attempt=${attempt + 1}`);
        await sleep(delayMs);
        continue;
      }

      if (!response.ok) {
        throw new Error(`jupiter_http_${response.status}: ${text.slice(0, 500)}`);
      }
      return text ? JSON.parse(text) : {};
    }
    throw new Error("jupiter_rate_limit_retries_exhausted");
  } finally {
    release();
  }
}
