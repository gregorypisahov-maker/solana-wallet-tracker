// paper-trader/storage.ts
// Persists to Supabase instead of local JSON — Railway's filesystem is
// ephemeral and wipes on every redeploy, so local files would silently
// lose all trade history. Run the migrations in sql/ before using this.

import { getSupabaseAdmin } from '../lib/supabase';
import { config } from './config';
import { OpenPosition, PaperState, TradeRecord } from './types';

const supabase = getSupabaseAdmin();
const STATE_ROW_ID = 1;

function assertSuccess(label: string, error: { message: string } | null): void {
  if (error) throw new Error(`${label}: ${error.message}`);
}

function currentUtcDate(): string {
  return new Date().toDateString();
}

async function rolloverDailyStateIfNeeded(state: PaperState): Promise<PaperState> {
  const today = currentUtcDate();
  if (state.dailyResetDate === today) return state;

  const { data: positions, error: positionsError } = await supabase
    .from('paper_positions')
    .select('size_sol,remaining_pct');
  assertSuccess('Failed to load positions for daily rollover', positionsError);

  const committedCapitalSol = (positions ?? []).reduce(
    (sum: number, row: any) =>
      sum + Number(row.size_sol ?? 0) * Number(row.remaining_pct ?? 0),
    0
  );

  const rolled: PaperState = {
    ...state,
    dailyResetDate: today,
    dailyStartBankrollSol: state.bankrollSol + committedCapitalSol,
    consecutiveLosses: 0,
    halted: false,
    haltReason: null,
  };

  await saveState(rolled);
  console.log(`[paper-trader] daily UTC rollover persisted for ${today}`);
  return rolled;
}

export async function loadState(): Promise<PaperState> {
  const { data, error } = await supabase
    .from('paper_state')
    .select('*')
    .eq('id', STATE_ROW_ID)
    .limit(1);
  assertSuccess('Failed to load paper state', error);

  const row = data?.[0];
  if (!row) {
    const fresh: PaperState = {
      bankrollSol: config.position.simulatedBankrollSol,
      dailyStartBankrollSol: config.position.simulatedBankrollSol,
      dailyResetDate: currentUtcDate(),
      consecutiveLosses: 0,
      halted: false,
      haltReason: null,
    };
    const { error: insertError } = await supabase.from('paper_state').insert({
      id: STATE_ROW_ID,
      bankroll_sol: fresh.bankrollSol,
      daily_start_bankroll_sol: fresh.dailyStartBankrollSol,
      daily_reset_date: fresh.dailyResetDate,
      consecutive_losses: fresh.consecutiveLosses,
      halted: fresh.halted,
      halt_reason: fresh.haltReason,
    });
    assertSuccess('Failed to create paper state', insertError);
    return fresh;
  }

  const loaded: PaperState = {
    bankrollSol: Number(row.bankroll_sol),
    dailyStartBankrollSol: Number(row.daily_start_bankroll_sol),
    dailyResetDate: row.daily_reset_date,
    consecutiveLosses: row.consecutive_losses,
    halted: row.halted,
    haltReason: row.halt_reason,
  };

  return rolloverDailyStateIfNeeded(loaded);
}

export async function saveState(state: PaperState): Promise<void> {
  const { error } = await supabase.from('paper_state').upsert(
    {
      id: STATE_ROW_ID,
      bankroll_sol: state.bankrollSol,
      daily_start_bankroll_sol: state.dailyStartBankrollSol,
      daily_reset_date: state.dailyResetDate,
      consecutive_losses: state.consecutiveLosses,
      halted: state.halted,
      halt_reason: state.haltReason,
    },
    { onConflict: 'id' }
  );
  assertSuccess('Failed to save paper state', error);
}

export async function appendTrade(trade: TradeRecord): Promise<void> {
  const { error } = await supabase.from('paper_trades').insert({
    token_symbol: trade.tokenSymbol,
    mint: trade.mint,
    type: trade.type,
    reason: trade.reason,
    entry_price: trade.entryPrice,
    exit_price: trade.exitPrice,
    multiple: trade.multiple,
    sold_pct: trade.soldPct,
    sold_size_sol: trade.soldSizeSol,
    proceeds_sol: trade.proceedsSol,
    gross_pnl_sol: trade.grossPnlSol ?? trade.pnlSol,
    entry_fee_sol: trade.entryFeeSol ?? 0,
    exit_fee_sol: trade.exitFeeSol ?? 0,
    slippage_sol: trade.slippageSol ?? 0,
    pnl_sol: trade.pnlSol,
    cost_model_version: trade.costModelVersion ?? null,
    hold_minutes: trade.holdMinutes,
    happened_at: trade.timestamp,
    entry_alert: trade.entryAlert,
    position_id: trade.positionId,
  });
  assertSuccess('Failed to append paper trade', error);
}

