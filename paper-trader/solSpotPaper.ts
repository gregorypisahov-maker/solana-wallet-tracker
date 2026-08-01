import { randomUUID } from "crypto";
import { getSupabaseAdmin } from "../lib/supabase";
import { sendTelegramAlert } from "../lib/telegram";

const numberEnv = (name: string, fallback: number, minimum?: number, maximum?: number): number => {
  const parsed = Number(process.env[name] ?? fallback);
  let value = Number.isFinite(parsed) ? parsed : fallback;
  if (minimum != null) value = Math.max(minimum, value);
  if (maximum != null) value = Math.min(maximum, value);
  return value;
};

const booleanEnv = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name];
  if (raw == null) return fallback;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
};

export const SOL_SPOT_PAPER_CONFIG = {
  enabled: booleanEnv("ENABLE_SOL_SPOT_PAPER", true),
  symbol: (process.env.SOL_SPOT_SYMBOL ?? "SOLUSDT").trim().toUpperCase(),
  restBaseUrl: (process.env.BINANCE_SPOT_REST_URL ?? "https://api.binance.com").replace(/\/$/, ""),
  scanIntervalMs: numberEnv("SOL_SPOT_SCAN_INTERVAL_MS", 30_000, 10_000),
  positionCheckMs: numberEnv("SOL_SPOT_POSITION_CHECK_MS", 5_000, 2_000),
  leaseRefreshMs: numberEnv("SOL_SPOT_LEASE_REFRESH_MS", 15_000, 5_000),
  leaseSeconds: Math.round(numberEnv("SOL_SPOT_LEASE_SECONDS", 45, 20, 300)),
  entryScoreThreshold: Math.round(numberEnv("SOL_SPOT_ENTRY_SCORE", 6, 4, 9)),
  riskPctPerTrade: numberEnv("SOL_SPOT_RISK_PCT", 0.35, 0.05, 2),
  maxPositionPct: numberEnv("SOL_SPOT_MAX_POSITION_PCT", 20, 2, 50),
  maxPositionUsdt: numberEnv("SOL_SPOT_MAX_POSITION_USDT", 200, 10),
  minPositionUsdt: numberEnv("SOL_SPOT_MIN_POSITION_USDT", 25, 5),
  minStopPct: numberEnv("SOL_SPOT_MIN_STOP_PCT", 0.8, 0.2, 5),
  maxStopPct: numberEnv("SOL_SPOT_MAX_STOP_PCT", 1.8, 0.5, 8),
  atrStopMultiplier: numberEnv("SOL_SPOT_ATR_STOP_MULTIPLIER", 1.5, 0.5, 5),
  rewardRiskMultiple: numberEnv("SOL_SPOT_REWARD_RISK", 1.8, 1, 5),
  trailingActivationR: numberEnv("SOL_SPOT_TRAILING_ACTIVATION_R", 1, 0.5, 3),
  trailingGivebackPct: numberEnv("SOL_SPOT_TRAILING_GIVEBACK_PCT", 0.6, 0.15, 3),
  maxHoldMinutes: numberEnv("SOL_SPOT_MAX_HOLD_MINUTES", 360, 15),
  cooldownMinutes: numberEnv("SOL_SPOT_COOLDOWN_MINUTES", 30, 0),
  maxDailyEntries: Math.round(numberEnv("SOL_SPOT_MAX_DAILY_ENTRIES", 8, 1, 50)),
  dailyLossLimitUsdt: numberEnv("SOL_SPOT_DAILY_LOSS_LIMIT_USDT", 20, 1),
  maxConsecutiveLosses: Math.round(numberEnv("SOL_SPOT_MAX_CONSECUTIVE_LOSSES", 3, 1, 10)),
  takerFeePctPerSide: numberEnv("SOL_SPOT_TAKER_FEE_PCT", 0.1, 0, 1),
  slippagePctPerSide: numberEnv("SOL_SPOT_SLIPPAGE_PCT", 0.03, 0, 1),
} as const;

export type Candle = {
  open: number;
  high: number;
  low: number;
  close: number;
  quoteVolume: number;
  closeTimeMs: number;
};

export type EntryDecision = {
  passed: boolean;
  score: number;
  threshold: number;
  blockers: string[];
  positives: string[];
  stopDistancePct: number;
  snapshot: Record<string, unknown>;
};

export type SpotRiskPlan = {
  quantity: number;
  signalPrice: number;
  entryMarketPrice: number;
  entryFillPrice: number;
  principalUsdt: number;
  entryFeeUsdt: number;
  quoteSpentUsdt: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  trailingActivationPrice: number;
  stopDistancePct: number;
  riskBudgetUsdt: number;
};

export type SpotExitCalculation = {
  exitFillPrice: number;
  grossProceedsUsdt: number;
  exitFeeUsdt: number;
  proceedsUsdt: number;
  grossPnlUsdt: number;
  netPnlUsdt: number;
  netReturnPct: number;
};

type ExchangeRules = {
  quantityStep: number;
  minimumQuantity: number;
  minimumNotional: number;
};

