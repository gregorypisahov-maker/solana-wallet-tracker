import { getSupabaseAdmin } from "../lib/supabase";

const supabase = getSupabaseAdmin();
const INCREMENTAL_OVERLAP_MS = 5_000;
const PAGE_SIZE = 1_000;

type WalletTransactionRow = {
  id: string;
  wallet_address: string;
  token_mint: string;
  side: "buy" | "sell";
  sol_amount: number | string;
  tx_time: string;
  is_scalp: boolean;
  created_at: string;
};

export type ConsensusBuy = {
  wallet_address: string;
  token_mint: string;
  sol_amount: number | string;
  tx_time: string;
};

export type ConsensusTransactionSnapshot = {
  buys: ConsensusBuy[];
  sellingWalletsByToken: Map<string, Set<string>>;
  totalRows: number;
  newestCreatedAt: string | null;
};

const rowsById = new Map<string, WalletTransactionRow>();
let initialized = false;
let newestCreatedAtMs = 0;
let refreshTail: Promise<ConsensusTransactionSnapshot> = Promise.resolve({
  buys: [],
  sellingWalletsByToken: new Map(),
  totalRows: 0,
  newestCreatedAt: null,
});

function rowTimeMs(row: WalletTransactionRow): number {
  const parsed = Date.parse(row.tx_time);
  return Number.isFinite(parsed) ? parsed : 0;
}

function createdTimeMs(row: WalletTransactionRow): number {
  const parsed = Date.parse(row.created_at);
  return Number.isFinite(parsed) ? parsed : 0;
}

function reconcileScalpLinks(newRows: WalletTransactionRow[], scalpWindowMinutes: number): void {
  const scalpWindowMs = scalpWindowMinutes * 60_000;
  for (const row of newRows) {
    if (!row.is_scalp) continue;
    const time = rowTimeMs(row);
    for (const cached of rowsById.values()) {
      if (cached.id === row.id || cached.is_scalp) continue;
      if (cached.wallet_address !== row.wallet_address || cached.token_mint !== row.token_mint) continue;
      if (cached.side === row.side) continue;
      if (Math.abs(rowTimeMs(cached) - time) <= scalpWindowMs) cached.is_scalp = true;
    }
  }
}

async function fetchPage(input: {
  initial: boolean;
  windowStartIso: string;
  createdAfterIso?: string;
  from: number;
  to: number;
}): Promise<WalletTransactionRow[]> {
  let query = supabase
    .from("wallet_transactions")
    .select("id,wallet_address,token_mint,side,sol_amount,tx_time,is_scalp,created_at")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .range(input.from, input.to);

  query = input.initial
    ? query.gte("tx_time", input.windowStartIso)
    : query.gte("created_at", input.createdAfterIso as string);

  const { data, error } = await query;
  if (error) throw new Error(`consensus transaction window refresh failed: ${error.message}`);
  return (data ?? []) as WalletTransactionRow[];
}

async function refreshRows(windowHours: number, scalpWindowMinutes: number): Promise<void> {
  const windowStartMs = Date.now() - windowHours * 3_600_000;
  const windowStartIso = new Date(windowStartMs).toISOString();
  const initial = !initialized;
  const createdAfterIso = new Date(
    Math.max(0, newestCreatedAtMs - INCREMENTAL_OVERLAP_MS)
  ).toISOString();

  const received: WalletTransactionRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await fetchPage({
      initial,
      windowStartIso,
      createdAfterIso,
      from: offset,
      to: offset + PAGE_SIZE - 1,
    });
    received.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  for (const row of received) {
    rowsById.set(row.id, row);
    newestCreatedAtMs = Math.max(newestCreatedAtMs, createdTimeMs(row));
  }
  reconcileScalpLinks(received, scalpWindowMinutes);

  for (const [id, row] of rowsById) {
    if (rowTimeMs(row) < windowStartMs) rowsById.delete(id);
  }
  initialized = true;
}

function buildSnapshot(): ConsensusTransactionSnapshot {
  const buys: ConsensusBuy[] = [];
  const sellingWalletsByToken = new Map<string, Set<string>>();

  for (const row of rowsById.values()) {
    if (row.is_scalp) continue;
    if (row.side === "buy") {
      buys.push({
        wallet_address: row.wallet_address,
        token_mint: row.token_mint,
        sol_amount: row.sol_amount,
        tx_time: row.tx_time,
      });
      continue;
    }
    const wallets = sellingWalletsByToken.get(row.token_mint) ?? new Set<string>();
    wallets.add(row.wallet_address);
    sellingWalletsByToken.set(row.token_mint, wallets);
  }

  return {
    buys,
    sellingWalletsByToken,
    totalRows: rowsById.size,
    newestCreatedAt: newestCreatedAtMs > 0 ? new Date(newestCreatedAtMs).toISOString() : null,
  };
}

export function loadConsensusTransactionSnapshot(
  windowHours: number,
  scalpWindowMinutes: number
): Promise<ConsensusTransactionSnapshot> {
  refreshTail = refreshTail
    .catch(() => buildSnapshot())
    .then(async () => {
      await refreshRows(windowHours, scalpWindowMinutes);
      return buildSnapshot();
    });
  return refreshTail;
}
