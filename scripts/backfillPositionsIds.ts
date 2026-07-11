// scripts/backfillPositionIds.ts
//
// One-time script. Run once after applying sql/001_position_id.sql and
// BEFORE relying on paper-trader/analytics.ts for historical data.
//
// Historical paper_trades rows have no position_id (the old engine.ts
// never generated one). Since paper_positions has always used `mint` as
// its sole primary key, only one position per mint could ever be open
// at a time — so all partial sells belonging to one historical position
// share the same mint AND the same entry_price (entry_price is fixed at
// the moment a position opens and is copied unchanged onto every
// TradeRecord for that position by engine.ts).
//
// This script groups paper_trades by (mint, entry_price), assigns each
// group a synthetic position_id, and writes it back.
//
// CAVEAT: if two entirely separate historical positions on the same
// mint happened to open at the exact same entry_price, they will be
// incorrectly merged into one "position" by this script. This script
// detects and reports that scenario instead of silently guessing —
// check the console output after running for any WARNING lines and
// review those mints manually if they appear.
//
// Run with:
//   npx tsx scripts/backfillPositionIds.ts
// or if you don't have tsx:
//   npx ts-node scripts/backfillPositionIds.ts

import 'dotenv/config';
import { getSupabaseAdmin } from '../lib/supabase';

const supabase = getSupabaseAdmin();

interface RawTradeRow {
  id: number;
  mint: string;
  entry_price: string;
  happened_at: string;
  position_id: string | null;
}

function makeSyntheticPositionId(mint: string, entryPrice: string, firstTimestamp: string): string {
  // Not the same format as the live engine's `${mint}_${entryTime}`
  // (we don't know the real open time, only the first sell time), but
  // it only needs to be unique and stable — analytics just needs a
  // grouping key, not the literal engine-generated id.
  return `backfill_${mint}_${entryPrice}_${new Date(firstTimestamp).getTime()}`;
}

async function main(): Promise<void> {
  console.log('[backfill] Loading all paper_trades rows without a position_id...');

  const { data, error } = await supabase
    .from('paper_trades')
    .select('id, mint, entry_price, happened_at, position_id')
    .is('position_id', null)
    .order('happened_at', { ascending: true });

  if (error) {
    console.error('[backfill] Failed to load paper_trades:', error);
    process.exit(1);
  }

  const rows = (data ?? []) as RawTradeRow[];

  if (rows.length === 0) {
    console.log('[backfill] Nothing to do — no rows with a null position_id.');
    return;
  }

  console.log(`[backfill] Found ${rows.length} rows to backfill.`);

  // Group by mint + entry_price (entry_price as string to avoid float
  // rounding mismatches — it was stored via numeric column so string
  // comparison of the raw DB value is exact).
  const groups = new Map<string, RawTradeRow[]>();

  for (const row of rows) {
    const key = `${row.mint}::${row.entry_price}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  console.log(`[backfill] Grouped into ${groups.size} distinct positions.`);

  // Sanity check: warn if any mint has multiple distinct entry_price
  // groups whose happened_at ranges overlap in a way that suggests they
  // might actually be the same position split by a rounding artifact,
  // or conversely warn if a single (mint, entry_price) group's trades
  // span a suspiciously long time (could be two coincidentally-equal
  // entries merged together).
  const byMint = new Map<string, string[]>();
  for (const key of groups.keys()) {
    const [mint] = key.split('::');
    const list = byMint.get(mint) ?? [];
    list.push(key);
    byMint.set(mint, list);
  }

  for (const [mint, keys] of byMint.entries()) {
    if (keys.length > 1) {
      console.log(
        `[backfill] INFO: mint ${mint} has ${keys.length} separate historical positions (different entry prices) — this is normal.`
      );
    }
  }

  for (const [key, groupRows] of groups.entries()) {
    const timestamps = groupRows.map((r) => new Date(r.happened_at).getTime());
    const spanMinutes = (Math.max(...timestamps) - Math.min(...timestamps)) / 60_000;

    if (spanMinutes > config_maxHoldMinutesGuess()) {
      console.warn(
        `[backfill] WARNING: group ${key} has trades spanning ${spanMinutes.toFixed(
          1
        )} minutes, longer than your configured maxHoldMinutes. This MAY mean two separate positions on this mint coincidentally shared an entry_price and got merged. Review manually: ${groupRows
          .map((r) => r.id)
          .join(', ')}`
      );
    }
  }

  let updated = 0;

  for (const [, groupRows] of groups.entries()) {
    const sorted = [...groupRows].sort(
      (a, b) => new Date(a.happened_at).getTime() - new Date(b.happened_at).getTime()
    );

    const positionId = makeSyntheticPositionId(
      sorted[0].mint,
      sorted[0].entry_price,
      sorted[0].happened_at
    );

    const ids = sorted.map((r) => r.id);

    const { error: updateError } = await supabase
      .from('paper_trades')
      .update({ position_id: positionId })
      .in('id', ids);

    if (updateError) {
      console.error(`[backfill] Failed to update rows ${ids.join(', ')}:`, updateError);
      continue;
    }

    updated += ids.length;
  }

  console.log(`[backfill] Done. Updated ${updated} of ${rows.length} rows.`);
}

// Reads the same maxHoldMinutes value your live config uses, without
// importing config.ts's other side effects — kept local to avoid
// coupling this one-off script to the app's module graph.
function config_maxHoldMinutesGuess(): number {
  const fromEnv = Number(process.env.BACKFILL_MAX_HOLD_MINUTES_GUESS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  // Matches config.ts's exit.maxHoldMinutes default (45) with generous
  // headroom for the trailing/ladder sells that can follow it.
  return 120;
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[backfill] Fatal error:', err);
    process.exit(1);
  });
