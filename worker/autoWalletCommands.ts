import { getSupabaseAdmin } from '../lib/supabase';
import { discoverTrialWallets } from './walletDiscovery';
import { runWalletIntelligence } from './walletIntelligence';

const supabase = getSupabaseAdmin();
let discoveryRunning = false;
let intelligenceRunning = false;

function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function formatAgo(value: string | null | undefined): string {
  if (!value) return 'Never';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'Unknown';
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export async function handleAutoWallets(): Promise<string> {
  const [walletResult, runResult] = await Promise.all([
    supabase
      .from('wallets')
      .select('address, active, management_status')
      .eq('active', true),
    supabase
      .from('wallet_intelligence_runs')
      .select('ran_at, promoted_count, disabled_count, promoted_addresses, disabled_addresses, notes')
      .order('ran_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (walletResult.error) throw new Error(`Failed to load active wallets: ${walletResult.error.message}`);
  if (runResult.error) throw new Error(`Failed to load wallet manager status: ${runResult.error.message}`);

  const wallets = walletResult.data ?? [];
  const proven = wallets.filter((wallet) => wallet.management_status === 'proven');
  const trials = wallets.filter((wallet) => wallet.management_status === 'trial');
  const lastRun = runResult.data as any;
  const replacements = Array.isArray(lastRun?.notes?.immediate_replacement?.added_addresses)
    ? lastRun.notes.immediate_replacement.added_addresses
    : [];
  const promoted = Array.isArray(lastRun?.promoted_addresses) ? lastRun.promoted_addresses : [];
  const disabled = Array.isArray(lastRun?.disabled_addresses) ? lastRun.disabled_addresses : [];

  const lines = [
    '🤖 <b>AUTO WALLET MANAGER</b>',
    '',
    `<b>Active proven wallets:</b> ${proven.length}`,
    `<b>Active trial wallets:</b> ${trials.length}`,
    `<b>Total active:</b> ${wallets.length}`,
    '',
    `<b>Last intelligence run:</b> ${formatAgo(lastRun?.ran_at)}`,
    `<b>Promoted last run:</b> ${Number(lastRun?.promoted_count ?? 0)}`,
    `<b>Disabled last run:</b> ${Number(lastRun?.disabled_count ?? 0)}`,
    `<b>Replacements last run:</b> ${replacements.length}`,
  ];

  if (promoted.length > 0) {
    lines.push('', '<b>Last promoted</b>', ...promoted.slice(0, 3).map((address: string) => `✅ <code>${shortAddress(address)}</code>`));
  }
  if (disabled.length > 0) {
    lines.push('', '<b>Last disabled</b>', ...disabled.slice(0, 3).map((address: string) => `🛑 <code>${shortAddress(address)}</code>`));
  }
  if (replacements.length > 0) {
    lines.push('', '<b>Last replacements</b>', ...replacements.slice(0, 3).map((address: string) => `➕ <code>${shortAddress(address)}</code>`));
  }

  lines.push('', 'Status: 🟢 Automatic evaluation and replacement enabled');
  return lines.join('\n');
}

export async function handleEliteWallets(): Promise<string> {
  const [walletResult, performanceResult] = await Promise.all([
    supabase
      .from('wallets')
      .select('address, management_status')
      .eq('active', true),
    supabase
      .from('wallet_performance')
      .select('wallet_address, completed_trades, win_rate, average_return, profit_factor, trust_score')
      .order('trust_score', { ascending: false }),
  ]);

  if (walletResult.error) throw new Error(`Failed to load active wallets: ${walletResult.error.message}`);
  if (performanceResult.error) throw new Error(`Failed to load elite wallets: ${performanceResult.error.message}`);

  const statusByAddress = new Map(
    (walletResult.data ?? []).map((wallet) => [wallet.address, wallet.management_status])
  );

  const rows = (performanceResult.data ?? [])
    .map((row) => ({ ...row, management_status: statusByAddress.get(row.wallet_address) }))
    .filter((row) => row.management_status === 'proven' || row.management_status === 'trial');

  const proven = rows.filter((row) => row.management_status === 'proven').slice(0, 5);
  const trials = rows.filter((row) => row.management_status === 'trial').slice(0, 5);

  const formatRow = (row: any, icon: string) => {
    const trades = Number(row.completed_trades ?? 0);
    const winRatePct = Number(row.win_rate ?? 0) * 100;
    const avgReturnPct = Number(row.average_return ?? 0) * 100;
    const trust = Number(row.trust_score ?? 0);
    const pf = row.profit_factor == null ? 'n/a' : Number(row.profit_factor).toFixed(2);
    const sign = avgReturnPct > 0 ? '+' : '';
    return `${icon} <code>${shortAddress(row.wallet_address)}</code> — trust ${trust.toFixed(0)}, ${trades} trades, ${winRatePct.toFixed(0)}% win, ${sign}${avgReturnPct.toFixed(1)}% avg, PF ${pf}`;
  };

  const lines = ['🏆 <b>ELITE WALLET RANKINGS</b>'];
  lines.push('', '<b>🥇 Proven leaders</b>');
  lines.push(...(proven.length ? proven.map((row) => formatRow(row, '✅')) : ['No proven wallet performance available yet.']));
  lines.push('', '<b>🧪 Best trials</b>');
  lines.push(...(trials.length ? trials.map((row) => formatRow(row, '🔬')) : ['No trial wallet performance available yet.']));
  lines.push('', 'Ranked by current trust score. Promotion still requires enough trades, positive PnL, and profit factor.');
  return lines.join('\n');
}

export async function handleDiscoverNow(): Promise<string> {
  if (discoveryRunning) return '⏳ <b>DISCOVERY ALREADY RUNNING</b>\n\nWait for the current wallet discovery scan to finish.';
  discoveryRunning = true;
  try {
    const result = await discoverTrialWallets();
    const lines = [
      '🔎 <b>WALLET DISCOVERY COMPLETE</b>',
      '',
      `<b>Qualified candidates found:</b> ${result.eligible}`,
      `<b>New trial wallets added:</b> ${result.added.length}`,
    ];
    if (result.added.length > 0) {
      lines.push('', '<b>Added for trial</b>', ...result.added.map((address) => `➕ <code>${shortAddress(address)}</code>`));
    } else {
      lines.push('', 'No safe unused candidate and trial slot combination was available.');
    }
    return lines.join('\n');
  } finally {
    discoveryRunning = false;
  }
}

export async function handleIntelligenceNow(): Promise<string> {
  if (intelligenceRunning) return '⏳ <b>INTELLIGENCE RUN ALREADY ACTIVE</b>\n\nWait for the current evaluation to finish.';
  intelligenceRunning = true;
  try {
    const result = await runWalletIntelligence();
    const lines = [
      '🧠 <b>WALLET INTELLIGENCE COMPLETE</b>',
      '',
      `<b>Wallets scored:</b> ${result.walletsScored}`,
      `<b>Promoted:</b> ${result.promoted.length}`,
      `<b>Weak trials disabled:</b> ${result.disabled.length}`,
      `<b>Immediate replacements:</b> ${result.replacementsAdded.length}`,
    ];
    if (result.promoted.length > 0) {
      lines.push('', '<b>Promoted</b>', ...result.promoted.map((address) => `✅ <code>${shortAddress(address)}</code>`));
    }
    if (result.disabled.length > 0) {
      lines.push('', '<b>Disabled</b>', ...result.disabled.map((address) => `🛑 <code>${shortAddress(address)}</code>`));
    }
    if (result.replacementsAdded.length > 0) {
      lines.push('', '<b>Replacement trials</b>', ...result.replacementsAdded.map((address) => `➕ <code>${shortAddress(address)}</code>`));
    }
    return lines.join('\n');
  } finally {
    intelligenceRunning = false;
  }
}
