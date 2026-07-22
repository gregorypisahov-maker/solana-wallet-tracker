import "dotenv/config";
import { PublicKey } from "@solana/web3.js";
import { extractTrade, getConnection, getParsedTx } from "../lib/solana";
import { getSupabaseAdmin } from "../lib/supabase";

const supabase = getSupabaseAdmin();
const connection = getConnection();

const SCAN_INTERVAL_MS = boundedNumber(
  process.env.WALLET_LAB_SCAN_INTERVAL_MS,
  5 * 60_000,
  60_000,
  60 * 60_000
);
const RPC_DELAY_MS = boundedNumber(
  process.env.WALLET_LAB_RPC_DELAY_MS,
  275,
  125,
  5_000
);
const DEFAULT_SCAN_LIMIT = Math.floor(
  boundedNumber(process.env.WALLET_LAB_MAX_SIGNATURES, 80, 20, 200)
);
const MAX_SCANS_PER_RUN = Math.floor(
  boundedNumber(process.env.WALLET_LAB_SCANS_PER_RUN, 2, 1, 5)
);

type CandidateRow = {
  wallet_address: string;
  source: string;
  status: string;
  scan_limit: number | null;
};

type LabTradeRow = {
  wallet_address: string;
  signature: string;
  token_mint: string;
  side: "buy" | "sell";
  sol_amount: number | string;
  token_amount: number | string;
  tx_time: string;
};

type Lot = {
  remainingTokens: number;
  costSol: number;
  boughtAtMs: number;
};

type MatchedExit = {
  pnlSol: number;
  returnPct: number;
  holdMinutes: number;
  costSol: number;
};

function boundedNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pairRealizedTrades(rows: LabTradeRow[]): {
  exits: MatchedExit[];
  unmatchedSellTokenAmount: number;
  totalSellTokenAmount: number;
} {
  const lotsByMint = new Map<string, Lot[]>();
  const exits: MatchedExit[] = [];
  let unmatchedSellTokenAmount = 0;
  let totalSellTokenAmount = 0;

  for (const row of [...rows].sort((a, b) => Date.parse(a.tx_time) - Date.parse(b.tx_time))) {
    const tokenAmount = numberValue(row.token_amount);
    const solAmount = numberValue(row.sol_amount);
    if (tokenAmount <= 0 || solAmount <= 0) continue;

    if (row.side === "buy") {
      const lots = lotsByMint.get(row.token_mint) ?? [];
      lots.push({
        remainingTokens: tokenAmount,
        costSol: solAmount,
        boughtAtMs: Date.parse(row.tx_time),
      });
      lotsByMint.set(row.token_mint, lots);
      continue;
    }

    totalSellTokenAmount += tokenAmount;
    let remainingToMatch = tokenAmount;
    let matchedTokens = 0;
    let matchedCostSol = 0;
    let weightedHoldMinutes = 0;
    const lots = lotsByMint.get(row.token_mint) ?? [];
    const soldAtMs = Date.parse(row.tx_time);

    while (remainingToMatch > 0 && lots.length > 0) {
      const lot = lots[0];
      const consumed = Math.min(remainingToMatch, lot.remainingTokens);
      const priorTokens = lot.remainingTokens;
      const consumedFraction = consumed / priorTokens;
      const consumedCost = lot.costSol * consumedFraction;
      matchedTokens += consumed;
      matchedCostSol += consumedCost;
      weightedHoldMinutes +=
        consumed * Math.max(0, soldAtMs - lot.boughtAtMs) / 60_000;
      remainingToMatch -= consumed;
      lot.remainingTokens -= consumed;
      lot.costSol -= consumedCost;

      if (lot.remainingTokens <= 1e-12 || lot.costSol <= 1e-12) lots.shift();
    }

    lotsByMint.set(row.token_mint, lots);
    unmatchedSellTokenAmount += Math.max(0, remainingToMatch);
    if (matchedTokens <= 0 || matchedCostSol <= 0) continue;

    const matchedProceeds = solAmount * (matchedTokens / tokenAmount);
    const pnlSol = matchedProceeds - matchedCostSol;
    exits.push({
      pnlSol,
      returnPct: pnlSol / matchedCostSol,
      holdMinutes: weightedHoldMinutes / matchedTokens,
      costSol: matchedCostSol,
    });
  }

  return { exits, unmatchedSellTokenAmount, totalSellTokenAmount };
}

