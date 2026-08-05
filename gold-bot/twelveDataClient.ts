import type {
  GoldCandle,
  GoldInstrument,
  GoldMarketSnapshot,
  GoldQuote,
} from "./types";

type TwelveDataTimeSeriesResponse = {
  meta?: {
    symbol?: string;
    name?: string;
    currency?: string;
    exchange?: string;
    type?: string;
    interval?: string;
    exchange_timezone?: string;
  };
  values?: Array<{
    datetime?: string;
    open?: string;
    high?: string;
    low?: string;
    close?: string;
  }>;
  status?: string;
  code?: number;
  message?: string;
};

type FetchLike = typeof fetch;

const CACHE_MS = 5_000;

function intervalToTwelveData(granularity: string): { apiInterval: string; milliseconds: number } {
  if (granularity === "M15") {
    return { apiInterval: "15min", milliseconds: 15 * 60 * 1_000 };
  }
  throw new Error(`Unsupported Gold granularity ${granularity}; expected M15`);
}

function parseUtcDateTime(value: string): string {
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)
    ? value
    : `${value.replace(" ", "T")}Z`;
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Twelve Data returned invalid datetime ${value}`);
  }
  return new Date(timestamp).toISOString();
}

function finiteNumber(value: string | undefined, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Twelve Data returned invalid ${field}`);
  }
  return parsed;
}

export class TwelveDataMarketDataClient {
  private readonly apiKey: string;
  private readonly symbol: string;
  private readonly syntheticSpreadUsd: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private cachedSnapshot: { at: number; value: GoldMarketSnapshot } | null = null;

  constructor(args: {
    apiKey: string;
    symbol: string;
    syntheticSpreadUsd: number;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
    now?: () => Date;
  }) {
    this.apiKey = args.apiKey;
    this.symbol = args.symbol;
    this.syntheticSpreadUsd = args.syntheticSpreadUsd;
    this.timeoutMs = args.timeoutMs ?? 12_000;
    this.fetchImpl = args.fetchImpl ?? fetch;
    this.now = args.now ?? (() => new Date());
  }

  private async request(params: URLSearchParams): Promise<TwelveDataTimeSeriesResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(
        `https://api.twelvedata.com/time_series?${params.toString()}`,
        {
          method: "GET",
          headers: {
            Authorization: `apikey ${this.apiKey}`,
            Accept: "application/json",
            "User-Agent": "gregory-xauusd-paper-bot/2.0",
          },
          signal: controller.signal,
          cache: "no-store",
        },
      );

      const text = await response.text();
      let payload: TwelveDataTimeSeriesResponse;
      try {
        payload = JSON.parse(text) as TwelveDataTimeSeriesResponse;
      } catch {
        throw new Error(`Twelve Data returned non-JSON data: ${text.slice(0, 300)}`);
      }

      if (!response.ok || payload.status?.toLowerCase() === "error") {
        const detail = payload.message ?? text.slice(0, 500);
        if (response.status === 429 || payload.code === 429) {
          throw new Error(`Twelve Data rate limit reached: ${detail}`);
        }
        throw new Error(
          `Twelve Data ${payload.code ?? response.status} ${response.statusText}: ${detail}`,
        );
      }

      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getSnapshot(granularity: string, count = 300): Promise<GoldMarketSnapshot> {
    const now = this.now();
    const nowMs = now.getTime();
    if (this.cachedSnapshot && nowMs - this.cachedSnapshot.at < CACHE_MS) {
      return this.cachedSnapshot.value;
    }

    const { apiInterval, milliseconds } = intervalToTwelveData(granularity);
    const params = new URLSearchParams({
      symbol: this.symbol,
      interval: apiInterval,
      outputsize: String(Math.min(Math.max(count, 80), 5_000)),
      timezone: "UTC",
      format: "JSON",
      dp: "5",
    });
    const response = await this.request(params);

    const candles: GoldCandle[] = (response.values ?? []).flatMap((value) => {
      if (!value.datetime) return [];
      const time = parseUtcDateTime(value.datetime);
      const open = finiteNumber(value.open, "open");
      const high = finiteNumber(value.high, "high");
      const low = finiteNumber(value.low, "low");
      const close = finiteNumber(value.close, "close");
      if (high < low || open <= 0 || high <= 0 || low <= 0 || close <= 0) {
        return [];
      }
      const openMs = Date.parse(time);
      return [{
        time,
        open,
        high,
        low,
        close,
        complete: openMs + milliseconds + 5_000 <= nowMs,
      }];
    }).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));

    const latest = candles[candles.length - 1];
    if (!latest) {
      throw new Error(`Twelve Data returned no usable ${apiInterval} candles for ${this.symbol}`);
    }

    const spread = this.syntheticSpreadUsd;
    const midpoint = latest.close;
    const quote: GoldQuote = {
      time: latest.time,
      bid: midpoint - spread / 2,
      ask: midpoint + spread / 2,
      status: "tradeable",
    };
    if (quote.bid <= 0 || quote.ask <= quote.bid) {
      throw new Error("Synthetic Gold spread produced an invalid paper quote");
    }

    const displayName = response.meta?.name
      ?? (this.symbol.toUpperCase() === "XAU/USD" ? "Gold Spot / US Dollar" : this.symbol);
    const instrument: GoldInstrument = {
      name: response.meta?.symbol ?? this.symbol,
      displayName,
      displayPrecision: 2,
      tradeUnitsPrecision: 2,
      minimumTradeSize: 0.01,
      maximumOrderUnits: null,
    };

    const snapshot: GoldMarketSnapshot = { candles, quote, instrument };
    this.cachedSnapshot = { at: nowMs, value: snapshot };
    return snapshot;
  }

  async getInstrument(granularity: string): Promise<GoldInstrument> {
    return (await this.getSnapshot(granularity, 300)).instrument;
  }
}
