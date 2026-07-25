export enum FetchPriority {
  LOW = 0,
  NORMAL = 1,
  HIGH = 2,
}

type FetchJsonOptions = {
  priority?: FetchPriority;
  timeoutMs?: number;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  cacheTtlMs?: number;
};

type QueueItem = {
  key: string;
  url: string;
  options: FetchJsonOptions;
  priority: FetchPriority;
  sequence: number;
  resolve: (value: any) => void;
  reject: (error: unknown) => void;
};

type HostStats = {
  requests: number;
  cacheHits: number;
  singleFlightHits: number;
  retries: number;
  rate429: number;
  failures: number;
  maxDepth: number;
};

type HostState = {
  queue: QueueItem[];
  inFlight: number;
  lastStartedAt: number;
  timer: NodeJS.Timeout | null;
  adaptiveUntil: number;
  consecutive429: number;
  stats: HostStats;
};

const truthy = (value: string | undefined, fallback: boolean): boolean => {
  if (value == null || value.trim() === "") return fallback;
  return !["0", "false", "off", "no"].includes(value.trim().toLowerCase());
};

const envNumber = (name: string, fallback: number, minimum = 0): number => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
};

const ENABLED = truthy(process.env.FETCH_QUEUE_ENABLED, true);
const MAX_CONCURRENT = Math.max(1, Math.floor(envNumber("FETCH_MAX_CONCURRENT_PER_HOST", 2, 1)));
const MIN_INTERVAL_MS = envNumber("FETCH_MIN_INTERVAL_MS", 350, 0);
const MAX_RETRIES = Math.floor(envNumber("FETCH_MAX_RETRIES", 3, 0));
const BACKOFF_BASE_MS = envNumber("FETCH_BACKOFF_BASE_MS", 500, 1);
const BACKOFF_MAX_MS = envNumber("FETCH_BACKOFF_MAX_MS", 8_000, 1);
const CACHE_TTL_MS = envNumber("FETCH_CACHE_TTL_MS", 8_000, 0);
const ADAPTIVE_MULTIPLIER = envNumber("FETCH_ADAPTIVE_429_MULTIPLIER", 2, 1);
const ADAPTIVE_COOLDOWN_MS = envNumber("FETCH_ADAPTIVE_COOLDOWN_MS", 60_000, 1);

const hosts = new Map<string, HostState>();
const singleFlight = new Map<string, Promise<any>>();
const cache = new Map<string, { expiresAt: number; value: any }>();
let sequence = 0;

function emptyStats(): HostStats {
  return { requests: 0, cacheHits: 0, singleFlightHits: 0, retries: 0, rate429: 0, failures: 0, maxDepth: 0 };
}

function stateFor(host: string): HostState {
  let state = hosts.get(host);
  if (!state) {
    state = { queue: [], inFlight: 0, lastStartedAt: 0, timer: null, adaptiveUntil: 0, consecutive429: 0, stats: emptyStats() };
    hosts.set(host, state);
  }
  return state;
}

function requestKey(url: string, options: FetchJsonOptions): string {
  return `${(options.method ?? "GET").toUpperCase()} ${url} ${options.body ?? ""}`;
}

function effectiveInterval(state: HostState): number {
  return Date.now() < state.adaptiveUntil ? MIN_INTERVAL_MS * ADAPTIVE_MULTIPLIER : MIN_INTERVAL_MS;
}

function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function schedule(host: string): void {
  const state = stateFor(host);
  if (state.timer || state.inFlight >= MAX_CONCURRENT || state.queue.length === 0) return;
  const wait = Math.max(0, effectiveInterval(state) - (Date.now() - state.lastStartedAt));
  state.timer = setTimeout(() => {
    state.timer = null;
    pump(host);
  }, wait);
}

function pump(host: string): void {
  const state = stateFor(host);
  while (state.inFlight < MAX_CONCURRENT && state.queue.length > 0) {
    const wait = effectiveInterval(state) - (Date.now() - state.lastStartedAt);
    if (wait > 0) {
      schedule(host);
      return;
    }
    state.queue.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
    const item = state.queue.shift()!;
    state.inFlight += 1;
    state.lastStartedAt = Date.now();
    void execute(host, state, item).finally(() => {
      state.inFlight -= 1;
      schedule(host);
    });
  }
}