type StateRow = {
  enabled: boolean;
  halted: boolean;
  halt_reason: string | null;
  bankroll_usdt: number | string;
  entries_today: number;
  cooldown_until: string | null;
};

type PositionRow = {
  position_id: string;
  symbol: string;
  quantity: number | string;
  signal_price: number | string;
  entry_market_price: number | string;
  entry_fill_price: number | string;
  principal_usdt: number | string;
  entry_fee_usdt: number | string;
  quote_spent_usdt: number | string;
  stop_loss_price: number | string;
  take_profit_price: number | string;
  trailing_activation_price: number | string;
  trailing_floor_price: number | string | null;
  highest_price_seen: number | string;
  last_market_price: number | string;
  stop_distance_pct: number | string;
  risk_budget_usdt: number | string;
  opened_at: string;
  last_checked_at: string;
  signal_snapshot: Record<string, unknown> | null;
};

type OpenPosition = {
  positionId: string;
  symbol: string;
  quantity: number;
  signalPrice: number;
  entryMarketPrice: number;
  entryFillPrice: number;
  principalUsdt: number;
  entryFeeUsdt: number;
  quoteSpentUsdt: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  trailingActivationPrice: number;
  trailingFloorPrice: number | null;
  highestPriceSeen: number;
  lastMarketPrice: number;
  stopDistancePct: number;
  riskBudgetUsdt: number;
  openedAtMs: number;
  lastCheckedAtMs: number;
  signalSnapshot: Record<string, unknown>;
};

const finite = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

function decimalPlaces(step: number): number {
  const text = step.toString().toLowerCase();
  if (text.includes("e-")) return Number(text.split("e-")[1] ?? 0);
  return text.includes(".") ? text.split(".")[1].length : 0;
}

export function floorToStep(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return 0;
  const places = Math.min(12, decimalPlaces(step));
  const floored = Math.floor((value + step * 1e-9) / step) * step;
  return Number(floored.toFixed(places));
}

export function ema(values: number[], period: number): number | null {
  const clean = values.filter((value) => Number.isFinite(value) && value > 0);
  if (period < 1 || clean.length < period) return null;
  const multiplier = 2 / (period + 1);
  let value = clean.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  for (let index = period; index < clean.length; index += 1) {
    value = clean[index] * multiplier + value * (1 - multiplier);
  }
  return value;
}

export function rsi(values: number[], period = 14): number | null {
  const clean = values.filter((value) => Number.isFinite(value) && value > 0);
  if (period < 1 || clean.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = clean[index] - clean[index - 1];
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  for (let index = period + 1; index < clean.length; index += 1) {
    const change = clean[index] - clean[index - 1];
    const gain = Math.max(0, change);
    const loss = Math.max(0, -change);
    averageGain = (averageGain * (period - 1) + gain) / period;
    averageLoss = (averageLoss * (period - 1) + loss) / period;
  }
  if (averageLoss === 0) return 100;
  const relativeStrength = averageGain / averageLoss;
  return 100 - 100 / (1 + relativeStrength);
}

export function atr(candles: Candle[], period = 14): number | null {
  if (period < 1 || candles.length <= period) return null;
  const trueRanges: number[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const current = candles[index];
    const previous = candles[index - 1];
    trueRanges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close)
      )
    );
  }
  if (trueRanges.length < period) return null;
  let value = trueRanges.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  for (let index = period; index < trueRanges.length; index += 1) {
    value = (value * (period - 1) + trueRanges[index]) / period;
  }
  return value;
}

