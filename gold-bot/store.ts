import { getSupabaseAdmin } from "../lib/supabase";
import type {
  GoldBotState,
  GoldPaperPosition,
  GoldSignal,
  GoldSide,
} from "./types";

export class GoldPaperStore {
  private readonly supabase = getSupabaseAdmin();

  constructor(private readonly botId: string) {}

  private throwIfError(error: { message?: string } | null, context: string): void {
    if (error) throw new Error(`${context}: ${error.message ?? "unknown Supabase error"}`);
  }

  async ensureState(startingBalanceUsd: number): Promise<GoldBotState> {
    const existing = await this.getStateOrNull();
    if (existing) return existing;

    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await this.supabase
      .from("gold_bot_state")
      .insert({
        bot_id: this.botId,
        balance_usd: startingBalanceUsd,
        daily_start_balance_usd: startingBalanceUsd,
        daily_date: today,
        paused: false,
        pause_reason: null,
      })
      .select("*")
      .single();
    this.throwIfError(error, "create gold bot state");
    return data as GoldBotState;
  }

  private async getStateOrNull(): Promise<GoldBotState | null> {
    const { data, error } = await this.supabase
      .from("gold_bot_state")
      .select("*")
      .eq("bot_id", this.botId)
      .maybeSingle();
    this.throwIfError(error, "read gold bot state");
    return (data as GoldBotState | null) ?? null;
  }

  async getState(): Promise<GoldBotState> {
    const state = await this.getStateOrNull();
    if (!state) throw new Error(`Gold bot state ${this.botId} does not exist`);
    return state;
  }

  async resetDaily(balanceUsd: number, date: string): Promise<void> {
    const { error } = await this.supabase
      .from("gold_bot_state")
      .update({
        daily_start_balance_usd: balanceUsd,
        daily_date: date,
        paused: false,
        pause_reason: null,
        updated_at: new Date().toISOString(),
      })
      .eq("bot_id", this.botId);
    this.throwIfError(error, "reset gold daily risk state");
  }

  async setPaused(paused: boolean, reason: string | null): Promise<void> {
    const { error } = await this.supabase
      .from("gold_bot_state")
      .update({
        paused,
        pause_reason: reason,
        updated_at: new Date().toISOString(),
      })
      .eq("bot_id", this.botId);
    this.throwIfError(error, "update gold pause state");
  }

  async markCandleProcessed(candleTime: string): Promise<void> {
    const { error } = await this.supabase
      .from("gold_bot_state")
      .update({
        last_processed_candle_time: candleTime,
        updated_at: new Date().toISOString(),
      })
      .eq("bot_id", this.botId);
    this.throwIfError(error, "mark gold candle processed");
  }

  async getOpenPosition(): Promise<GoldPaperPosition | null> {
    const { data, error } = await this.supabase
      .from("gold_paper_positions")
      .select("*")
      .eq("bot_id", this.botId)
      .eq("status", "open")
      .maybeSingle();
    this.throwIfError(error, "read gold open position");
    return (data as GoldPaperPosition | null) ?? null;
  }

  async openPosition(args: {
    instrument: string;
    side: GoldSide;
    units: number;
    entryPrice: number;
    stopLoss: number;
    takeProfit: number;
    entrySpread: number;
    strategyVersion: string;
    signal: GoldSignal;
  }): Promise<GoldPaperPosition> {
    const { data, error } = await this.supabase
      .from("gold_paper_positions")
      .insert({
        bot_id: this.botId,
        instrument: args.instrument,
        side: args.side,
        units: args.units,
        entry_price: args.entryPrice,
        stop_loss: args.stopLoss,
        take_profit: args.takeProfit,
        entry_spread: args.entrySpread,
        status: "open",
        strategy_version: args.strategyVersion,
        signal_json: args.signal,
      })
      .select("*")
      .single();
    this.throwIfError(error, "open gold paper position");

    await this.logEvent("position_opened", {
      positionId: data.id,
      instrument: args.instrument,
      side: args.side,
      units: args.units,
      entryPrice: args.entryPrice,
      stopLoss: args.stopLoss,
      takeProfit: args.takeProfit,
      entrySpread: args.entrySpread,
      strategyVersion: args.strategyVersion,
      signal: args.signal,
    });
    return data as GoldPaperPosition;
  }

  async closePosition(args: {
    positionId: string;
    exitPrice: number;
    realizedPnlUsd: number;
    reason: string;
  }): Promise<boolean> {
    const { data, error } = await this.supabase.rpc("close_gold_paper_position", {
      p_position_id: args.positionId,
      p_exit_price: args.exitPrice,
      p_realized_pnl_usd: args.realizedPnlUsd,
      p_close_reason: args.reason,
      p_closed_at: new Date().toISOString(),
    });
    this.throwIfError(error, "close gold paper position");
    return data === true;
  }

  async logEvent(eventType: string, payload: Record<string, unknown>): Promise<void> {
    const { error } = await this.supabase.from("gold_bot_events").insert({
      bot_id: this.botId,
      event_type: eventType,
      payload,
    });
    this.throwIfError(error, `write gold event ${eventType}`);
  }
}