function buildProfile(rows: LabTradeRow[], signaturesSeen: number) {
  const paired = pairRealizedTrades(rows);
  const exits = paired.exits;
  const wins = exits.filter((item) => item.pnlSol > 0);
  const losses = exits.filter((item) => item.pnlSol < 0);
  const realizedPnlSol = exits.reduce((sum, item) => sum + item.pnlSol, 0);
  const grossProfitSol = wins.reduce((sum, item) => sum + item.pnlSol, 0);
  const grossLossSol = Math.abs(losses.reduce((sum, item) => sum + item.pnlSol, 0));
  const profitFactor = grossLossSol > 0 ? grossProfitSol / grossLossSol : grossProfitSol > 0 ? 99 : 0;
  const winRate = exits.length > 0 ? wins.length / exits.length : 0;
  const averageReturnPct =
    exits.length > 0 ? exits.reduce((sum, item) => sum + item.returnPct, 0) / exits.length : 0;
  const medianReturnPct = median(exits.map((item) => item.returnPct));
  const averageHoldMinutes =
    exits.length > 0 ? exits.reduce((sum, item) => sum + item.holdMinutes, 0) / exits.length : 0;
  const medianHoldMinutes = median(exits.map((item) => item.holdMinutes));
  const copyabilityRatio =
    paired.totalSellTokenAmount > 0
      ? clamp(1 - paired.unmatchedSellTokenAmount / paired.totalSellTokenAmount, 0, 1)
      : 0;
  const distinctTokens = new Set(rows.map((row) => row.token_mint)).size;
  const timestamps = rows.map((row) => Date.parse(row.tx_time)).filter(Number.isFinite);
  const observationDays =
    timestamps.length > 1
      ? Math.max(1 / 24, (Math.max(...timestamps) - Math.min(...timestamps)) / 86_400_000)
      : 0;
  const swapsPerDay = observationDays > 0 ? rows.length / observationDays : rows.length;

  // The Lab Quality percentage measures how attractive the wallet is to copy,
  // not how impressive its raw leaderboard PnL looks.
  const scoreBreakdown = {
    profit_factor: clamp(((profitFactor - 0.7) / 1.3) * 25, 0, 25),
    win_rate: clamp(((winRate - 0.3) / 0.4) * 25, 0, 25),
    realized_pnl: clamp(((realizedPnlSol + 0.1) / 1.1) * 15, 0, 15),
    sample_confidence: clamp((exits.length / 30) * 15, 0, 15),
    copyability: clamp(copyabilityRatio * 10, 0, 10),
    hold_time: clamp(((medianHoldMinutes ?? 0) / 3) * 10, 0, 10),
  };
  const labQualityPercent = Math.round(
    Object.values(scoreBreakdown).reduce((sum, value) => sum + value, 0)
  );

  const rejectionReasons: string[] = [];
  if (exits.length < 10) rejectionReasons.push(`insufficient_matched_exits:${exits.length}<10`);
  if (profitFactor < 1.2) rejectionReasons.push(`profit_factor_below_1.2:${profitFactor.toFixed(2)}`);
  if (winRate < 0.45) rejectionReasons.push(`win_rate_below_45pct:${(winRate * 100).toFixed(1)}`);
  if (realizedPnlSol <= 0) rejectionReasons.push(`non_positive_realized_pnl:${realizedPnlSol.toFixed(4)}`);
  if (copyabilityRatio < 0.7) rejectionReasons.push(`copyability_below_70pct:${(copyabilityRatio * 100).toFixed(1)}`);
  if ((medianHoldMinutes ?? 0) < 2) rejectionReasons.push(`median_hold_below_2m:${(medianHoldMinutes ?? 0).toFixed(2)}`);
  if (labQualityPercent < 65) rejectionReasons.push(`lab_quality_below_65pct:${labQualityPercent}`);

  return {
    profile_version: "alchemy_fifo_copyability_v1_2026_07_23",
    provider: "provider_neutral_solana_rpc",
    signatures_seen: signaturesSeen,
    parsed_swaps: rows.length,
    buys: rows.filter((row) => row.side === "buy").length,
    sells: rows.filter((row) => row.side === "sell").length,
    distinct_tokens: distinctTokens,
    matched_exits: exits.length,
    wins: wins.length,
    losses: losses.length,
    win_rate: Number(winRate.toFixed(4)),
    profit_factor: Number(profitFactor.toFixed(3)),
    realized_pnl_sol: Number(realizedPnlSol.toFixed(6)),
    average_return_pct: Number((averageReturnPct * 100).toFixed(2)),
    median_return_pct: medianReturnPct == null ? null : Number((medianReturnPct * 100).toFixed(2)),
    average_hold_minutes: Number(averageHoldMinutes.toFixed(2)),
    median_hold_minutes: medianHoldMinutes == null ? null : Number(medianHoldMinutes.toFixed(2)),
    copyability_ratio: Number(copyabilityRatio.toFixed(4)),
    swaps_per_day: Number(swapsPerDay.toFixed(2)),
    lab_quality_percent: labQualityPercent,
    quality_label:
      labQualityPercent >= 80
        ? "excellent"
        : labQualityPercent >= 65
          ? "good"
          : labQualityPercent >= 50
            ? "watch"
            : "poor",
    score_breakdown: Object.fromEntries(
      Object.entries(scoreBreakdown).map(([key, value]) => [key, Number(value.toFixed(2))])
    ),
    qualifies_for_trial: rejectionReasons.length === 0,
    rejection_reasons: rejectionReasons,
    scanned_at: new Date().toISOString(),
  };
}

