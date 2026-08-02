import { randomUUID } from "crypto";
import { getSupabaseAdmin } from "../lib/supabase";
import { sendTelegramAlert } from "../lib/telegram";
import { Candle, calculateSpotExit, evaluateSolSpotEntry, floorToStep } from "./solSpotPaper";

const SYMBOLS = ["SOLUSDT", "ETHUSDT", "BTCUSDT"] as const;
type SymbolName = (typeof SYMBOLS)[number];
const REST = (process.env.BINANCE_SPOT_REST_URL ?? "https://api.binance.com").replace(/\/$/, "");
const POSITION_PCT = 35;
const STARTING_BANKROLL = 1000;
const FEE_PCT = Number(process.env.MULTI_SPOT_TAKER_FEE_PCT ?? 0.1);
const SLIPPAGE_PCT = Number(process.env.MULTI_SPOT_SLIPPAGE_PCT ?? 0.03);
const STOP_PCT = Number(process.env.MULTI_SPOT_STOP_PCT ?? 0.8);
const REWARD_RISK = Number(process.env.MULTI_SPOT_REWARD_RISK ?? 1.8);
const TRAIL_ACTIVATION_R = Number(process.env.MULTI_SPOT_TRAILING_ACTIVATION_R ?? 1);
const TRAIL_GIVEBACK_PCT = Number(process.env.MULTI_SPOT_TRAILING_GIVEBACK_PCT ?? 0.6);
const MAX_HOLD_MINUTES = Number(process.env.MULTI_SPOT_MAX_HOLD_MINUTES ?? 360);
const ENTRY_THRESHOLD = Number(process.env.MULTI_SPOT_ENTRY_SCORE ?? 6);

type Rules = { quantityStep: number; minQuantity: number; minNotional: number };
type Account = { symbol: SymbolName; cash_usdt: number | string; enabled: boolean; halted: boolean };
type Position = {
  symbol: SymbolName; position_id: string; quantity: number | string; entry_fill_price: number | string;
  quote_spent_usdt: number | string; entry_fee_usdt: number | string; stop_loss_price: number | string;
  take_profit_price: number | string; trailing_activation_price: number | string; trailing_floor_price: number | string | null;
  highest_price_seen: number | string; opened_at: string; signal_snapshot: Record<string, unknown>;
};

const n = (v: unknown) => Number(v) || 0;
async function json(url: string) {
  const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`Binance HTTP ${r.status}`);
  return r.json();
}

export class MultiSpotPaperBot {
  private db = getSupabaseAdmin({ noStore: true });
  private workerId = `multi-spot-${randomUUID()}`;
  private leader = false;
  private rules = new Map<SymbolName, Rules>();
  private positions = new Map<SymbolName, Position>();
  private busy = false;

  async start() {
    await this.loadRules();
    await this.loadPositions();
    await this.claim();
    setInterval(() => void this.claim(), 15000);
    setInterval(() => void this.cycle(), 30000);
    setInterval(() => void this.checkPositions(), 5000);
    void this.cycle();
    void this.checkPositions();
    console.log(`[multi-spot-paper] started symbols=${SYMBOLS.join(",")} bankroll=${STARTING_BANKROLL} each position=${POSITION_PCT}%`);
  }

  private async claim() {
    const { data, error } = await this.db.rpc("multi_spot_claim_worker", { p_worker_id: this.workerId, p_lease_seconds: 45 });
    if (error) throw error;
    this.leader = data === true;
  }

  private async loadRules() {
    for (const symbol of SYMBOLS) {
      const p = await json(`${REST}/api/v3/exchangeInfo?symbol=${symbol}`);
      const row = p.symbols?.[0];
      const lot = row?.filters?.find((x: any) => x.filterType === "LOT_SIZE");
      const min = row?.filters?.find((x: any) => x.filterType === "NOTIONAL") ?? row?.filters?.find((x: any) => x.filterType === "MIN_NOTIONAL");
      this.rules.set(symbol, { quantityStep: n(lot?.stepSize), minQuantity: n(lot?.minQty), minNotional: n(min?.minNotional ?? min?.notional) });
    }
  }

  private async loadPositions() {
    const { data, error } = await this.db.from("multi_spot_paper_positions").select("*");
    if (error) throw error;
    for (const row of data ?? []) this.positions.set(row.symbol as SymbolName, row as Position);
  }

