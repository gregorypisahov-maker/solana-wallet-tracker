export type GoldSide = "long" | "short";

export type GoldCandle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  complete: boolean;
};

export type GoldQuote = {
  time: string;
  bid: number;
  ask: number;
  status: string;
};

export type GoldInstrument = {
  name: string;
  displayName: string;
  displayPrecision: number;
  tradeUnitsPrecision: number;
  minimumTradeSize: number;
  maximumOrderUnits: number | null;
};

export type GoldSignal = {
  side: GoldSide;
  candleTime: string;
  referencePrice: number;
  atr: number;
  stopDistance: number;
  reason: string;
};

export type GoldBotState = {
  bot_id: string;
  balance_usd: number | string;
  daily_start_balance_usd: number | string;
  daily_date: string;
  paused: boolean;
  pause_reason: string | null;
  last_processed_candle_time: string | null;
  updated_at: string;
};

export type GoldPaperPosition = {
  id: string;
  bot_id: string;
  instrument: string;
  side: GoldSide;
  units: number | string;
  entry_price: number | string;
  stop_loss: number | string;
  take_profit: number | string;
  entry_spread: number | string;
  opened_at: string;
  closed_at: string | null;
  exit_price: number | string | null;
  realized_pnl_usd: number | string | null;
  close_reason: string | null;
  status: "open" | "closed";
  strategy_version: string;
  signal_json: Record<string, unknown> | null;
};