async function claimNextCandidate(): Promise<CandidateRow | null> {
  const { data: queued, error } = await supabase
    .from("wallet_lab_candidates")
    .select("wallet_address,source,status,scan_limit")
    .eq("scan_status", "queued")
    .order("leaderboard_score", { ascending: false })
    .order("scan_requested_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to load Wallet Lab scan queue: ${error.message}`);
  if (!queued) return null;

  const { data: claimed, error: claimError } = await supabase
    .from("wallet_lab_candidates")
    .update({
      scan_status: "running",
      scan_started_at: new Date().toISOString(),
      scan_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("wallet_address", queued.wallet_address)
    .eq("scan_status", "queued")
    .select("wallet_address,source,status,scan_limit")
    .maybeSingle();
  if (claimError) throw new Error(`Failed to claim Wallet Lab scan: ${claimError.message}`);
  return (claimed as CandidateRow | null) ?? null;
}

async function scanCandidate(candidate: CandidateRow): Promise<void> {
  const address = candidate.wallet_address;
  new PublicKey(address);
  const limit = Math.floor(clamp(numberValue(candidate.scan_limit) || DEFAULT_SCAN_LIMIT, 20, 200));
  const signatures = await connection.getSignaturesForAddress(
    new PublicKey(address),
    { limit },
    "confirmed"
  );
  const rows: LabTradeRow[] = [];

  for (const signatureInfo of [...signatures].reverse()) {
    if (signatureInfo.err) continue;
    await sleep(RPC_DELAY_MS);
    const tx = await getParsedTx(connection, signatureInfo.signature);
    if (!tx) continue;
    const trade = extractTrade(tx, address);
    if (!trade || trade.solAmount <= 0 || trade.tokenAmount <= 0) continue;
    rows.push({
      wallet_address: address,
      signature: trade.signature,
      token_mint: trade.tokenMint,
      side: trade.side,
      sol_amount: trade.solAmount,
      token_amount: trade.tokenAmount,
      tx_time: trade.txTime.toISOString(),
    });
  }

  if (rows.length > 0) {
    const { error: insertError } = await supabase
      .from("wallet_lab_transactions")
      .upsert(rows, {
        onConflict: "wallet_address,signature,token_mint,side",
        ignoreDuplicates: true,
      });
    if (insertError) throw new Error(`Failed to save Wallet Lab swaps: ${insertError.message}`);
  }

  const { data: history, error: historyError } = await supabase
    .from("wallet_lab_transactions")
    .select("wallet_address,signature,token_mint,side,sol_amount,token_amount,tx_time")
    .eq("wallet_address", address)
    .order("tx_time", { ascending: true });
  if (historyError) throw new Error(`Failed to read Wallet Lab history: ${historyError.message}`);

  const profile = buildProfile((history ?? []) as LabTradeRow[], signatures.length);
  const qualifies = Boolean(profile.qualifies_for_trial);
  const nextStatus = candidate.status === "trial" ? "trial" : qualifies ? "qualified" : "rejected";
  const now = new Date().toISOString();
  const { error: updateError } = await supabase
    .from("wallet_lab_candidates")
    .update({
      status: nextStatus,
      final_profile: profile,
      lab_trust_score: profile.lab_quality_percent,
      profiled_at: now,
      qualified_at: qualifies ? now : null,
      rejected_at: qualifies ? null : now,
      rejection_reasons: profile.rejection_reasons,
      scan_status: "complete",
      scan_completed_at: now,
      scan_error: null,
      updated_at: now,
    })
    .eq("wallet_address", address);
  if (updateError) throw new Error(`Failed to save Wallet Lab profile: ${updateError.message}`);

  const { data: activeWallet, error: walletReadError } = await supabase
    .from("wallets")
    .select("discovery_metrics")
    .eq("address", address)
    .maybeSingle();
  if (walletReadError) throw new Error(`Failed to read active wallet profile: ${walletReadError.message}`);
  if (activeWallet) {
    const current = (activeWallet.discovery_metrics ?? {}) as Record<string, unknown>;
    const { error: walletUpdateError } = await supabase
      .from("wallets")
      .update({
        discovery_metrics: {
          ...current,
          lab_profile: profile,
          lab_quality_percent: profile.lab_quality_percent,
          lab_profiled_at: now,
        },
        management_updated_at: now,
      })
      .eq("address", address);
    if (walletUpdateError) throw new Error(`Failed to update live wallet Lab profile: ${walletUpdateError.message}`);
  }

  console.log(
    `[wallet-lab] ${address.slice(0, 6)}… quality=${profile.lab_quality_percent}% ` +
      `PF=${profile.profit_factor} win=${(profile.win_rate * 100).toFixed(1)}% ` +
      `matched=${profile.matched_exits}`
  );
}

async function failCandidate(address: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await supabase
    .from("wallet_lab_candidates")
    .update({
      scan_status: "error",
      scan_error: message.slice(0, 1_000),
      scan_completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("wallet_address", address);
  console.error(`[wallet-lab] scan failed ${address}: ${message}`);
}

let running = false;

async function runQueue(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (let index = 0; index < MAX_SCANS_PER_RUN; index += 1) {
      const candidate = await claimNextCandidate();
      if (!candidate) break;
      try {
        await scanCandidate(candidate);
      } catch (error) {
        await failCandidate(candidate.wallet_address, error);
      }
    }
  } finally {
    running = false;
  }
}

export function startWalletLabProfilerScheduler(): void {
  void runQueue();
  setInterval(() => void runQueue(), SCAN_INTERVAL_MS);
  console.log(
    `[wallet-lab] provider-neutral profiler enabled; interval=${Math.round(SCAN_INTERVAL_MS / 1000)}s ` +
      `limit=${DEFAULT_SCAN_LIMIT} signatures; Helius calls=0`
  );
}
