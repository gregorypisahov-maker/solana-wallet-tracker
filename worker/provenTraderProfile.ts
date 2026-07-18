import {
  PROVEN_TRADER_RULES,
  ProvenTraderSignalProfile,
  provenTraderProfileReasons,
} from "../paper-trader/provenTraderRules";

const LAMPORTS_PER_SOL = 1_000_000_000;
const PROFILE_VERSION = 1;
const LOOKBACK_DAYS = 14;
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
const EXCLUDED_MINTS = new Set([
  WRAPPED_SOL_MINT,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

export interface ProvenTraderProfile extends ProvenTraderSignalProfile {
  observedSwaps: number;
  matchedBuys: number;
  matchedSells: number;
  lookbackDays: number;
  rejectionReasons: string[];
  profiledAt: string;
}

export interface HeliusProfileTransaction {
  feePayer?: string;
  fee?: number;
  timestamp?: number;
  nativeTransfers?: Array<{
    fromUserAccount?: string;
    toUserAccount?: string;
    amount?: number;
  }>;
  tokenTransfers?: Array<{
    mint?: string;
    fromUserAccount?: string;
    toUserAccount?: string;
    tokenAmount?: number;
  }>;
  accountData?: Array<{
    account?: string;
    nativeBalanceChange?: number;
  }>;
}

type ParsedSwap = {
  mint: string;
  timestamp: number;
  tokenDelta: number;
  solDelta: number;
};

type Holding = {
  quantity: number;
  costSol: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function walletNativeDelta(
  transaction: HeliusProfileTransaction,
  wallet: string
): number {
  const accountEntry = transaction.accountData?.find(
    (row) => row.account === wallet
  );
  if (accountEntry && Number.isFinite(Number(accountEntry.nativeBalanceChange))) {
    return finite(accountEntry.nativeBalanceChange) / LAMPORTS_PER_SOL;
  }

  let lamports = 0;
  for (const transfer of transaction.nativeTransfers ?? []) {
    const amount = finite(transfer.amount);
    if (transfer.toUserAccount === wallet) lamports += amount;
    if (transfer.fromUserAccount === wallet) lamports -= amount;
  }
  if (transaction.feePayer === wallet) {
    lamports -= finite(transaction.fee);
  }
  return lamports / LAMPORTS_PER_SOL;
}

function tokenDeltas(
  transaction: HeliusProfileTransaction,
  wallet: string
): Map<string, number> {
  const deltas = new Map<string, number>();
  for (const transfer of transaction.tokenTransfers ?? []) {
    const mint = transfer.mint?.trim();
    const amount = finite(transfer.tokenAmount);
    if (!mint || amount <= 0) continue;
    if (transfer.toUserAccount === wallet) {
      deltas.set(mint, (deltas.get(mint) ?? 0) + amount);
    }
    if (transfer.fromUserAccount === wallet) {
      deltas.set(mint, (deltas.get(mint) ?? 0) - amount);
    }
  }
  return deltas;
}

function parseSwap(
  transaction: HeliusProfileTransaction,
  wallet: string
): ParsedSwap | null {
  const timestamp = finite(transaction.timestamp);
  if (timestamp <= 0) return null;

  const deltas = tokenDeltas(transaction, wallet);
  let solDelta = walletNativeDelta(transaction, wallet);
  if (Math.abs(solDelta) < 0.000001) {
    solDelta = deltas.get(WRAPPED_SOL_MINT) ?? 0;
  }

  const tradedTokens = [...deltas.entries()].filter(
    ([mint, delta]) => !EXCLUDED_MINTS.has(mint) && Math.abs(delta) > 1e-12
  );
  if (tradedTokens.length !== 1 || Math.abs(solDelta) < 0.000001) {
    return null;
  }

  const [mint, tokenDelta] = tradedTokens[0];
  const isBuy = tokenDelta > 0 && solDelta < 0;
  const isSell = tokenDelta < 0 && solDelta > 0;
  if (!isBuy && !isSell) return null;

  return { mint, timestamp, tokenDelta, solDelta };
}

export function profileProvenTraderTransactions(
  transactions: HeliusProfileTransaction[],
  wallet: string,
  nowMs = Date.now()
): ProvenTraderProfile {
  const cutoffSec = Math.floor(nowMs / 1000) - LOOKBACK_DAYS * 86_400;
  const swaps = transactions
    .map((transaction) => parseSwap(transaction, wallet))
    .filter((swap): swap is ParsedSwap => Boolean(swap))
    .filter((swap) => swap.timestamp >= cutoffSec)
    .sort((left, right) => left.timestamp - right.timestamp);

  const holdings = new Map<string, Holding>();
  const realized: Array<{ mint: string; timestamp: number; pnlSol: number }> = [];
  let matchedBuys = 0;
  let matchedSells = 0;

  for (const swap of swaps) {
    if (swap.tokenDelta > 0) {
      const holding = holdings.get(swap.mint) ?? { quantity: 0, costSol: 0 };
      holding.quantity += swap.tokenDelta;
      holding.costSol += Math.abs(swap.solDelta);
      holdings.set(swap.mint, holding);
      matchedBuys += 1;
      continue;
    }

    const holding = holdings.get(swap.mint);
    const soldQuantity = Math.abs(swap.tokenDelta);
    if (!holding || holding.quantity <= 0 || holding.costSol <= 0) continue;

    const matchedQuantity = Math.min(soldQuantity, holding.quantity);
    const holdingFraction = matchedQuantity / holding.quantity;
    const saleFraction = matchedQuantity / soldQuantity;
    const costSol = holding.costSol * holdingFraction;
    const proceedsSol = swap.solDelta * saleFraction;
    realized.push({
      mint: swap.mint,
      timestamp: swap.timestamp,
      pnlSol: proceedsSol - costSol,
    });
    matchedSells += 1;

    holding.quantity -= matchedQuantity;
    holding.costSol -= costSol;
    if (holding.quantity <= 1e-12 || holding.costSol <= 1e-12) {
      holdings.delete(swap.mint);
    } else {
      holdings.set(swap.mint, holding);
    }
  }

  const wins = realized.filter((trade) => trade.pnlSol > 0).length;
  const losses = realized.filter((trade) => trade.pnlSol < 0).length;
  const grossProfitSol = realized
    .filter((trade) => trade.pnlSol > 0)
    .reduce((sum, trade) => sum + trade.pnlSol, 0);
  const grossLossSol = Math.abs(
    realized
      .filter((trade) => trade.pnlSol < 0)
      .reduce((sum, trade) => sum + trade.pnlSol, 0)
  );
  const realizedPnlSol = grossProfitSol - grossLossSol;
  const profitFactor =
    grossLossSol > 0
      ? grossProfitSol / grossLossSol
      : grossProfitSol > 0
        ? 999
        : null;

  let cumulative = 0;
  let peak = 0;
  let maxDrawdownSol = 0;
  for (const trade of realized) {
    cumulative += trade.pnlSol;
    peak = Math.max(peak, cumulative);
    maxDrawdownSol = Math.max(maxDrawdownSol, peak - cumulative);
  }
  const maxDrawdownToGrossProfit =
    grossProfitSol > 0 ? maxDrawdownSol / grossProfitSol : Number.MAX_SAFE_INTEGER;

  const base: ProvenTraderSignalProfile = {
    profileVersion: PROFILE_VERSION,
    closedTrades: realized.length,
    distinctClosedTokens: new Set(realized.map((trade) => trade.mint)).size,
    wins,
    losses,
    winRate: realized.length > 0 ? wins / realized.length : 0,
    realizedPnlSol,
    grossProfitSol,
    grossLossSol,
    profitFactor,
    maxDrawdownSol,
    maxDrawdownToGrossProfit,
    eligible: false,
  };
  const rejectionReasons = provenTraderProfileReasons(base);

  return {
    ...base,
    eligible: rejectionReasons.length === 0,
    observedSwaps: swaps.length,
    matchedBuys,
    matchedSells,
    lookbackDays: LOOKBACK_DAYS,
    rejectionReasons,
    profiledAt: new Date(nowMs).toISOString(),
  };
}

async function fetchJsonWithRetry(url: string, timeoutMs: number): Promise<unknown> {
  const delays = [0, 2_000, 8_000];
  let lastError: unknown;

  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt] > 0) await sleep(delays[attempt]);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (
        !(error instanceof Error) ||
        (!error.message.includes("429") &&
          !error.message.match(/HTTP 5\d\d/) &&
          error.name !== "AbortError")
      ) {
        throw error;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}

export async function fetchProvenTraderProfile(input: {
  wallet: string;
  apiKey: string;
  limit?: number;
  timeoutMs?: number;
}): Promise<ProvenTraderProfile> {
  const limit = Math.min(100, Math.max(20, Math.floor(input.limit ?? 50)));
  const cutoffSec = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 86_400;
  const url =
    `https://mainnet.helius-rpc.com/v0/addresses/${encodeURIComponent(input.wallet)}/transactions` +
    `?api-key=${encodeURIComponent(input.apiKey)}&type=SWAP&limit=${limit}` +
    `&token-accounts=balanceChanged&gte-time=${cutoffSec}`;
  const body = await fetchJsonWithRetry(url, input.timeoutMs ?? 15_000);
  if (!Array.isArray(body)) {
    throw new Error("Helius returned an unexpected proven-trader response");
  }
  return profileProvenTraderTransactions(
    body as HeliusProfileTransaction[],
    input.wallet
  );
}

export { PROVEN_TRADER_RULES };
