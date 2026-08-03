import express, { type Request, type Response } from "express";
import { getSupabaseAdmin } from "../lib/supabase";
import {
  executeExactInSwap,
  getQuote,
  getTokenBalanceRaw,
  getWalletPublicKey,
} from "./marketExecutor";

const PORT = Number(process.env.PORT ?? 3000);
const JUPITER_API_KEY = required("JUPITER_API_KEY");
const USDC_MINT = process.env.USDC_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MODE = process.env.MARKET_BOT_MODE === "live" ? "live" : "paper";
const ENABLED = process.env.MARKET_BOT_ENABLED === "true";
const SCAN_MS = positiveInt("MARKET_SCAN_MS", 30_000);
const POSITION_CHECK_MS = positiveInt("MARKET_POSITION_CHECK_MS", 5_000);
const TRADE_SIZE_USDC = positiveNumber("MARKET_TRADE_SIZE_USDC", 3);
const MIN_SCORE = positiveNumber("MARKET_MIN_SCORE", 78);
const MIN_LIQUIDITY_USD = positiveNumber("MARKET_MIN_LIQUIDITY_USD", 500_000);
const MIN_MCAP_USD = positiveNumber("MARKET_MIN_MCAP_USD", 5_000_000);
const MAX_PRICE_IMPACT_PCT = positiveNumber("MARKET_MAX_PRICE_IMPACT_PCT", 1);
const MIN_ROUND_TRIP_PCT = positiveNumber("MARKET_MIN_ROUND_TRIP_PCT", 98.5);
const MIN_5M_CHANGE_PCT = positiveNumber("MARKET_MIN_5M_CHANGE_PCT", 0.10);
const MAX_5M_CHANGE_PCT = positiveNumber("MARKET_MAX_5M_CHANGE_PCT", 2.50);
const MIN_1H_CHANGE_PCT = positiveNumber("MARKET_MIN_1H_CHANGE_PCT", 0.25);
const MAX_1H_CHANGE_PCT = positiveNumber("MARKET_MAX_1H_CHANGE_PCT", 6);
const MIN_5M_BUY_VOLUME_RATIO = positiveNumber("MARKET_MIN_5M_BUY_VOLUME_RATIO", 1.10);
const MIN_1H_BUY_VOLUME_RATIO = positiveNumber("MARKET_MIN_1H_BUY_VOLUME_RATIO", 1.00);
const MIN_5M_TRADERS = positiveInt("MARKET_MIN_5M_TRADERS", 10);
const MAX_24H_DRAWDOWN_PCT = positiveNumber("MARKET_MAX_24H_DRAWDOWN_PCT", 8);
const MAX_24H_LIQUIDITY_DROP_PCT = positiveNumber("MARKET_MAX_24H_LIQUIDITY_DROP_PCT", 8);
const TAKE_PROFIT_PCT = positiveNumber("MARKET_TAKE_PROFIT_PCT", 2);
const STOP_LOSS_PCT = positiveNumber("MARKET_STOP_LOSS_PCT", 1.5);
const TRAILING_ACTIVATION_PCT = positiveNumber("MARKET_TRAILING_ACTIVATION_PCT", 0.8);
const TRAILING_STOP_PCT = positiveNumber("MARKET_TRAILING_STOP_PCT", 0.8);
const MAX_HOLD_MINUTES = positiveInt("MARKET_MAX_HOLD_MINUTES", 45);
const MAX_DAILY_LOSS_USDC = positiveNumber("MARKET_MAX_DAILY_LOSS_USDC", 1);
const MAX_DAILY_ENTRIES = positiveInt("MARKET_MAX_DAILY_ENTRIES", 5);
const COOLDOWN_MINUTES = positiveInt("MARKET_REENTRY_COOLDOWN_MINUTES", 120);

