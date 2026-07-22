import { getSupabaseAdmin } from "../lib/supabase";

const supabase = getSupabaseAdmin();
const OVERLAP_MS = 5_000;
const PAGE_SIZE = 500;

type TieredBuyRow = {
  id: string;
  wallet_address: string;
  token_mint: string;
  sol_amount: number | string;
  tx_time: string;
  created_at: string;
};

const processedKeys = new Set<string>();
let processedLoaded: Promise<void> | null = null;
let cursorCreatedAtMs = 0;
let initialTransactionsLoaded = false;
const emittedIds = new Map<string, number>();

export const tieredSignalKey = (wallet: string, mint: string) => `${wallet}:${mint}`;

async function loadProcessedKeys(): Promise<void> {
  if (processedLoaded) return processedLoaded;
  processedLoaded = (async () => {
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data, error } = await supabase
        .from("tiered_processed_signals")
        .select("wallet_address,token_mint")
        .range(offset, offset + PAGE_SIZE - 1);
      if (error) throw new Error(`tiered processed-signal cache load failed: ${error.message}`);
      for (const row of data ?? []) {
        processedKeys.add(tieredSignalKey(String(row.wallet_address), String(row.token_mint)));
      }
      if ((data?.length ?? 0) < PAGE_SIZE) break;
    }
    console.log(`[tiered-entry] processed-signal cache loaded: ${processedKeys.size} keys`);
  })().catch((error) => {
    processedLoaded = null;
    throw error;
  });
  return processedLoaded;
}

export async function isTieredSignalProcessed(wallet: string, mint: string): Promise<boolean> {
  await loadProcessedKeys();
  return processedKeys.has(tieredSignalKey(wallet, mint));
}

export function markTieredSignalProcessed(wallet: string, mint: string): void {
  processedKeys.add(tieredSignalKey(wallet, mint));
}

export async function loadIncrementalTieredBuys(windowMs: number): Promise<TieredBuyRow[]> {
  const now = Date.now();
  const cutoffMs = now - windowMs;
  let query = supabase
    .from("wallet_transactions")
    .select("id,wallet_address,token_mint,sol_amount,tx_time,created_at")
    .eq("side", "buy")
    .order("created_at", { ascending: true })
    .order("tx_time", { ascending: true })
    .limit(200);

  if (!initialTransactionsLoaded) {
    query = query.gte("tx_time", new Date(cutoffMs).toISOString());
  } else {
    query = query.gte(
      "created_at",
      new Date(Math.max(0, cursorCreatedAtMs - OVERLAP_MS)).toISOString()
    );
  }

  const { data, error } = await query;
  if (error) throw new Error(`tiered incremental buy load failed: ${error.message}`);
  initialTransactionsLoaded = true;

  const fresh: TieredBuyRow[] = [];
  for (const row of (data ?? []) as TieredBuyRow[]) {
    const createdMs = Date.parse(row.created_at);
    const txMs = Date.parse(row.tx_time);
    if (Number.isFinite(createdMs)) cursorCreatedAtMs = Math.max(cursorCreatedAtMs, createdMs);
    if (!Number.isFinite(txMs) || txMs < cutoffMs) continue;
    if (emittedIds.has(row.id)) continue;
    emittedIds.set(row.id, now);
    fresh.push(row);
  }

  for (const [id, seenAt] of emittedIds) {
    if (seenAt < cutoffMs) emittedIds.delete(id);
  }
  return fresh;
}
