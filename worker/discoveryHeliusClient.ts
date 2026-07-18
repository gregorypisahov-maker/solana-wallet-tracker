const MIN_INTERVAL_MS = 200;
const NON_429_RETRY_DELAYS_MS = [2_000, 4_000, 8_000];
const MAX_429_BACKOFF_MS = 60_000;

export class HeliusHttpError extends Error {
  constructor(
    public readonly status: number | null,
    message: string
  ) {
    super(message);
    this.name = "HeliusHttpError";
  }
}

type Stats = {
  heliusCallsMade: number;
  rateLimitCount: number;
};

let stats: Stats = {
  heliusCallsMade: 0,
  rateLimitCount: 0,
};

let queueTail: Promise<void> = Promise.resolve();
let nextAllowedAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireSlot(): Promise<void> {
  let release!: () => void;
  const previous = queueTail;
  queueTail = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    const waitMs = Math.max(0, nextAllowedAt - Date.now());
    if (waitMs > 0) await sleep(waitMs);
    nextAllowedAt = Date.now() + MIN_INTERVAL_MS;
  } finally {
    release();
  }
}

async function fetchOnce(url: string, timeoutMs: number): Promise<unknown> {
  await acquireSlot();
  stats.heliusCallsMade += 1;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 160).replace(/\s+/g, " ");
      throw new HeliusHttpError(
        response.status,
        `HTTP ${response.status}${body ? `: ${body}` : ""}`
      );
    }
    return await response.json();
  } catch (error) {
    if (error instanceof HeliusHttpError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new HeliusHttpError(null, `Helius request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function heliusFetchJson(
  url: string,
  timeoutMs = 15_000
): Promise<unknown> {
  let non429Failures = 0;
  let rateLimitAttempt = 0;

  while (true) {
    try {
      return await fetchOnce(url, timeoutMs);
    } catch (error) {
      if (error instanceof HeliusHttpError && error.status === 429) {
        stats.rateLimitCount += 1;
        const delayMs = Math.min(
          MAX_429_BACKOFF_MS,
          2_000 * 2 ** rateLimitAttempt
        );
        rateLimitAttempt += 1;
        await sleep(delayMs);
        continue;
      }

      const retryable =
        error instanceof HeliusHttpError &&
        (error.status == null || error.status >= 500);

      if (!retryable || non429Failures >= NON_429_RETRY_DELAYS_MS.length) {
        throw error;
      }

      const delayMs = NON_429_RETRY_DELAYS_MS[non429Failures];
      non429Failures += 1;
      await sleep(delayMs);
    }
  }
}

export function resetDiscoveryHeliusStats(): void {
  stats = {
    heliusCallsMade: 0,
    rateLimitCount: 0,
  };
}

export function getDiscoveryHeliusStats(): Readonly<Stats> {
  return { ...stats };
}