  private async candles(symbol: SymbolName, interval: "5m" | "1h", limit: number): Promise<Candle[]> {
    const rows = await json(`${REST}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    const now = Date.now();
    return rows.map((r: any[]) => ({ open:n(r[1]), high:n(r[2]), low:n(r[3]), close:n(r[4]), quoteVolume:n(r[7]), closeTimeMs:n(r[6]) }))
      .filter((r: Candle) => r.close > 0 && r.closeTimeMs < now);
  }

  private async price(symbol: SymbolName) { return n((await json(`${REST}/api/v3/ticker/price?symbol=${symbol}`)).price); }

  private async cycle() {
    if (!this.leader || this.busy) return;
    this.busy = true;
    try { for (const symbol of SYMBOLS) await this.scanSymbol(symbol); }
    catch (e) { await this.db.from("multi_spot_paper_worker_state").update({ last_error: String(e), updated_at: new Date().toISOString() }).eq("id",1); }
    finally { this.busy = false; }
  }

  private async scanSymbol(symbol: SymbolName) {
    const [five, hour, accountResult] = await Promise.all([
      this.candles(symbol,"5m",120), this.candles(symbol,"1h",80),
      this.db.from("multi_spot_paper_accounts").select("*").eq("symbol",symbol).single(),
    ]);
    if (accountResult.error) throw accountResult.error;
    const account = accountResult.data as Account;
    const latest = five.at(-1)!;
    const candleIso = new Date(latest.closeTimeMs).toISOString();
    const existing = await this.db.from("multi_spot_paper_scan_runs").select("id").eq("symbol",symbol).eq("candle_close_time",candleIso).maybeSingle();
    if (existing.data) return;
    if (!account.enabled || account.halted) return this.record(symbol, latest, null, "blocked", [account.halted ? "halted" : "disabled"]);
    if (this.positions.has(symbol)) return this.record(symbol, latest, null, "position_open", ["per_symbol_position_limit"]);

    const decision = evaluateSolSpotEntry(five, hour, ENTRY_THRESHOLD);
    if (!decision.passed) return this.record(symbol, latest, decision, "monitor", decision.blockers);
    const rules = this.rules.get(symbol)!;
    const market = await this.price(symbol);
    const available = n(account.cash_usdt);
    const grossBudget = Math.min(STARTING_BANKROLL * POSITION_PCT / 100, available * 0.95);
    const fill = market * (1 + SLIPPAGE_PCT / 100);
    const feeRate = FEE_PCT / 100;
    const qty = floorToStep(grossBudget / (fill * (1 + feeRate)), rules.quantityStep);
    const principal = qty * fill;
    if (qty < rules.minQuantity || principal < rules.minNotional) return this.record(symbol, latest, decision, "monitor", ["below_exchange_minimum"]);
    const entryFee = principal * feeRate;
    const spent = principal + entryFee;
    const stopDistance = Math.max(STOP_PCT, decision.stopDistancePct);
    const position: Position = {
      symbol, position_id: randomUUID(), quantity: qty, entry_fill_price: fill, quote_spent_usdt: spent,
      entry_fee_usdt: entryFee, stop_loss_price: fill * (1-stopDistance/100),
      take_profit_price: fill * (1+(stopDistance*REWARD_RISK)/100),
      trailing_activation_price: fill * (1+(stopDistance*TRAIL_ACTIVATION_R)/100),
      trailing_floor_price: null, highest_price_seen: market, opened_at: new Date().toISOString(),
      signal_snapshot: { strategyVersion:"multi_spot_trend_v1_2026_08_02", symbol, bankrollUsdt:STARTING_BANKROLL, positionPct:POSITION_PCT, decision:decision.snapshot }
    };
    const insert = await this.db.from("multi_spot_paper_positions").insert({ ...position, last_checked_at:new Date().toISOString() });
    if (insert.error) throw insert.error;
    const update = await this.db.from("multi_spot_paper_accounts").update({ cash_usdt:available-spent, entries_today:n((accountResult.data as any).entries_today)+1, updated_at:new Date().toISOString() }).eq("symbol",symbol);
    if (update.error) throw update.error;
    this.positions.set(symbol, position);
    await this.record(symbol, latest, decision, "entered", []);
    await sendTelegramAlert(`🟦 <b>${symbol} paper opened</b>\nSize: <b>${spent.toFixed(2)} USDT</b>\nEntry: <b>${fill.toFixed(4)}</b>\nTarget: <b>${n(position.take_profit_price).toFixed(4)}</b>`);
  }

  private async checkPositions() {
    if (!this.leader) return;
    for (const [symbol, p] of [...this.positions]) {
      const market = await this.price(symbol);
      const highest = Math.max(n(p.highest_price_seen), market);
      let trailing = p.trailing_floor_price == null ? null : n(p.trailing_floor_price);
      if (market >= n(p.trailing_activation_price)) {
        const breakeven = n(p.entry_fill_price) * (1 + (2*(FEE_PCT+SLIPPAGE_PCT))/100);
        trailing = Math.max(trailing ?? 0, breakeven, highest * (1-TRAIL_GIVEBACK_PCT/100));
      }
      const held = (Date.now()-Date.parse(p.opened_at))/60000;
      let reason: string | null = null;
      if (market <= n(p.stop_loss_price)) reason="stop_loss";
      else if (market >= n(p.take_profit_price)) reason="take_profit";
      else if (trailing && market <= trailing) reason="trailing_stop";
      else if (held >= MAX_HOLD_MINUTES) reason="max_hold";
      if (reason) await this.close(symbol,p,market,reason,highest,trailing);
      else {
        p.highest_price_seen=highest; p.trailing_floor_price=trailing;
        await this.db.from("multi_spot_paper_positions").update({ highest_price_seen:highest, trailing_floor_price:trailing, last_checked_at:new Date().toISOString() }).eq("symbol",symbol);
      }
    }
  }

  private async close(symbol: SymbolName, p: Position, market: number, reason: string, highest: number, trailing: number|null) {
    const result = calculateSpotExit({ quantity:n(p.quantity), entryFillPrice:n(p.entry_fill_price), entryFeeUsdt:n(p.entry_fee_usdt), quoteSpentUsdt:n(p.quote_spent_usdt), marketExitPrice:market, exitSlippagePct:SLIPPAGE_PCT, feePct:FEE_PCT });
    const account = await this.db.from("multi_spot_paper_accounts").select("*").eq("symbol",symbol).single();
    if (account.error) throw account.error;
    const a = account.data as any;
    await this.db.from("multi_spot_paper_trades").insert({ position_id:p.position_id,symbol,quantity:n(p.quantity),entry_fill_price:n(p.entry_fill_price),exit_fill_price:result.exitFillPrice,quote_spent_usdt:n(p.quote_spent_usdt),proceeds_usdt:result.proceedsUsdt,net_pnl_usdt:result.netPnlUsdt,net_return_pct:result.netReturnPct,exit_reason:reason,opened_at:p.opened_at,closed_at:new Date().toISOString(),signal_snapshot:p.signal_snapshot,exit_snapshot:{market,highest,trailing} });
    await this.db.from("multi_spot_paper_positions").delete().eq("symbol",symbol);
    await this.db.from("multi_spot_paper_accounts").update({ cash_usdt:n(a.cash_usdt)+result.proceedsUsdt,realized_pnl_usdt:n(a.realized_pnl_usdt)+result.netPnlUsdt,daily_realized_pnl_usdt:n(a.daily_realized_pnl_usdt)+result.netPnlUsdt,consecutive_losses:result.netPnlUsdt<0?n(a.consecutive_losses)+1:0,updated_at:new Date().toISOString() }).eq("symbol",symbol);
    this.positions.delete(symbol);
    await sendTelegramAlert(`✅ <b>${symbol} paper closed</b>\nReason: <b>${reason}</b>\nPnL: <b>${result.netPnlUsdt>=0?"+":""}${result.netPnlUsdt.toFixed(2)} USDT</b>`);
  }

  private async record(symbol: SymbolName, candle: Candle, decision: any, action: string, reasons: string[]) {
    await this.db.from("multi_spot_paper_scan_runs").insert({ symbol,candle_close_time:new Date(candle.closeTimeMs).toISOString(),close_price:candle.close,score:decision?.score??null,threshold:decision?.threshold??ENTRY_THRESHOLD,passed:Boolean(decision?.passed),action,reasons,snapshot:decision?.snapshot??{} });
  }
}