const supabase = getSupabaseAdmin();
const stableSymbols = new Set(["USDC", "USDT", "USDG", "PYUSD", "USDS", "DAI", "SOL", "WSOL"]);
const recentMints = new Map<string, number>();
let scanBusy = false;
let positionBusy = false;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
function positiveNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
function n(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
function usdcRaw(value: number): string {
  return String(Math.floor(value * 1_000_000));
}
function usdcFromRaw(value: string | number | bigint): number {
  return Number(value) / 1_000_000;
}
function volumeRatio(buyVolume: number, sellVolume: number): number {
  if (sellVolume > 0) return buyVolume / sellVolume;
  return buyVolume > 0 ? 2 : 0;
}

async function jup(path: string): Promise<any> {
  const response = await fetch(`https://api.jup.ag${path}`, {
    headers: { accept: "application/json", "x-api-key": JUPITER_API_KEY },
    signal: AbortSignal.timeout(12_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`jupiter_market_http_${response.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

async function telegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`telegram_http_${response.status}`);
}

type Position = {
  tradeId: number;
  mint: string;
  symbol: string;
  name: string;
  score: number;
  entryPriceUsd: number;
  highWaterPriceUsd: number;
  highWaterExitUsdc: number;
  sizeUsdc: number;
  tokenAmountRaw: string;
  tokenDecimals: number;
  openedAt: string;
  entryTx: string | null;
};

type Candidate = {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  price: number;
  liquidity: number;
  mcap: number;
  holders: number;
  organic: number;
  verified: boolean;
  buys: number;
  sells: number;
  volume: number;
  priceChange: number;
  priceChange5m: number;
  priceChange1h: number;
  priceChange24h: number;
  liquidityChange24h: number;
  buyVolumeRatio5m: number;
  buyVolumeRatio1h: number;
  traders5m: number;
  score: number;
  reasons: string[];
  raw: any;
};

async function loadState(): Promise<any> {
  const { data, error } = await supabase
    .from("single_market_bot_state")
    .select("*")
    .eq("id", "main")
    .single();
  if (error) throw error;
  if (data.daily_date !== todayUtc()) {
    const { data: reset, error: resetError } = await supabase
      .from("single_market_bot_state")
      .update({ daily_date: todayUtc(), daily_realized_pnl_usdc: 0, entries_today: 0, halted: false, halt_reason: null })
      .eq("id", "main")
      .select("*")
      .single();
    if (resetError) throw resetError;
    return reset;
  }
  return data;
}

async function patchState(values: Record<string, unknown>): Promise<void> {
  const { error } = await supabase
    .from("single_market_bot_state")
    .update({ ...values, updated_at: new Date().toISOString() })
    .eq("id", "main");
  if (error) throw error;
}

function scoreToken(token: any): Candidate | null {
  const mint = String(token?.id ?? token?.address ?? "");
  const symbol = String(token?.symbol ?? "").toUpperCase();
  if (!mint || stableSymbols.has(symbol)) return null;

  const s5m = token?.stats5m;
  const s1h = token?.stats1h;
  const s24h = token?.stats24h ?? {};
  if (!s5m || !s1h) return null;

  const price = n(token?.usdPrice);
  const liquidity = n(token?.liquidity ?? token?.liquidityUsd ?? token?.stats24h?.liquidity);
  const mcap = n(token?.mcap ?? token?.marketCap);
  const holders = n(token?.holderCount);
  const organic = n(token?.organicScore);
  const verified = token?.isVerified === true || (Array.isArray(token?.tags) && token.tags.includes("verified"));
  const audit = token?.audit ?? {};

  const buys5m = n(s5m?.numBuys ?? s5m?.buys);
  const sells5m = n(s5m?.numSells ?? s5m?.sells);
  const buys1h = n(s1h?.numBuys ?? s1h?.buys);
  const sells1h = n(s1h?.numSells ?? s1h?.sells);
  const buyVolume5m = n(s5m?.buyVolume);
  const sellVolume5m = n(s5m?.sellVolume);
  const buyVolume1h = n(s1h?.buyVolume);
  const sellVolume1h = n(s1h?.sellVolume);
  const buyVolumeRatio5m = volumeRatio(buyVolume5m, sellVolume5m);
  const buyVolumeRatio1h = volumeRatio(buyVolume1h, sellVolume1h);
  const traders5m = n(s5m?.numTraders);
  const volume1h = buyVolume1h + sellVolume1h;
  const priceChange5m = n(s5m?.priceChange, Number.NaN);
  const priceChange1h = n(s1h?.priceChange, Number.NaN);
  const priceChange24h = n(s24h?.priceChange);
  const liquidityChange24h = n(s24h?.liquidityChange);

  if (price <= 0 || liquidity < MIN_LIQUIDITY_USD || mcap < MIN_MCAP_USD) return null;
  if (!Number.isFinite(priceChange5m) || !Number.isFinite(priceChange1h)) return null;
  if (priceChange5m < MIN_5M_CHANGE_PCT || priceChange5m > MAX_5M_CHANGE_PCT) return null;
  if (priceChange1h < MIN_1H_CHANGE_PCT || priceChange1h > MAX_1H_CHANGE_PCT) return null;
  if (buyVolumeRatio5m < MIN_5M_BUY_VOLUME_RATIO || buyVolumeRatio1h < MIN_1H_BUY_VOLUME_RATIO) return null;
  if (traders5m < MIN_5M_TRADERS) return null;
  if (priceChange24h < -MAX_24H_DRAWDOWN_PCT) return null;
  if (liquidityChange24h < -MAX_24H_LIQUIDITY_DROP_PCT) return null;
  if (audit?.mintAuthorityDisabled !== true || audit?.freezeAuthorityDisabled !== true) return null;

  let score = 0;
  const reasons: string[] = [];
  if (verified) { score += 10; reasons.push("verified"); }
  if (organic >= 80) { score += 16; reasons.push("high organic activity"); }
  else if (organic >= 60) { score += 10; reasons.push("medium organic activity"); }
  if (liquidity >= 5_000_000) { score += 14; reasons.push("deep liquidity"); }
  else if (liquidity >= 1_000_000) { score += 10; reasons.push("good liquidity"); }
  else score += 5;
  if (mcap >= 25_000_000) score += 8;
  else score += 5;
  if (holders >= 25_000) score += 8;
  else if (holders >= 5_000) score += 5;

  if (priceChange5m >= 0.25 && priceChange5m <= 1.5) { score += 18; reasons.push("5m momentum confirmed"); }
  else score += 10;
  if (priceChange1h >= 0.5 && priceChange1h <= 4) { score += 12; reasons.push("1h trend aligned"); }
  else score += 6;
  if (buyVolumeRatio5m >= 1.25) { score += 12; reasons.push("5m buy-volume pressure"); }
  else score += 6;
  if (buyVolumeRatio1h >= 1.10) score += 6;
  if (volume1h >= 500_000) score += 6;
  if (priceChange24h >= 0) score += 4;
  if (liquidityChange24h >= 0) score += 4;

  return {
    mint,
    symbol: symbol || mint.slice(0, 6),
    name: String(token?.name ?? symbol ?? mint),
    decimals: Math.max(0, Math.min(12, n(token?.decimals, 6))),
    price,
    liquidity,
    mcap,
    holders,
    organic,
    verified,
    buys: buys1h,
    sells: sells1h,
    volume: volume1h,
    priceChange: priceChange1h,
    priceChange5m,
    priceChange1h,
    priceChange24h,
    liquidityChange24h,
    buyVolumeRatio5m,
    buyVolumeRatio1h,
    traders5m,
    score,
    reasons,
    raw: token,
  };
}

async function marketCandidates(): Promise<Candidate[]> {
  const paths = [
    "/tokens/v2/toptrending/1h?limit=50",
    "/tokens/v2/toptraded/1h?limit=50",
    "/tokens/v2/toporganicscore/1h?limit=50",
  ];
  const responses = await Promise.all(paths.map((path) => jup(path)));
  const merged = new Map<string, any>();
  for (const list of responses) {
    for (const token of Array.isArray(list) ? list : []) {
      const mint = String(token?.id ?? token?.address ?? "");
      if (!mint) continue;
      merged.set(mint, { ...(merged.get(mint) ?? {}), ...token });
    }
  }
  return [...merged.values()]
    .map(scoreToken)
    .filter((item): item is Candidate => Boolean(item))
    .sort((a, b) => b.score - a.score);
}

async function tokenPrice(mint: string): Promise<number> {
  const result = await jup(`/price/v3?ids=${encodeURIComponent(mint)}`);
  const price = n(result?.[mint]?.usdPrice);
  if (price <= 0) throw new Error("price_unavailable");
  return price;
}

async function validateRoundTrip(candidate: Candidate): Promise<{ buyQuote: any; sellQuote: any; recoveryPct: number }> {
  const buyQuote = await getQuote(USDC_MINT, candidate.mint, usdcRaw(TRADE_SIZE_USDC));
  const impact = n(buyQuote.priceImpactPct) * 100;
  if (impact > MAX_PRICE_IMPACT_PCT) throw new Error(`price_impact_${impact.toFixed(2)}pct`);
  const sellQuote = await getQuote(candidate.mint, USDC_MINT, String(buyQuote.outAmount));
  const recoveryPct = Number((BigInt(sellQuote.outAmount) * 10_000n) / BigInt(usdcRaw(TRADE_SIZE_USDC))) / 100;
  if (recoveryPct < MIN_ROUND_TRIP_PCT) throw new Error(`round_trip_${recoveryPct.toFixed(2)}pct`);
  return { buyQuote, sellQuote, recoveryPct };
}

async function openPosition(candidate: Candidate): Promise<void> {
  const state = await loadState();
  const validation = await validateRoundTrip(candidate);
  let tokenAmountRaw = String(validation.buyQuote.outAmount);
  let entryTx: string | null = null;
  if (MODE === "live") {
    const result = await executeExactInSwap(USDC_MINT, candidate.mint, usdcRaw(TRADE_SIZE_USDC));
    tokenAmountRaw = result.expectedOutputRaw;
    entryTx = result.signature;
  }

  const initialExitUsdc = usdcFromRaw(validation.sellQuote.outAmount);
  const { data: trade, error } = await supabase
    .from("single_market_bot_trades")
    .insert({
      status: MODE === "live" ? "open" : "paper_open",
      mode: MODE,
      mint: candidate.mint,
      symbol: candidate.symbol,
      name: candidate.name,
      score: candidate.score,
      entry_price_usd: candidate.price,
      size_usdc: TRADE_SIZE_USDC,
      token_amount_raw: tokenAmountRaw,
      token_decimals: candidate.decimals,
      high_water_price_usd: candidate.price,
      entry_tx: entryTx,
      metadata: {
        reasons: candidate.reasons,
        recoveryPct: validation.recoveryPct,
        entryTiming: {
          priceChange5m: candidate.priceChange5m,
          priceChange1h: candidate.priceChange1h,
          priceChange24h: candidate.priceChange24h,
          liquidityChange24h: candidate.liquidityChange24h,
          buyVolumeRatio5m: candidate.buyVolumeRatio5m,
          buyVolumeRatio1h: candidate.buyVolumeRatio1h,
          traders5m: candidate.traders5m,
        },
        candidate: candidate.raw,
      },
    })
    .select("id")
    .single();
  if (error) throw error;

  const position: Position = {
    tradeId: Number(trade.id),
    mint: candidate.mint,
    symbol: candidate.symbol,
    name: candidate.name,
    score: candidate.score,
    entryPriceUsd: candidate.price,
    highWaterPriceUsd: candidate.price,
    highWaterExitUsdc: initialExitUsdc,
    sizeUsdc: TRADE_SIZE_USDC,
    tokenAmountRaw,
    tokenDecimals: candidate.decimals,
    openedAt: new Date().toISOString(),
    entryTx,
  };
  recentMints.set(candidate.mint, Date.now());
  await patchState({
    open_position: position,
    entries_today: n(state.entries_today) + 1,
    cash_usdc: MODE === "paper" ? n(state.cash_usdc) - TRADE_SIZE_USDC : state.cash_usdc,
    last_error: null,
  });
  await telegram(`🟢 Market bot ${MODE.toUpperCase()} entry\n${candidate.symbol}\nScore: ${candidate.score}\nSize: ${TRADE_SIZE_USDC} USDC\n5m: ${candidate.priceChange5m.toFixed(2)}% · 1h: ${candidate.priceChange1h.toFixed(2)}%\n5m buy-volume ratio: ${candidate.buyVolumeRatio5m.toFixed(2)}\nReasons: ${candidate.reasons.join(", ")}\nTx: ${entryTx ?? "paper"}`);
}

function exitReason(position: Position, executableExitUsdc: number): string | null {
  const pnlPct = ((executableExitUsdc / position.sizeUsdc) - 1) * 100;
  const highWater = Math.max(position.highWaterExitUsdc || position.sizeUsdc, position.sizeUsdc * 0.01);
  const drawdownFromHigh = ((executableExitUsdc / highWater) - 1) * 100;
  const ageMinutes = (Date.now() - Date.parse(position.openedAt)) / 60_000;
  if (pnlPct >= TAKE_PROFIT_PCT) return "take_profit";
  if (pnlPct <= -STOP_LOSS_PCT) return "hard_stop";
  if (highWater >= position.sizeUsdc * (1 + TRAILING_ACTIVATION_PCT / 100) && drawdownFromHigh <= -TRAILING_STOP_PCT) return "trailing_stop";
  if (ageMinutes >= MAX_HOLD_MINUTES) return "max_hold";
  return null;
}

async function executableExitValue(position: Position, price: number): Promise<number> {
  if (MODE !== "paper") return position.sizeUsdc * (price / position.entryPriceUsd);
  const quote = await getQuote(position.mint, USDC_MINT, position.tokenAmountRaw);
  const exitUsdc = usdcFromRaw(quote.outAmount);
  if (!Number.isFinite(exitUsdc) || exitUsdc < 0) throw new Error("paper_exit_quote_invalid");
  return exitUsdc;
}

async function closePosition(position: Position, price: number, reason: string, quotedExitUsdc?: number): Promise<void> {
  const state = await loadState();
  let exitTx: string | null = null;
  let exitUsdc = quotedExitUsdc ?? position.sizeUsdc * (price / position.entryPriceUsd);
  if (MODE === "live") {
    const balance = await getTokenBalanceRaw(position.mint);
    if (BigInt(balance.amountRaw) <= 0n) throw new Error("position_token_balance_zero");
    const result = await executeExactInSwap(position.mint, USDC_MINT, balance.amountRaw);
    exitTx = result.signature;
    exitUsdc = usdcFromRaw(result.expectedOutputRaw);
  }
  const pnl = exitUsdc - position.sizeUsdc;
  const pnlPct = (pnl / position.sizeUsdc) * 100;
  const dailyPnl = n(state.daily_realized_pnl_usdc) + pnl;
  const totalPnl = n(state.realized_pnl_usdc) + pnl;
  const halted = dailyPnl <= -MAX_DAILY_LOSS_USDC;

  const { error } = await supabase
    .from("single_market_bot_trades")
    .update({
      status: MODE === "live" ? "closed" : "paper_closed",
      updated_at: new Date().toISOString(),
      exit_price_usd: price,
      exit_tx: exitTx,
      exit_reason: reason,
      pnl_usdc: pnl,
      pnl_pct: pnlPct,
      high_water_price_usd: position.highWaterPriceUsd,
    })
    .eq("id", position.tradeId);
  if (error) throw error;

  await patchState({
    open_position: null,
    cash_usdc: MODE === "paper" ? n(state.cash_usdc) + exitUsdc : state.cash_usdc,
    realized_pnl_usdc: totalPnl,
    daily_realized_pnl_usdc: dailyPnl,
    halted,
    halt_reason: halted ? "daily_loss_limit" : null,
    last_error: null,
  });
  await telegram(`${pnl >= 0 ? "🟢" : "🔴"} Market bot ${MODE.toUpperCase()} exit\n${position.symbol}\nReason: ${reason}\nExecutable exit: ${exitUsdc.toFixed(4)} USDC\nPnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(3)} USDC (${pnlPct.toFixed(2)}%)\nTx: ${exitTx ?? "paper"}`);
}

async function scanOnce(): Promise<void> {
  if (scanBusy) return;
  scanBusy = true;
  try {
    const state = await loadState();
    const effectiveEnabled = ENABLED && state.enabled !== false;
    if (!effectiveEnabled || state.halted || state.open_position || n(state.entries_today) >= MAX_DAILY_ENTRIES) {
      await patchState({ last_heartbeat_at: new Date().toISOString() });
      return;
    }
    const candidates = await marketCandidates();
    const eligible = candidates.filter((candidate) => {
      const last = recentMints.get(candidate.mint) ?? 0;
      return candidate.score >= MIN_SCORE && Date.now() - last >= COOLDOWN_MINUTES * 60_000;
    });
    await patchState({
      last_scan_at: new Date().toISOString(),
      last_heartbeat_at: new Date().toISOString(),
      scanner_snapshot: {
        strategyVersion: "market_timing_v2_2026_08_03",
        scanned: candidates.length,
        eligible: eligible.length,
        top: candidates.slice(0, 10).map((c) => ({
          mint: c.mint,
          symbol: c.symbol,
          score: c.score,
          price: c.price,
          liquidity: c.liquidity,
          priceChange: c.priceChange1h,
          priceChange5m: c.priceChange5m,
          priceChange24h: c.priceChange24h,
          buyVolumeRatio5m: c.buyVolumeRatio5m,
          reasons: c.reasons,
        })),
      },
      last_error: null,
    });
    for (const candidate of eligible.slice(0, 5)) {
      try {
        await openPosition(candidate);
        break;
      } catch (error) {
        await patchState({ last_error: `${candidate.symbol}: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
  } catch (error) {
    await patchState({ last_error: error instanceof Error ? error.message : String(error), last_heartbeat_at: new Date().toISOString() }).catch(() => undefined);
  } finally {
    scanBusy = false;
  }
}

async function checkPosition(): Promise<void> {
  if (positionBusy) return;
  positionBusy = true;
  try {
    const state = await loadState();
    const position = state.open_position as Position | null;
    if (!position) return;
    const price = await tokenPrice(position.mint);
    if (state.last_error) await patchState({ last_error: null });
    const executableExitUsdc = await executableExitValue(position, price);
    let positionChanged = false;
    if (price > position.highWaterPriceUsd) {
      position.highWaterPriceUsd = price;
      positionChanged = true;
      await supabase.from("single_market_bot_trades").update({ high_water_price_usd: price, updated_at: new Date().toISOString() }).eq("id", position.tradeId);
    }
    if (!position.highWaterExitUsdc || executableExitUsdc > position.highWaterExitUsdc) {
      position.highWaterExitUsdc = executableExitUsdc;
      positionChanged = true;
    }
    if (positionChanged) await patchState({ open_position: position });
    const reason = exitReason(position, executableExitUsdc);
    if (reason) await closePosition(position, price, reason, executableExitUsdc);
  } catch (error) {
    await patchState({ last_error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
  } finally {
    positionBusy = false;
  }
}

async function bootstrap(): Promise<void> {
  await patchState({
    enabled: ENABLED,
    mode: MODE,
    last_heartbeat_at: new Date().toISOString(),
    last_error: null,
  });
  void scanOnce();
  void checkPosition();
  setInterval(() => void scanOnce(), SCAN_MS);
  setInterval(() => void checkPosition(), POSITION_CHECK_MS);
}

const app = express();
app.disable("x-powered-by");
app.get("/health", async (_req: Request, res: Response) => {
  try {
    const state = await loadState();
    res.json({ ok: true, service: "single-market-bot", wallet: getWalletPublicKey(), config: { enabled: ENABLED, mode: MODE, tradeSizeUsdc: TRADE_SIZE_USDC }, state });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
app.get("/api/status", async (_req: Request, res: Response) => {
  const state = await loadState();
  const { data: trades } = await supabase.from("single_market_bot_trades").select("*").order("created_at", { ascending: false }).limit(20);
  res.setHeader("cache-control", "no-store");
  res.json({
    service: "single-market-bot",
    wallet: getWalletPublicKey(),
    config: {
      enabled: ENABLED,
      mode: MODE,
      strategyVersion: "market_timing_v2_2026_08_03",
      tradeSizeUsdc: TRADE_SIZE_USDC,
      minScore: MIN_SCORE,
      min5mChangePct: MIN_5M_CHANGE_PCT,
      max5mChangePct: MAX_5M_CHANGE_PCT,
      min5mBuyVolumeRatio: MIN_5M_BUY_VOLUME_RATIO,
      takeProfitPct: TAKE_PROFIT_PCT,
      stopLossPct: STOP_LOSS_PCT,
      trailingActivationPct: TRAILING_ACTIVATION_PCT,
      trailingStopPct: TRAILING_STOP_PCT,
      maxHoldMinutes: MAX_HOLD_MINUTES,
      maxDailyLossUsdc: MAX_DAILY_LOSS_USDC,
    },
    state,
    trades: trades ?? [],
  });
});
app.get("/", (_req: Request, res: Response) => {
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Solana Market Bot</title><style>body{font-family:system-ui;background:#081019;color:#edf5ff;margin:0;padding:22px}.wrap{max-width:1100px;margin:auto}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}.card{background:#111c29;border:1px solid #26384d;border-radius:14px;padding:15px;margin:12px 0}.v{font-size:24px;font-weight:750}.muted{color:#9fb2c9}table{width:100%;border-collapse:collapse}td,th{padding:9px;border-bottom:1px solid #26384d;text-align:left;font-size:12px}code{word-break:break-all;color:#b9d8ff}.on{color:#6ce89a}.off{color:#ffc766}.bad{color:#ff7e7e}</style></head><body><div class="wrap"><h1>Solana Market Bot</h1><div class="muted">Jupiter market-wide scanner · timing v2 · executable paper exits · Telegram alerts</div><div id="app">Loading…</div></div><script>const f=n=>Number(n||0);async function r(){const x=await fetch('/api/status',{cache:'no-store'}).then(r=>r.json()),s=x.state||{},p=s.open_position,top=s.scanner_snapshot?.top||[],tr=x.trades||[];document.getElementById('app').innerHTML='<div class="grid"><div class="card"><div class="muted">Mode</div><div class="v '+(x.config.enabled?'on':'off')+'">'+(x.config.enabled?x.config.mode.toUpperCase():'DISABLED')+'</div></div><div class="card"><div class="muted">Cash</div><div class="v">'+f(s.cash_usdc).toFixed(2)+' USDC</div></div><div class="card"><div class="muted">PnL</div><div class="v '+(f(s.realized_pnl_usdc)<0?'bad':'on')+'">'+f(s.realized_pnl_usdc).toFixed(3)+'</div></div><div class="card"><div class="muted">Entries today</div><div class="v">'+f(s.entries_today)+'</div></div><div class="card"><div class="muted">Scanned</div><div class="v">'+f(s.scanner_snapshot?.scanned)+'</div></div></div><div class="card"><div class="muted">Strategy</div><div>'+x.config.strategyVersion+'</div><div class="muted" style="margin-top:8px">Wallet</div><code>'+x.wallet+'</code><div class="muted" style="margin-top:8px">Open position</div><div>'+(p?p.symbol+' · '+p.sizeUsdc+' USDC · score '+p.score:'None')+'</div><div class="muted" style="margin-top:8px">Last error</div><div>'+(s.last_error||'None')+'</div></div><div class="card"><h2>Top market candidates</h2><table><tr><th>Token</th><th>Score</th><th>5m</th><th>1h</th><th>5m buy vol.</th><th>Liquidity</th></tr>'+top.map(t=>'<tr><td>'+t.symbol+'</td><td>'+t.score+'</td><td>'+f(t.priceChange5m).toFixed(2)+'%</td><td>'+f(t.priceChange).toFixed(2)+'%</td><td>'+f(t.buyVolumeRatio5m).toFixed(2)+'x</td><td>$'+Math.round(f(t.liquidity)).toLocaleString()+'</td></tr>').join('')+'</table></div><div class="card"><h2>Recent trades</h2><table><tr><th>Time</th><th>Token</th><th>Status</th><th>Size</th><th>PnL</th><th>Exit</th></tr>'+tr.map(t=>'<tr><td>'+t.created_at+'</td><td>'+t.symbol+'</td><td>'+t.status+'</td><td>'+t.size_usdc+'</td><td>'+(t.pnl_usdc??'—')+'</td><td>'+(t.exit_reason??'—')+'</td></tr>').join('')+'</table></div>';}r();setInterval(r,5000)</script></body></html>`);
});

app.listen(PORT, "0.0.0.0", () => console.log(`[single-market-bot] listening port=${PORT} enabled=${ENABLED} mode=${MODE} wallet=${getWalletPublicKey()} strategy=market_timing_v2_2026_08_03`));
bootstrap().catch((error) => { console.error("[single-market-bot] bootstrap failed", error); process.exit(1); });