export function evaluateSolSpotEntry(
  fiveMinuteCandles: Candle[],
  hourlyCandles: Candle[],
  threshold = SOL_SPOT_PAPER_CONFIG.entryScoreThreshold
): EntryDecision {
  const blockers: string[] = [];
  const positives: string[] = [];
  if (fiveMinuteCandles.length < 50 || hourlyCandles.length < 50) {
    return {
      passed: false,
      score: 0,
      threshold,
      blockers: ["warming_up"],
      positives,
      stopDistancePct: SOL_SPOT_PAPER_CONFIG.minStopPct,
      snapshot: { fiveMinuteCandles: fiveMinuteCandles.length, hourlyCandles: hourlyCandles.length },
    };
  }

  const fiveCloses = fiveMinuteCandles.map((candle) => candle.close);
  const hourCloses = hourlyCandles.map((candle) => candle.close);
  const latest = fiveMinuteCandles[fiveMinuteCandles.length - 1];
  const previous = fiveMinuteCandles[fiveMinuteCandles.length - 2];
  const latestHour = hourlyCandles[hourlyCandles.length - 1];
  const ema9 = ema(fiveCloses, 9) ?? 0;
  const ema21 = ema(fiveCloses, 21) ?? 0;
  const hourlyEma20 = ema(hourCloses, 20) ?? 0;
  const hourlyEma50 = ema(hourCloses, 50) ?? 0;
  const currentRsi = rsi(fiveCloses, 14) ?? 0;
  const currentAtr = atr(fiveMinuteCandles, 14) ?? 0;
  const atrPct = latest.close > 0 ? (currentAtr / latest.close) * 100 : 0;
  const priorVolumes = fiveMinuteCandles
    .slice(-21, -1)
    .map((candle) => candle.quoteVolume)
    .filter((value) => value > 0);
  const averageVolume = priorVolumes.length
    ? priorVolumes.reduce((sum, value) => sum + value, 0) / priorVolumes.length
    : 0;
  const relativeVolume = averageVolume > 0 ? latest.quoteVolume / averageVolume : 0;
  const distanceFromEmaAtr = currentAtr > 0 ? (latest.close - ema21) / currentAtr : 0;

  let score = 0;
  if (hourlyEma20 >= hourlyEma50 * 0.997) {
    score += 2;
    positives.push("hourly_trend_supportive");
  }
  if (latestHour.close >= hourlyEma20) {
    score += 1;
    positives.push("hourly_close_above_ema20");
  }
  if (ema9 > ema21) {
    score += 2;
    positives.push("five_minute_ema_alignment");
  }
  if (latest.close > ema9) {
    score += 1;
    positives.push("price_above_fast_ema");
  }
  if (latest.close > previous.close) {
    score += 1;
    positives.push("positive_closed_candle");
  }
  if (currentRsi >= 48 && currentRsi <= 70) {
    score += 1;
    positives.push("rsi_tradeable");
  }
  if (relativeVolume >= 0.65) {
    score += 1;
    positives.push("volume_confirmed");
  }

  if (hourlyEma20 < hourlyEma50 * 0.992) blockers.push("hourly_downtrend");
  if (currentRsi > 74) blockers.push("overbought");
  if (currentRsi < 38) blockers.push("weak_momentum");
  if (distanceFromEmaAtr > 1.6) blockers.push("entry_too_extended");
  if (currentAtr <= 0 || atrPct <= 0) blockers.push("atr_unavailable");
  if (latest.close <= 0 || latest.quoteVolume <= 0) blockers.push("invalid_market_data");

  const stopDistancePct = clamp(
    atrPct * SOL_SPOT_PAPER_CONFIG.atrStopMultiplier,
    SOL_SPOT_PAPER_CONFIG.minStopPct,
    SOL_SPOT_PAPER_CONFIG.maxStopPct
  );
  if (score < threshold) blockers.push("score_below_threshold");

  return {
    passed: blockers.length === 0,
    score,
    threshold,
    blockers,
    positives,
    stopDistancePct,
    snapshot: {
      close: latest.close,
      previousClose: previous.close,
      ema9,
      ema21,
      hourlyEma20,
      hourlyEma50,
      hourlyClose: latestHour.close,
      rsi14: currentRsi,
      atr14: currentAtr,
      atrPct,
      relativeVolume,
      distanceFromEmaAtr,
      score,
      threshold,
      positives,
      blockers,
    },
  };
}

export function deriveSpotRiskPlan(params: {
  bankrollUsdt: number;
  marketPrice: number;
  signalPrice: number;
  stopDistancePct: number;
  quantityStep: number;
  minimumQuantity: number;
  minimumNotional: number;
}): SpotRiskPlan | null {
  if (params.bankrollUsdt <= 0 || params.marketPrice <= 0 || params.stopDistancePct <= 0) return null;
  const riskBudgetUsdt = params.bankrollUsdt * (SOL_SPOT_PAPER_CONFIG.riskPctPerTrade / 100);
  const notionalByRisk = riskBudgetUsdt / (params.stopDistancePct / 100);
  const notionalByBankrollCap = params.bankrollUsdt * (SOL_SPOT_PAPER_CONFIG.maxPositionPct / 100);
  const grossBudget = Math.min(
    notionalByRisk,
    notionalByBankrollCap,
    SOL_SPOT_PAPER_CONFIG.maxPositionUsdt,
    params.bankrollUsdt * 0.95
  );
  if (grossBudget < SOL_SPOT_PAPER_CONFIG.minPositionUsdt) return null;

  const entryFillPrice = params.marketPrice * (1 + SOL_SPOT_PAPER_CONFIG.slippagePctPerSide / 100);
  const feeRate = SOL_SPOT_PAPER_CONFIG.takerFeePctPerSide / 100;
  const quantity = floorToStep(grossBudget / (entryFillPrice * (1 + feeRate)), params.quantityStep);
  if (quantity < params.minimumQuantity) return null;
  const principalUsdt = quantity * entryFillPrice;
  if (principalUsdt < params.minimumNotional) return null;
  const entryFeeUsdt = principalUsdt * feeRate;
  const quoteSpentUsdt = principalUsdt + entryFeeUsdt;
  if (quoteSpentUsdt > params.bankrollUsdt || quoteSpentUsdt < SOL_SPOT_PAPER_CONFIG.minPositionUsdt) return null;

  return {
    quantity,
    signalPrice: params.signalPrice,
    entryMarketPrice: params.marketPrice,
    entryFillPrice,
    principalUsdt,
    entryFeeUsdt,
    quoteSpentUsdt,
    stopLossPrice: entryFillPrice * (1 - params.stopDistancePct / 100),
    takeProfitPrice:
      entryFillPrice *
      (1 + (params.stopDistancePct * SOL_SPOT_PAPER_CONFIG.rewardRiskMultiple) / 100),
    trailingActivationPrice:
      entryFillPrice *
      (1 + (params.stopDistancePct * SOL_SPOT_PAPER_CONFIG.trailingActivationR) / 100),
    stopDistancePct: params.stopDistancePct,
    riskBudgetUsdt,
  };
}