async function execute(host: string, state: HostState, item: QueueItem): Promise<void> {
  try {
    const value = await requestWithRetry(host, state, item.url, item.options);
    item.resolve(value);
  } catch (error) {
    state.stats.failures += 1;
    item.reject(error);
  }
}

async function requestWithRetry(host: string, state: HostState, url: string, options: FetchJsonOptions): Promise<any> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 12_000);
    let response: Response | null = null;
    try {
      state.stats.requests += 1;
      response = await fetch(url, {
        method: options.method ?? "GET",
        body: options.body,
        cache: "no-store",
        signal: controller.signal,
        headers: options.headers,
      });
      if (response.ok) {
        state.consecutive429 = 0;
        return await response.json();
      }
      const error = new Error(`${response.status} ${response.statusText}`);
      lastError = error;
      if (response.status === 429) {
        state.stats.rate429 += 1;
        state.consecutive429 += 1;
        state.adaptiveUntil = Date.now() + ADAPTIVE_COOLDOWN_MS;
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= MAX_RETRIES) throw error;
      state.stats.retries += 1;
      const headerDelay = retryAfterMs(response);
      const cap = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * (2 ** attempt));
      await sleep(headerDelay ?? Math.random() * cap);
    } catch (error) {
      lastError = error;
      if (response && response.status < 500 && response.status !== 429) throw error;
      if (attempt >= MAX_RETRIES) throw error;
      state.stats.retries += 1;
      const cap = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * (2 ** attempt));
      await sleep(Math.random() * cap);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function fetchJsonQueued(url: string, options: FetchJsonOptions = {}): Promise<any> {
  if (!ENABLED) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 12_000);
    try {
      const response = await fetch(url, { method: options.method ?? "GET", body: options.body, cache: "no-store", signal: controller.signal, headers: options.headers });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  const method = (options.method ?? "GET").toUpperCase();
  const key = requestKey(url, options);
  const host = new URL(url).host;
  const state = stateFor(host);
  const cached = method === "GET" ? cache.get(url) : undefined;
  if (cached && cached.expiresAt > Date.now()) {
    state.stats.cacheHits += 1;
    return cached.value;
  }
  if (cached) cache.delete(url);

  const existing = singleFlight.get(key);
  if (existing) {
    state.stats.singleFlightHits += 1;
    return existing;
  }

  const promise = new Promise<any>((resolve, reject) => {
    state.queue.push({ key, url, options, priority: options.priority ?? FetchPriority.NORMAL, sequence: sequence++, resolve, reject });
    state.stats.maxDepth = Math.max(state.stats.maxDepth, state.queue.length);
    schedule(host);
  }).then((value) => {
    if (method === "GET") cache.set(url, { expiresAt: Date.now() + (options.cacheTtlMs ?? CACHE_TTL_MS), value });
    return value;
  }).finally(() => {
    singleFlight.delete(key);
  });

  singleFlight.set(key, promise);
  return promise;
}

export function getFetchQueueDepth(host?: string): number {
  if (host) {
    const state = hosts.get(host);
    return state ? state.queue.length + state.inFlight : 0;
  }
  let total = 0;
  for (const state of hosts.values()) total += state.queue.length + state.inFlight;
  return total;
}

export function logAndResetFetchQueueStats(): void {
  if (!ENABLED) return;
  for (const [host, state] of hosts.entries()) {
    const s = state.stats;
    console.log(`[fetch-queue] host=${host} req=${s.requests} cacheHit=${s.cacheHits} singleFlight=${s.singleFlightHits} 429=${s.rate429} retries=${s.retries} fail=${s.failures} maxDepth=${s.maxDepth} minIntervalMs=${effectiveInterval(state)}`);
    state.stats = emptyStats();
  }
}

export function getFetchQueueStats(): Record<string, HostStats & { depth: number; minIntervalMs: number }> {
  return Object.fromEntries([...hosts.entries()].map(([host, state]) => [host, { ...state.stats, depth: state.queue.length + state.inFlight, minIntervalMs: effectiveInterval(state) }]));
}