export async function loadTrades(sinceIso?: string): Promise<TradeRecord[]> {
  let query = supabase.from('paper_trades').select('*').order('happened_at', { ascending: true });
  if (sinceIso) query = query.gte('happened_at', sinceIso);
  const { data, error } = await query;
  assertSuccess('Failed to load paper trades', error);
  return (data ?? []).map((r: any) => ({
    tokenSymbol: r.token_symbol,
    mint: r.mint,
    type: r.type,
    reason: r.reason,
    entryPrice: Number(r.entry_price),
    exitPrice: Number(r.exit_price),
    multiple: Number(r.multiple),
    soldPct: Number(r.sold_pct),
    soldSizeSol: Number(r.sold_size_sol),
    proceedsSol: Number(r.proceeds_sol),
    grossPnlSol: Number(r.gross_pnl_sol ?? r.pnl_sol ?? 0),
    entryFeeSol: Number(r.entry_fee_sol ?? 0),
    exitFeeSol: Number(r.exit_fee_sol ?? 0),
    slippageSol: Number(r.slippage_sol ?? 0),
    pnlSol: Number(r.pnl_sol),
    costModelVersion: r.cost_model_version ?? null,
    holdMinutes: Number(r.hold_minutes),
    timestamp: r.happened_at,
    entryAlert: r.entry_alert,
    positionId: r.position_id ?? null,
  }));
}

export async function loadOpenPositions(): Promise<Map<string, OpenPosition>> {
  const { data, error } = await supabase.from('paper_positions').select('*');
  assertSuccess('Failed to load open paper positions', error);
  const map = new Map<string, OpenPosition>();
  for (const r of data ?? []) {
    map.set(r.mint, {
      mint: r.mint,
      tokenSymbol: r.token_symbol,
      entryPrice: Number(r.entry_price),
      entryTime: new Date(r.entry_time).getTime(),
      sizeSol: Number(r.size_sol),
      remainingPct: Number(r.remaining_pct),
      peakMultiple: Number(r.peak_multiple),
      ladderHits: r.ladder_hits ?? [],
      entryAlert: r.entry_alert,
      positionId: r.position_id,
      realizedPnlSol: Number(r.realized_pnl_sol ?? 0),
      entryFeeSol: Number(r.entry_fee_sol ?? 0),
      entrySlippageSol: Number(r.entry_slippage_sol ?? 0),
      entryLiquidityUsd: Number(r.entry_liquidity_usd ?? r.entry_alert?.liquidityUsd ?? 0),
      costModelVersion: r.cost_model_version ?? null,
    });
  }
  return map;
}

export async function saveOpenPosition(pos: OpenPosition): Promise<void> {
  const { error } = await supabase.from('paper_positions').upsert(
    {
      mint: pos.mint,
      token_symbol: pos.tokenSymbol,
      entry_price: pos.entryPrice,
      entry_time: new Date(pos.entryTime).toISOString(),
      size_sol: pos.sizeSol,
      remaining_pct: pos.remainingPct,
      peak_multiple: pos.peakMultiple,
      ladder_hits: pos.ladderHits,
      entry_alert: pos.entryAlert,
      position_id: pos.positionId,
      realized_pnl_sol: pos.realizedPnlSol,
      entry_fee_sol: pos.entryFeeSol ?? 0,
      entry_slippage_sol: pos.entrySlippageSol ?? 0,
      entry_liquidity_usd: pos.entryLiquidityUsd ?? pos.entryAlert.liquidityUsd,
      cost_model_version: pos.costModelVersion ?? null,
    },
    { onConflict: 'mint' }
  );
  assertSuccess('Failed to save open paper position', error);
}

export async function deleteOpenPosition(mint: string): Promise<void> {
  const { error } = await supabase.from('paper_positions').delete().eq('mint', mint);
  assertSuccess('Failed to delete open paper position', error);
}

export async function loadAllTradesRaw(): Promise<any[]> {
  const { data, error } = await supabase
    .from('paper_trades')
    .select('*')
    .order('happened_at', { ascending: true });
  if (error) throw new Error(`Failed to load paper_trades: ${error.message}`);
  return data ?? [];
}