export function calculateSpotExit(params: {
  quantity: number;
  entryFillPrice: number;
  entryFeeUsdt: number;
  quoteSpentUsdt: number;
  marketExitPrice: number;
  exitSlippagePct?: number;
  feePct?: number;
}): SpotExitCalculation {
  const slippagePct = params.exitSlippagePct ?? SOL_SPOT_PAPER_CONFIG.slippagePctPerSide;
  const feePct = params.feePct ?? SOL_SPOT_PAPER_CONFIG.takerFeePctPerSide;
  const exitFillPrice = params.marketExitPrice * (1 - slippagePct / 100);
  const grossProceedsUsdt = params.quantity * exitFillPrice;
  const exitFeeUsdt = grossProceedsUsdt * (feePct / 100);
  const proceedsUsdt = grossProceedsUsdt - exitFeeUsdt;
  const principalUsdt = params.quantity * params.entryFillPrice;
  const grossPnlUsdt = grossProceedsUsdt - principalUsdt;
  const netPnlUsdt = proceedsUsdt - params.quoteSpentUsdt;
  const netReturnPct = params.quoteSpentUsdt > 0 ? (netPnlUsdt / params.quoteSpentUsdt) * 100 : 0;
  return {
    exitFillPrice,
    grossProceedsUsdt,
    exitFeeUsdt,
    proceedsUsdt,
    grossPnlUsdt,
    netPnlUsdt,
    netReturnPct,
  };
}

function hydratePosition(row: PositionRow): OpenPosition {
  return {
    positionId: row.position_id,
    symbol: row.symbol,
    quantity: finite(row.quantity),
    signalPrice: finite(row.signal_price),
    entryMarketPrice: finite(row.entry_market_price),
    entryFillPrice: finite(row.entry_fill_price),
    principalUsdt: finite(row.principal_usdt),
    entryFeeUsdt: finite(row.entry_fee_usdt),
    quoteSpentUsdt: finite(row.quote_spent_usdt),
    stopLossPrice: finite(row.stop_loss_price),
    takeProfitPrice: finite(row.take_profit_price),
    trailingActivationPrice: finite(row.trailing_activation_price),
    trailingFloorPrice: row.trailing_floor_price == null ? null : finite(row.trailing_floor_price),
    highestPriceSeen: finite(row.highest_price_seen),
    lastMarketPrice: finite(row.last_market_price),
    stopDistancePct: finite(row.stop_distance_pct),
    riskBudgetUsdt: finite(row.risk_budget_usdt),
    openedAtMs: Date.parse(row.opened_at),
    lastCheckedAtMs: Date.parse(row.last_checked_at),
    signalSnapshot: row.signal_snapshot ?? {},
  };
}

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`Binance spot HTTP ${response.status}`);
  return response.json();
}

class SolSpotPaperBot {
  private readonly supabase = getSupabaseAdmin({ noStore: true });
  private readonly workerId = `sol-spot-${randomUUID()}`;
  private exchangeRules: ExchangeRules | null = null;
  private openPosition: OpenPosition | null = null;
  private leader = false;
  private scanning = false;
  private checkingPosition = false;
  private closingPosition = false;
  private stopped = false;
  private leaseTimer: ReturnType<typeof setInterval> | null = null;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private positionTimer: ReturnType<typeof setInterval> | null = null;

  async start(): Promise<void> {
    if (!SOL_SPOT_PAPER_CONFIG.enabled) {
      console.log("[sol-spot-paper] disabled by ENABLE_SOL_SPOT_PAPER");
      await this.updateHealth("disabled", null);
      return;
    }
    await this.loadExchangeRules();
    await this.loadOpenPosition();
    await this.refreshLease();
    this.leaseTimer = setInterval(() => void this.refreshLease(), SOL_SPOT_PAPER_CONFIG.leaseRefreshMs);
    this.scanTimer = setInterval(() => void this.scan(), SOL_SPOT_PAPER_CONFIG.scanIntervalMs);
    this.positionTimer = setInterval(
      () => void this.checkOpenPosition(),
      SOL_SPOT_PAPER_CONFIG.positionCheckMs
    );
    void this.scan();
    void this.checkOpenPosition();
    console.log(
      `[sol-spot-paper] started ${SOL_SPOT_PAPER_CONFIG.symbol} spot paper bot; ` +
        `score>=${SOL_SPOT_PAPER_CONFIG.entryScoreThreshold}, risk=${SOL_SPOT_PAPER_CONFIG.riskPctPerTrade}%`
    );
  }

