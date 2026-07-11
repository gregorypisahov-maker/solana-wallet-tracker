// scripts/backfillAlertParticipants.ts
//
// One-time script. Run once after applying sql/002_alert_participants.sql.
//
// alerts_sent has always recorded that an alert fired (token_mint,
// wallets_count, sent_at) but never which wallets. This script
// reconstructs that historically by replaying the exact same windowing
// logic worker/monitor.ts's recomputeConsensus() uses: for each
// historical alert, find every wallet_transactions row that is a
// non-scalp buy of that token in the ALERT_WINDOW_HOURS before the
// alert fired.
//
// This can only be as accurate as your current ALERT_WINDOW_HOURS env
// var — if you've changed that value over the project's history, older
// alerts were computed with a different window than this script uses.
// The script logs the window it used so you can sanity check counts
// against the wallets_count already stored in alerts_sent.
//
// Run with:
//   npx tsx scripts/backfillAlertParticipants.ts
// or:
//   npx ts-node scripts/backfillAlertParticipants.ts

import 'dotenv/config';
import { getSupabaseAdmin } from '../lib/supabase';

const supabase = getSupabaseAdmin();

const ALERT_WINDOW_HOURS = Number(process.env.ALERT_WINDOW_HOURS ?? 24);

interface AlertSentRow {
  id: string;
  token_mint: string;
  wallets_count: number;
  sent_at: string;
}

async function main(): Promise<void> {
  console.log(
    `[backfill] Using ALERT_WINDOW_HOURS=${ALERT_WINDOW_HOURS} — confirm this matches what was live in production at the time of your historical alerts, or counts below may not match alerts_sent.wallets_count exactly.`
  );

  const { data: alerts, error } = await supabase
    .from('alerts_sent')
    .select('id, token_mint, wallets_count, sent_at')
    .order('sent_at', { ascending: true });

  if (error) {
    console.error('[backfill] Failed to load alerts_sent:', error);
    process.exit(1);
  }

  const alertRows = (alerts ?? []) as AlertSentRow[];

  if (alertRows.length === 0) {
    console.log('[backfill] No alerts_sent rows found. Nothing to do.');
    return;
  }

  console.log(`[backfill] Found ${alertRows.length} historical alerts to reconstruct.`);

  let inserted = 0;
  let mismatchWarnings = 0;

  for (const alert of alertRows) {
    const windowStart = new Date(
      new Date(alert.sent_at).getTime() - ALERT_WINDOW_HOURS * 60 * 60 * 1000
    ).toISOString();

    const { data: buys, error: buysError } = await supabase
      .from('wallet_transactions')
      .select('wallet_address, sol_amount, tx_time')
      .eq('token_mint', alert.token_mint)
      .eq('side', 'buy')
      .eq('is_scalp', false)
      .gte('tx_time', windowStart)
      .lte('tx_time', alert.sent_at);

    if (buysError) {
      console.error(`[backfill] Failed to load buys for alert ${alert.id}:`, buysError);
      continue;
    }

    const byWallet = new Map<string, number>();
    for (const buy of buys ?? []) {
      byWallet.set(
        buy.wallet_address,
        (byWallet.get(buy.wallet_address) ?? 0) + Number(buy.sol_amount)
      );
    }

    if (byWallet.size !== alert.wallets_count) {
      mismatchWarnings += 1;
      console.warn(
        `[backfill] WARNING: alert ${alert.id} (${alert.token_mint}) originally recorded ` +
          `${alert.wallets_count} wallets but reconstruction found ${byWallet.size}. ` +
          `This can happen if ALERT_WINDOW_HOURS changed over time, or if wallets were ` +
          `added/removed from monitoring since. Proceeding with the reconstructed set.`
      );
    }

    const rows = Array.from(byWallet.entries()).map(([wallet_address, sol_amount]) => ({
      token_mint: alert.token_mint,
      wallet_address,
      alert_sent_at: alert.sent_at,
      sol_amount,
    }));

    if (rows.length === 0) continue;

    const { error: insertError } = await supabase
      .from('alert_participants')
      .upsert(rows, { onConflict: 'token_mint,wallet_address,alert_sent_at' });

    if (insertError) {
      console.error(`[backfill] Failed to insert participants for alert ${alert.id}:`, insertError);
      continue;
    }

    inserted += rows.length;
  }

  console.log(
    `[backfill] Done. Inserted/updated ${inserted} alert_participants rows across ${alertRows.length} alerts. ${mismatchWarnings} alerts had a wallet-count mismatch (see warnings above).`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[backfill] Fatal error:', err);
    process.exit(1);
  });
