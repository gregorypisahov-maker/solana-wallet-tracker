import type { GoldCandle, GoldInstrument, GoldQuote } from "./types";

type OandaCandleResponse = {
  candles?: Array<{
    complete?: boolean;
    time?: string;
    mid?: { o?: string; h?: string; l?: string; c?: string };
  }>;
};

type OandaPricingResponse = {
  prices?: Array<{
    time?: string;
    status?: string;
    bids?: Array<{ price?: string }>;
    asks?: Array<{ price?: string }>;
  }>;
};

type OandaInstrumentResponse = {
  instruments?: Array<{
    name?: string;
    displayName?: string;
    displayPrecision?: number;
    tradeUnitsPrecision?: number;
    minimumTradeSize?: string;
    maximumOrderUnits?: string;
  }>;
};

export class OandaMarketDataClient {
  private readonly token: string;
  private readonly accountId: string;
  private readonly instrument: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(args: {
    token: string;
    accountId: string;
    instrument: string;
    environment: "practice" | "live";
    timeoutMs?: number;
  }) {
    this.token = args.token;
    this.accountId = args.accountId;
    this.instrument = args.instrument;
    this.baseUrl = args.environment === "live"
      ? "https://api-fxtrade.oanda.com"
      : "https://api-fxpractice.oanda.com";
    this.timeoutMs = args.timeoutMs ?? 12_000;
  }

  private async request<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          "Accept-Datetime-Format": "RFC3339",
          "User-Agent": "gregory-xauusd-paper-bot/1.0",
        },
        signal: controller.signal,
        cache: "no-store",
      });

      const text = await response.text();
      if (!response.ok) {
        throw new Error(`OANDA ${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
      }
      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getInstrument(): Promise<GoldInstrument> {
    const query = encodeURIComponent(this.instrument);
    const response = await this.request<OandaInstrumentResponse>(
      `/v3/accounts/${encodeURIComponent(this.accountId)}/instruments?instruments=${query}`,
    );
    const instrument = response.instruments?.find((item) => item.name === this.instrument);
    if (!instrument?.name) {
      throw new Error(
        `Instrument ${this.instrument} is not tradeable for this OANDA account/division. ` +
        "Check the account instrument list before running the bot.",
      );
    }

    const minimumTradeSize = Number(instrument.minimumTradeSize ?? "0");
    const maximumOrderUnits = Number(instrument.maximumOrderUnits ?? "0");
    return {
      name: instrument.name,
      displayName: instrument.displayName ?? instrument.name,
      displayPrecision: Number(instrument.displayPrecision ?? 3),
      tradeUnitsPrecision: Number(instrument.tradeUnitsPrecision ?? 0),
      minimumTradeSize: Number.isFinite(minimumTradeSize) ? minimumTradeSize : 0,
      maximumOrderUnits: Number.isFinite(maximumOrderUnits) && maximumOrderUnits > 0
        ? maximumOrderUnits
        : null,
    };
  }

  async getCandles(granularity: string, count = 300): Promise<GoldCandle[]> {
    const params = new URLSearchParams({
      price: "M",
      granularity,
      count: String(Math.min(Math.max(count, 80), 5000)),
      smooth: "false",
    });
    const response = await this.request<OandaCandleResponse>(
      `/v3/instruments/${encodeURIComponent(this.instrument)}/candles?${params.toString()}`,
    );

    return (response.candles ?? []).flatMap((candle) => {
      const open = Number(candle.mid?.o);
      const high = Number(candle.mid?.h);
      const low = Number(candle.mid?.l);
      const close = Number(candle.mid?.c);
      if (
        !candle.time ||
        !Number.isFinite(open) ||
        !Number.isFinite(high) ||
        !Number.isFinite(low) ||
        !Number.isFinite(close)
      ) {
        return [];
      }
      return [{
        time: candle.time,
        open,
        high,
        low,
        close,
        complete: candle.complete === true,
      }];
    });
  }

  async getQuote(): Promise<GoldQuote> {
    const query = encodeURIComponent(this.instrument);
    const response = await this.request<OandaPricingResponse>(
      `/v3/accounts/${encodeURIComponent(this.accountId)}/pricing?instruments=${query}`,
    );
    const price = response.prices?.[0];
    const bid = Number(price?.bids?.[0]?.price);
    const ask = Number(price?.asks?.[0]?.price);
    if (!price?.time || !Number.isFinite(bid) || !Number.isFinite(ask) || ask <= bid) {
      throw new Error(`OANDA returned an invalid quote for ${this.instrument}`);
    }
    return {
      time: price.time,
      bid,
      ask,
      status: price.status ?? "unknown",
    };
  }
}
