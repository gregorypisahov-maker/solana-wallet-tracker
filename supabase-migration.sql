// paper-trader/storage.ts
// Persists to Supabase instead of local JSON — Railway's filesystem is
// ephemeral and wipes on every redeploy, so local files would silently
// lose all trade history. Run the migration in
// supabase/migrations/xxxx_paper_trader.sql before using this.

import { getSupabaseAdmin } from '../lib/supabase';
import { config } from './config';
import { OpenPosition, PaperState, TradeRecord } from './types';

const supabase = getSupabaseAdmin();

const STATE_ROW_ID = 1; // single-row table, always id=1

export async function loadState(): Promise<PaperState> {
  const { data } = await supabase
    .from('paper_state')
    .select('*')
    .eq('id', STATE_ROW_ID)
    .limit(1);

  const row = data?.[0];
  if (!row) {
    const fresh: PaperState = {
      bankrollSol: config.position.simulatedBankrollSol,
      dailyStartBankrollSol: config.position.simulatedBankrollSol,
      dailyResetDate: new Date().toDateString(),
      consecutiveLosses: 0,
      halted: false,
      haltReason: null,
    };
    await supabase.from('paper_state').insert({
      id: STATE_ROW_ID,
      bankroll_sol: fresh.bankrollSol,
      daily_start_bankroll_sol: fresh.dailyStartBankrollSol,
      daily_reset_date: fresh.dailyResetDate,
      consecutive_losses: fresh.consecutiveLosses,
      halted: fresh.halted,
      halt_reason: fresh.haltReason,
    });
    return fresh;
  }

  return {
    bankrollSol: Number(row.bankroll_sol),
    dailyStartBankrollSol: Number(row.daily_start_bankroll_sol),
    dailyResetDate: row.daily_reset_date,
    consecutiveLosses: row.consecutive_losses,
    halted: row.halted,
    haltReason: row.halt_reason,
  };
}

export async function saveState(state: PaperState): Promise<void> {
  await supabase.from('paper_state').upsert(
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
}

export async function appendTrade(trade: TradeRecord): Promise<void> {
  await supabase.from('paper_trades').insert({
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
    pnl_sol: trade.pnlSol,
    hold_minutes: trade.holdMinutes,
    happened_at: trade.timestamp,
    entry_alert: trade.entryAlert,
  });
}

export async function loadTrades(sinceIso?: string): Promise<TradeRecord[]> {
  let query = supabase.from('paper_trades').select('*').order('happened_at', { ascending: true });
  if (sinceIso) {
    query = query.gte('happened_at', sinceIso);
  }
  const { data } = await query;
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
    pnlSol: Number(r.pnl_sol),
    holdMinutes: Number(r.hold_minutes),
    timestamp: r.happened_at,
    entryAlert: r.entry_alert,
  }));
}

export async function loadOpenPositions(): Promise<Map<string, OpenPosition>> {
  const { data } = await supabase.from('paper_positions').select('*');
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
    });
  }
  return map;
}

export async function saveOpenPosition(pos: OpenPosition): Promise<void> {
  await supabase.from('paper_positions').upsert(
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
    },
    { onConflict: 'mint' }
  );
}

export async function deleteOpenPosition(mint: string): Promise<void> {
  await supabase.from('paper_positions').delete().eq('mint', mint);
}
