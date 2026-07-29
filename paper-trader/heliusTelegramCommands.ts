import { getSupabaseAdmin } from '../lib/supabase';

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function signedSol(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(4)} SOL`;
}

function signedPct(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function startOfHour(): string {
  const date = new Date();
  date.setMinutes(0, 0, 0);
  return date.toISOString();
}

function startOfDay(): string {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

function startOfMonth(): string {
  const date = new Date();
  date.setUTCDate(1);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

async function creditUsageSince(since: string): Promise<number> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('helius_credit_usage')
    .select('estimated_credits')
    .gte('created_at', since);
  if (error) throw new Error(`Helius credit lookup failed: ${error.message}`);
  return (data ?? []).reduce((sum, row) => sum + Number(row.estimated_credits ?? 0), 0);
}

export async function handleHeliusFlowStats(): Promise<string> {
  const supabase = getSupabaseAdmin();
  const [workerResult, stateResult, positionsResult, tradesResult, snapshotsResult] = await Promise.all([
    supabase.from('intelligence_worker_state').select('*').order('updated_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('helius_flow_paper_state').select('*').eq('service', 'helius_flow_paper_v1').maybeSingle(),
    supabase.from('helius_flow_paper_positions').select('position_id', { count: 'exact', head: true }),
    supabase.from('helius_flow_paper_trades').select('id', { count: 'exact', head: true }),
    supabase.from('token_intelligence_snapshots').select('id', { count: 'exact', head: true }),
  ]);
  const error = workerResult.error ?? stateResult.error ?? positionsResult.error ?? tradesResult.error ?? snapshotsResult.error;
  if (error) throw new Error(`Helius status lookup failed: ${error.message}`);

  const worker = workerResult.data;
  const state = stateResult.data;
  const heartbeat = worker?.last_heartbeat_at
    ? new Date(worker.last_heartbeat_at).toLocaleString('en-IL', { timeZone: 'Asia/Jerusalem' })
    : 'not received';

  return [
    '🧠 <b>HELIUS FLOW SYSTEM</b>',
    '',
    `Intelligence mode: <b>${escapeHtml(worker?.mode ?? 'off')}</b>`,
    `Worker status: <b>${escapeHtml(worker?.status ?? 'not started')}</b>`,
    `Last heartbeat: ${heartbeat}`,
    `Paper entries: ${state?.enabled ? '🟢 ENABLED' : '🔴 PAUSED'}`,
    `Open positions: ${positionsResult.count ?? 0}`,
    `Closed trades: ${tradesResult.count ?? 0}`,
    `Intelligence snapshots: ${snapshotsResult.count ?? 0}`,
    '',
    `Cash: ${Number(state?.cash_sol ?? 0).toFixed(4)} SOL`,
    `Realized PnL: <b>${signedSol(Number(state?.realized_pnl_sol ?? 0))}</b>`,
    '',
    '🧪 Paper only — no real SOL is used.',
  ].join('\n');
}

export async function handleHeliusPositions(): Promise<string> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('helius_flow_paper_positions')
    .select('*')
    .order('opened_at', { ascending: false })
    .limit(10);
  if (error) throw new Error(`Helius positions lookup failed: ${error.message}`);
  if (!data?.length) return '📭 <b>HELIUS FLOW POSITIONS</b>\n\nNo open paper positions.';

  const lines = ['📂 <b>HELIUS FLOW OPEN POSITIONS</b>', ''];
  for (const position of data) {
    const opened = new Date(position.opened_at).toLocaleString('en-IL', { timeZone: 'Asia/Jerusalem' });
    lines.push(
      `<b>${escapeHtml(position.symbol || 'UNKNOWN')}</b>`,
      `Size: ${Number(position.size_sol).toFixed(4)} SOL`,
      `Last executable: ${Number(position.last_executable_sol).toFixed(4)} SOL`,
      `Quote failures: ${Number(position.quote_fail_streak ?? 0)}`,
      `Opened: ${opened}`,
      `<code>${escapeHtml(position.mint)}</code>`,
      ''
    );
  }
  return lines.join('\n');
}

export async function handleHeliusTrades(): Promise<string> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('helius_flow_paper_trades')
    .select('*')
    .order('closed_at', { ascending: false })
    .limit(10);
  if (error) throw new Error(`Helius trades lookup failed: ${error.message}`);
  if (!data?.length) return '📭 <b>HELIUS FLOW TRADES</b>\n\nNo closed paper trades yet.';

  const lines = ['📜 <b>LAST 10 HELIUS FLOW TRADES</b>', ''];
  for (const trade of data) {
    lines.push(
      `<b>${escapeHtml(trade.symbol || 'UNKNOWN')}</b> • ${escapeHtml(String(trade.exit_reason).replaceAll('_', ' '))}`,
      `${signedSol(Number(trade.pnl_sol))} • ${signedPct(Number(trade.net_return_pct))}`,
      ''
    );
  }
  return lines.join('\n');
}

export async function handleHeliusPnl(): Promise<string> {
  const supabase = getSupabaseAdmin();
  const [stateResult, positionsResult, tradesResult] = await Promise.all([
    supabase.from('helius_flow_paper_state').select('*').eq('service', 'helius_flow_paper_v1').maybeSingle(),
    supabase.from('helius_flow_paper_positions').select('last_executable_sol'),
    supabase.from('helius_flow_paper_trades').select('pnl_sol'),
  ]);
  const error = stateResult.error ?? positionsResult.error ?? tradesResult.error;
  if (error) throw new Error(`Helius PnL lookup failed: ${error.message}`);

  const state = stateResult.data;
  const positions = positionsResult.data ?? [];
  const trades = tradesResult.data ?? [];
  const starting = Number(state?.starting_bankroll_sol ?? 0);
  const cash = Number(state?.cash_sol ?? 0);
  const openValue = positions.reduce((sum, row) => sum + Number(row.last_executable_sol ?? 0), 0);
  const equity = cash + openValue;
  const wins = trades.filter((row) => Number(row.pnl_sol) > 0).length;
  const grossProfit = trades.filter((row) => Number(row.pnl_sol) > 0).reduce((sum, row) => sum + Number(row.pnl_sol), 0);
  const grossLoss = Math.abs(trades.filter((row) => Number(row.pnl_sol) < 0).reduce((sum, row) => sum + Number(row.pnl_sol), 0));

  return [
    '💰 <b>HELIUS FLOW PAPER PNL</b>',
    '',
    `Status: ${state?.enabled ? '🟢 ACTIVE' : '🔴 PAUSED'}`,
    `Starting bankroll: ${starting.toFixed(4)} SOL`,
    `Equity: <b>${equity.toFixed(4)} SOL</b>`,
    `Cash: ${cash.toFixed(4)} SOL`,
    `Open value: ${openValue.toFixed(4)} SOL`,
    `Realized PnL: <b>${signedSol(Number(state?.realized_pnl_sol ?? 0))}</b>`,
    '',
    `Completed trades: ${trades.length}`,
    `Wins / losses: ${wins}W / ${trades.length - wins}L`,
    `Win rate: ${trades.length ? ((wins / trades.length) * 100).toFixed(1) : '0.0'}%`,
    `Profit factor: ${grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : grossProfit > 0 ? '∞' : 'N/A'}`,
    `Open positions: ${positions.length}`,
    '',
    '🧪 Paper only — no real SOL is used.',
  ].join('\n');
}

export async function handleHeliusCredit(): Promise<string> {
  const supabase = getSupabaseAdmin();
  const [hour, day, month, workerResult] = await Promise.all([
    creditUsageSince(startOfHour()),
    creditUsageSince(startOfDay()),
    creditUsageSince(startOfMonth()),
    supabase.from('intelligence_worker_state').select('*').order('updated_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (workerResult.error) throw new Error(`Helius worker lookup failed: ${workerResult.error.message}`);
  const worker = workerResult.data;

  return [
    '⚡ <b>HELIUS INTELLIGENCE CREDITS</b>',
    '',
    `Mode: <b>${escapeHtml(worker?.mode ?? 'off')}</b>`,
    `Worker status: <b>${escapeHtml(worker?.status ?? 'not started')}</b>`,
    `Used this hour: <b>${hour.toLocaleString()}</b>`,
    `Used today: <b>${day.toLocaleString()}</b>`,
    `Used this month: <b>${month.toLocaleString()}</b>`,
    '',
    'Credit limits are enforced by the intelligence worker environment variables.',
  ].join('\n');
}

export async function handleHeliusPause(): Promise<string> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from('helius_flow_paper_state')
    .update({ enabled: false, updated_at: new Date().toISOString() })
    .eq('service', 'helius_flow_paper_v1');
  if (error) throw new Error(`Could not pause Helius paper entries: ${error.message}`);
  return '⏸ <b>HELIUS FLOW PAPER PAUSED</b>\n\nNew entries are disabled. Existing paper positions remain managed.';
}

export async function handleHeliusResume(): Promise<string> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from('helius_flow_paper_state')
    .update({ enabled: true, updated_at: new Date().toISOString() })
    .eq('service', 'helius_flow_paper_v1');
  if (error) throw new Error(`Could not resume Helius paper entries: ${error.message}`);
  return '▶️ <b>HELIUS FLOW PAPER RESUMED</b>\n\nNew paper entries are enabled.';
}