  stop(): void {
    this.stopped = true;
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.positionTimer) clearInterval(this.positionTimer);
  }

  private async refreshLease(): Promise<void> {
    if (this.stopped) return;
    try {
      const { data, error } = await this.supabase.rpc("sol_spot_claim_paper_worker", {
        p_worker_id: this.workerId,
        p_lease_seconds: SOL_SPOT_PAPER_CONFIG.leaseSeconds,
      });
      if (error) throw new Error(error.message);
      const wasLeader = this.leader;
      this.leader = data === true;
      if (this.leader && !wasLeader) console.log(`[sol-spot-paper] worker lease acquired ${this.workerId}`);
      if (!this.leader && wasLeader) console.warn("[sol-spot-paper] worker lease lost; entering standby");
    } catch (error) {
      this.leader = false;
      console.error("[sol-spot-paper] lease refresh failed", error);
      await this.updateHealth("degraded", error);
    }
  }

  private async loadExchangeRules(): Promise<void> {
    const payload = await fetchJson(
      `${SOL_SPOT_PAPER_CONFIG.restBaseUrl}/api/v3/exchangeInfo?symbol=${encodeURIComponent(
        SOL_SPOT_PAPER_CONFIG.symbol
      )}`
    );
    const symbol = Array.isArray(payload?.symbols) ? payload.symbols[0] : null;
    if (!symbol) throw new Error(`Binance spot symbol ${SOL_SPOT_PAPER_CONFIG.symbol} not found`);
    const filters = Array.isArray(symbol.filters) ? symbol.filters : [];
    const lot = filters.find((row: any) => row.filterType === "LOT_SIZE");
    const notional =
      filters.find((row: any) => row.filterType === "NOTIONAL") ??
      filters.find((row: any) => row.filterType === "MIN_NOTIONAL");
    const rules = {
      quantityStep: finite(lot?.stepSize),
      minimumQuantity: finite(lot?.minQty),
      minimumNotional: finite(notional?.minNotional ?? notional?.notional),
    };
    if (rules.quantityStep <= 0 || rules.minimumQuantity <= 0 || rules.minimumNotional <= 0) {
      throw new Error(`Incomplete Binance spot filters for ${SOL_SPOT_PAPER_CONFIG.symbol}`);
    }
    this.exchangeRules = rules;
    console.log(
      `[sol-spot-paper] exchange filters qtyStep=${rules.quantityStep} minQty=${rules.minimumQuantity} minNotional=${rules.minimumNotional}`
    );
  }

  private async loadOpenPosition(): Promise<void> {
    const { data, error } = await this.supabase
      .from("sol_spot_paper_positions")
      .select("*")
      .maybeSingle();
    if (error) throw new Error(`Unable to load SOL spot paper position: ${error.message}`);
    this.openPosition = data ? hydratePosition(data as PositionRow) : null;
    if (this.openPosition) {
      console.log(
        `[sol-spot-paper] recovered open ${this.openPosition.symbol} position @ ${this.openPosition.entryFillPrice}`
      );
    }
  }

  private async fetchCandles(interval: "5m" | "1h", limit: number): Promise<Candle[]> {
    const payload = (await fetchJson(
      `${SOL_SPOT_PAPER_CONFIG.restBaseUrl}/api/v3/klines?symbol=${encodeURIComponent(
        SOL_SPOT_PAPER_CONFIG.symbol
      )}&interval=${interval}&limit=${limit}`
    )) as any[];
    const now = Date.now();
    return payload
      .map((row) => ({
        open: finite(row?.[1]),
        high: finite(row?.[2]),
        low: finite(row?.[3]),
        close: finite(row?.[4]),
        quoteVolume: finite(row?.[7]),
        closeTimeMs: finite(row?.[6]),
      }))
      .filter(
        (row) =>
          row.open > 0 &&
          row.high > 0 &&
          row.low > 0 &&
          row.close > 0 &&
          row.closeTimeMs > 0 &&
          row.closeTimeMs < now
      );
  }

  private async fetchMarketPrice(): Promise<number> {
    const payload = await fetchJson(
      `${SOL_SPOT_PAPER_CONFIG.restBaseUrl}/api/v3/ticker/price?symbol=${encodeURIComponent(
        SOL_SPOT_PAPER_CONFIG.symbol
      )}`
    );
    const price = finite(payload?.price);
    if (price <= 0) throw new Error("Binance spot returned an invalid market price");
    return price;
  }

  private async loadState(): Promise<StateRow> {
    const { data, error } = await this.supabase
      .from("sol_spot_paper_state")
      .select("enabled,halted,halt_reason,bankroll_usdt,entries_today,cooldown_until")
      .eq("id", 1)
      .single();
    if (error) throw new Error(`Unable to load SOL spot paper state: ${error.message}`);
    return data as StateRow;
  }

  private async scan(): Promise<void> {
    if (this.stopped || !this.leader || this.scanning) return;
    this.scanning = true;
    try {
      const [fiveMinute, hourly, state] = await Promise.all([
        this.fetchCandles("5m", 120),
        this.fetchCandles("1h", 80),
        this.loadState(),
      ]);
      const latest = fiveMinute[fiveMinute.length - 1];
      if (!latest) throw new Error("No closed SOLUSDT five-minute candle available");
      const candleIso = new Date(latest.closeTimeMs).toISOString();

      const { data: existing, error: existingError } = await this.supabase
        .from("sol_spot_paper_scan_runs")
        .select("id")
        .eq("symbol", SOL_SPOT_PAPER_CONFIG.symbol)
        .eq("candle_close_time", candleIso)
        .maybeSingle();
      if (existingError) throw new Error(existingError.message);
      if (existing) return;

      if (!state.enabled) {
        await this.recordScan(latest, null, "disabled", ["state_disabled"]);
        await this.updateHealth("disabled", null, latest.close, latest.closeTimeMs);
        return;
      }
      if (state.halted) {
        await this.recordScan(latest, null, "halted", [state.halt_reason ?? "risk_guard"]);
        await this.updateHealth("connected", null, latest.close, latest.closeTimeMs);
        return;
      }
      if (this.openPosition) {
        await this.recordScan(latest, null, "position_open", ["single_position_limit"]);
        await this.updateHealth("connected", null, latest.close, latest.closeTimeMs);
        return;
      }
      const cooldownUntil = state.cooldown_until ? Date.parse(state.cooldown_until) : 0;
      if (cooldownUntil > Date.now()) {
        await this.recordScan(latest, null, "cooldown", ["post_trade_cooldown"]);
        await this.updateHealth("connected", null, latest.close, latest.closeTimeMs);
        return;
      }

      const decision = evaluateSolSpotEntry(fiveMinute, hourly);
      if (!decision.passed) {
        await this.recordScan(latest, decision, "monitor", decision.blockers);
        await this.updateHealth("connected", null, latest.close, latest.closeTimeMs);
        return;
      }
      if (!this.exchangeRules) throw new Error("SOL spot exchange rules are unavailable");
      const marketPrice = await this.fetchMarketPrice();
      const plan = deriveSpotRiskPlan({
        bankrollUsdt: finite(state.bankroll_usdt),
        marketPrice,
        signalPrice: latest.close,
        stopDistancePct: decision.stopDistancePct,
        quantityStep: this.exchangeRules.quantityStep,
        minimumQuantity: this.exchangeRules.minimumQuantity,
        minimumNotional: this.exchangeRules.minimumNotional,
      });
      if (!plan) {
        await this.recordScan(latest, decision, "monitor", ["position_size_below_exchange_or_risk_minimum"]);
        return;
      }
      await this.openPaperPosition(plan, decision, latest);
      await this.recordScan(latest, decision, "entered", []);
      await this.updateHealth("connected", null, marketPrice, latest.closeTimeMs);
    } catch (error) {
      console.error("[sol-spot-paper] scan failed", error);
      await this.updateHealth("error", error);
    } finally {
      this.scanning = false;
    }
  }

  private async openPaperPosition(
    plan: SpotRiskPlan,
    decision: EntryDecision,
    candle: Candle
  ): Promise<void> {
    const positionId = randomUUID();
    const openedAt = new Date();
    const signalSnapshot = {
      strategyVersion: "sol_spot_trend_v1_2026_08_01",
      symbol: SOL_SPOT_PAPER_CONFIG.symbol,
      candleCloseTime: new Date(candle.closeTimeMs).toISOString(),
      decision: decision.snapshot,
      positives: decision.positives,
      config: {
        riskPctPerTrade: SOL_SPOT_PAPER_CONFIG.riskPctPerTrade,
        rewardRiskMultiple: SOL_SPOT_PAPER_CONFIG.rewardRiskMultiple,
        trailingActivationR: SOL_SPOT_PAPER_CONFIG.trailingActivationR,
        trailingGivebackPct: SOL_SPOT_PAPER_CONFIG.trailingGivebackPct,
      },
    };
    const { error } = await this.supabase.rpc("sol_spot_open_paper_position", {
      p_position_id: positionId,
      p_symbol: SOL_SPOT_PAPER_CONFIG.symbol,
      p_quantity: plan.quantity,
      p_signal_price: plan.signalPrice,
      p_entry_market_price: plan.entryMarketPrice,
      p_entry_fill_price: plan.entryFillPrice,
      p_principal_usdt: plan.principalUsdt,
      p_entry_fee_usdt: plan.entryFeeUsdt,
      p_quote_spent_usdt: plan.quoteSpentUsdt,
      p_stop_loss_price: plan.stopLossPrice,
      p_take_profit_price: plan.takeProfitPrice,
      p_trailing_activation_price: plan.trailingActivationPrice,
      p_stop_distance_pct: plan.stopDistancePct,
      p_risk_budget_usdt: plan.riskBudgetUsdt,
      p_opened_at: openedAt.toISOString(),
      p_signal_snapshot: signalSnapshot,
      p_max_daily_entries: SOL_SPOT_PAPER_CONFIG.maxDailyEntries,
    });
    if (error) throw new Error(`Unable to open SOL spot paper position: ${error.message}`);
    this.openPosition = {
      positionId,
      symbol: SOL_SPOT_PAPER_CONFIG.symbol,
      quantity: plan.quantity,
      signalPrice: plan.signalPrice,
      entryMarketPrice: plan.entryMarketPrice,
      entryFillPrice: plan.entryFillPrice,
      principalUsdt: plan.principalUsdt,
      entryFeeUsdt: plan.entryFeeUsdt,
      quoteSpentUsdt: plan.quoteSpentUsdt,
      stopLossPrice: plan.stopLossPrice,
      takeProfitPrice: plan.takeProfitPrice,
      trailingActivationPrice: plan.trailingActivationPrice,
      trailingFloorPrice: null,
      highestPriceSeen: plan.entryMarketPrice,
      lastMarketPrice: plan.entryMarketPrice,
      stopDistancePct: plan.stopDistancePct,
      riskBudgetUsdt: plan.riskBudgetUsdt,
      openedAtMs: openedAt.getTime(),
      lastCheckedAtMs: openedAt.getTime(),
      signalSnapshot,
    };
    await sendTelegramAlert(
      [
        "🟣 <b>SOL/USDT paper position opened</b>",
        `Entry: <b>${plan.entryFillPrice.toFixed(4)} USDT</b>`,
        `Size: <b>${plan.quoteSpentUsdt.toFixed(2)} USDT</b>`,
        `Stop: <b>${plan.stopLossPrice.toFixed(4)}</b>`,
        `Target: <b>${plan.takeProfitPrice.toFixed(4)}</b>`,
        `Score: <b>${decision.score}/${decision.threshold}</b>`,
      ].join("\n")
    );
    console.log(
      `[sol-spot-paper] opened ${plan.quantity} SOL @ ${plan.entryFillPrice}; ` +
        `stop=${plan.stopLossPrice} target=${plan.takeProfitPrice}`
    );
  }

  private async checkOpenPosition(): Promise<void> {
    if (
      this.stopped ||
      !this.leader ||
      this.checkingPosition ||
      this.closingPosition ||
      !this.openPosition
    ) {
      return;
    }
    this.checkingPosition = true;
    try {
      const marketPrice = await this.fetchMarketPrice();
      const now = Date.now();
      const position = this.openPosition;
      const highestPriceSeen = Math.max(position.highestPriceSeen, marketPrice);
      let trailingFloorPrice = position.trailingFloorPrice;
      if (marketPrice >= position.trailingActivationPrice) {
        const estimatedRoundTripCostPct =
          2 *
          (SOL_SPOT_PAPER_CONFIG.takerFeePctPerSide +
            SOL_SPOT_PAPER_CONFIG.slippagePctPerSide);
        const breakEvenFloor = position.entryFillPrice * (1 + estimatedRoundTripCostPct / 100);
        const givebackFloor =
          highestPriceSeen * (1 - SOL_SPOT_PAPER_CONFIG.trailingGivebackPct / 100);
        trailingFloorPrice = Math.max(trailingFloorPrice ?? 0, breakEvenFloor, givebackFloor);
      }

      position.highestPriceSeen = highestPriceSeen;
      position.trailingFloorPrice = trailingFloorPrice;
      position.lastMarketPrice = marketPrice;
      position.lastCheckedAtMs = now;

      let exitReason: "take_profit" | "stop_loss" | "trailing_stop" | "max_hold_time" | null = null;
      if (marketPrice <= position.stopLossPrice) exitReason = "stop_loss";
      else if (marketPrice >= position.takeProfitPrice) exitReason = "take_profit";
      else if (trailingFloorPrice != null && marketPrice <= trailingFloorPrice) exitReason = "trailing_stop";
      else if (now - position.openedAtMs >= SOL_SPOT_PAPER_CONFIG.maxHoldMinutes * 60_000) {
        exitReason = "max_hold_time";
      }

      if (exitReason) {
        await this.closePaperPosition(position, marketPrice, exitReason, now);
        return;
      }

      const { error } = await this.supabase
        .from("sol_spot_paper_positions")
        .update({
          highest_price_seen: highestPriceSeen,
          trailing_floor_price: trailingFloorPrice,
          last_market_price: marketPrice,
          last_checked_at: new Date(now).toISOString(),
          updated_at: new Date(now).toISOString(),
        })
        .eq("position_id", position.positionId);
      if (error) throw new Error(error.message);
      await this.updateHealth("connected", null, marketPrice);
    } catch (error) {
      console.error("[sol-spot-paper] position check failed", error);
      await this.updateHealth("degraded", error);
    } finally {
      this.checkingPosition = false;
    }
  }

  private async closePaperPosition(
    position: OpenPosition,
    marketPrice: number,
    exitReason: "take_profit" | "stop_loss" | "trailing_stop" | "max_hold_time",
    now: number
  ): Promise<void> {
    this.closingPosition = true;
    try {
      const calculation = calculateSpotExit({
        quantity: position.quantity,
        entryFillPrice: position.entryFillPrice,
        entryFeeUsdt: position.entryFeeUsdt,
        quoteSpentUsdt: position.quoteSpentUsdt,
        marketExitPrice: marketPrice,
      });
      const closedAt = new Date(now);
      const cooldownUntil = new Date(
        now + SOL_SPOT_PAPER_CONFIG.cooldownMinutes * 60_000
      );
      const exitSnapshot = {
        strategyVersion: "sol_spot_trend_v1_2026_08_01",
        marketPrice,
        trailingFloorPrice: position.trailingFloorPrice,
        highestPriceSeen: position.highestPriceSeen,
        holdMinutes: (now - position.openedAtMs) / 60_000,
      };
      const { data, error } = await this.supabase.rpc("sol_spot_close_paper_position", {
        p_position_id: position.positionId,
        p_exit_market_price: marketPrice,
        p_exit_fill_price: calculation.exitFillPrice,
        p_exit_fee_usdt: calculation.exitFeeUsdt,
        p_gross_proceeds_usdt: calculation.grossProceedsUsdt,
        p_proceeds_usdt: calculation.proceedsUsdt,
        p_gross_pnl_usdt: calculation.grossPnlUsdt,
        p_net_pnl_usdt: calculation.netPnlUsdt,
        p_net_return_pct: calculation.netReturnPct,
        p_trailing_floor_price: position.trailingFloorPrice,
        p_highest_price_seen: position.highestPriceSeen,
        p_exit_reason: exitReason,
        p_closed_at: closedAt.toISOString(),
        p_cooldown_until: cooldownUntil.toISOString(),
        p_exit_snapshot: exitSnapshot,
        p_daily_loss_limit_usdt: SOL_SPOT_PAPER_CONFIG.dailyLossLimitUsdt,
        p_max_consecutive_losses: SOL_SPOT_PAPER_CONFIG.maxConsecutiveLosses,
        p_max_daily_entries: SOL_SPOT_PAPER_CONFIG.maxDailyEntries,
      });
      if (error) throw new Error(`Unable to close SOL spot paper position: ${error.message}`);
      this.openPosition = null;
      await sendTelegramAlert(
        [
          "🟣 <b>SOL/USDT paper position closed</b>",
          `Reason: <b>${exitReason}</b>`,
          `PnL: <b>${calculation.netPnlUsdt >= 0 ? "+" : ""}${calculation.netPnlUsdt.toFixed(2)} USDT</b>`,
          `Return: <b>${calculation.netReturnPct >= 0 ? "+" : ""}${calculation.netReturnPct.toFixed(2)}%</b>`,
          `Bankroll: <b>${finite((data as any)?.bankrollUsdt).toFixed(2)} USDT</b>`,
        ].join("\n")
      );
      console.log(
        `[sol-spot-paper] closed ${exitReason}; pnl=${calculation.netPnlUsdt.toFixed(4)} USDT`
      );
    } finally {
      this.closingPosition = false;
    }
  }

  private async recordScan(
    candle: Candle,
    decision: EntryDecision | null,
    action:
      | "warming_up"
      | "monitor"
      | "entered"
      | "position_open"
      | "cooldown"
      | "halted"
      | "disabled"
      | "standby"
      | "error",
    reasons: string[]
  ): Promise<void> {
    const { error } = await this.supabase.from("sol_spot_paper_scan_runs").upsert(
      {
        symbol: SOL_SPOT_PAPER_CONFIG.symbol,
        candle_close_time: new Date(candle.closeTimeMs).toISOString(),
        close_price: candle.close,
        score: decision?.score ?? null,
        threshold: decision?.threshold ?? SOL_SPOT_PAPER_CONFIG.entryScoreThreshold,
        passed: decision?.passed ?? false,
        action,
        reasons,
        snapshot: decision?.snapshot ?? {},
      },
      { onConflict: "symbol,candle_close_time", ignoreDuplicates: true }
    );
    if (error) throw new Error(`Unable to record SOL spot scan: ${error.message}`);
  }

  private async updateHealth(
    status: "starting" | "connected" | "degraded" | "error" | "disabled",
    error: unknown,
    marketPrice?: number,
    candleCloseTimeMs?: number
  ): Promise<void> {
    const now = new Date().toISOString();
    const payload: Record<string, unknown> = {
      connection_status: status,
      last_error: error instanceof Error ? error.message.slice(0, 500) : error ? String(error).slice(0, 500) : null,
      last_heartbeat_at: now,
      last_scan_at: candleCloseTimeMs ? now : undefined,
      updated_at: now,
    };
    if (marketPrice && marketPrice > 0) payload.last_market_price = marketPrice;
    if (candleCloseTimeMs) payload.last_candle_close_time = new Date(candleCloseTimeMs).toISOString();
    Object.keys(payload).forEach((key) => payload[key] === undefined && delete payload[key]);
    const { error: updateError } = await this.supabase
      .from("sol_spot_paper_state")
      .update(payload)
      .eq("id", 1);
    if (updateError) console.error("[sol-spot-paper] health update failed", updateError.message);
  }
}

let singleton: SolSpotPaperBot | null = null;

export function startSolSpotPaperBot(): SolSpotPaperBot | null {
  if (!SOL_SPOT_PAPER_CONFIG.enabled) {
    console.log("[sol-spot-paper] startup skipped because it is disabled");
    return null;
  }
  if (singleton) return singleton;
  singleton = new SolSpotPaperBot();
  void singleton.start().catch((error) => {
    console.error("[sol-spot-paper] fatal startup error", error);
  });
  return singleton;
}
