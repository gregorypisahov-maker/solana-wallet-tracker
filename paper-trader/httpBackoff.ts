export class HttpResponseError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = "HttpResponseError";
  }
}

export class RateLimitGate {
  private blockedUntilMs = 0;

  defer(delayMs: number, nowMs = Date.now()): void {
    this.blockedUntilMs = Math.max(this.blockedUntilMs, nowMs + Math.max(0, delayMs));
  }

  remainingMs(nowMs = Date.now()): number {
    return Math.max(0, this.blockedUntilMs - nowMs);
  }
}

export type FetchJsonBackoffOptions = {
  headers?: HeadersInit;
  timeoutMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maximumDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  randomImpl?: () => number;
  rateLimitGate?: RateLimitGate;
};

export function parseRetryAfterMs(
  value: string | null,
  nowMs = Date.now()
): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - nowMs) : null;
}

export function exponentialBackoffMs(
  retryIndex: number,
  baseDelayMs: number,
  maximumDelayMs: number,
  randomValue = Math.random()
): number {
  const exponential = baseDelayMs * (2 ** Math.max(0, retryIndex));
  const jitter = Math.max(0, Math.min(1, randomValue)) * baseDelayMs;
  return Math.min(maximumDelayMs, Math.round(exponential + jitter));
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function fetchJsonWithBackoff(
  url: string,
  options: FetchJsonBackoffOptions = {}
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl ?? defaultSleep;
  const randomImpl = options.randomImpl ?? Math.random;
  const timeoutMs = options.timeoutMs ?? 12_000;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const baseDelayMs = Math.max(100, options.baseDelayMs ?? 1_000);
  const maximumDelayMs = Math.max(baseDelayMs, options.maximumDelayMs ?? 15_000);
  const gatedDelay = options.rateLimitGate?.remainingMs() ?? 0;
  if (gatedDelay > 0) await sleepImpl(gatedDelay);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        cache: "no-store",
        headers: options.headers,
        signal: controller.signal,
      });
      if (response.ok) return await response.json();

      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      const body = (await response.text()).slice(0, 160).replace(/\s+/g, " ");
      const error = new HttpResponseError(
        response.status,
        `${response.status} ${response.statusText}${body ? `: ${body}` : ""}`,
        retryAfterMs
      );
      const retryable = response.status === 429 || response.status >= 500;
      const retryIndex = attempt;
      const computedDelay = exponentialBackoffMs(
        retryIndex,
        baseDelayMs,
        maximumDelayMs,
        randomImpl()
      );
      const delayMs = Math.min(
        maximumDelayMs,
        Math.max(computedDelay, retryAfterMs ?? 0)
      );

      if (response.status === 429) options.rateLimitGate?.defer(delayMs);
      if (!retryable || attempt === maxAttempts - 1) throw error;
      await sleepImpl(delayMs);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("fetch retry loop exhausted");
}
