import "dotenv/config";
import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "../lib/supabase";
import { fetchTokenMarketData } from "../lib/tokenData";
import { computeScore } from "../lib/scoring";
import { getConnection, fetchNewSignatures, getParsedTx, extractTrade } from "../lib/solana";
import { onLabAlert, checkLabPositions } from "../paper-trader/labStrategy";
import { AlertInput } from "../paper-trader/types";
import { estimateHeliusCredits, HeliusUsageTracker } from "./heliusUsage";

const supabase = getSupabaseAdmin();
const connection = getConnection();
const usage = new HeliusUsageTracker();
const instanceId = randomUUID();

const SIGNAL_WINDOW_HOURS = 24;
const FRESH_MINUTES = 20;
const MIN_TOTAL_SOL = 0.25;
const MIN_TRACKED_SOL = 0.01;
const MAX_TRADE_AGE_MS = 180_000;
const POLL_INTERVAL_MS = 60_000;
const SCAN_INTERVAL_MS = 15_000;
const POSITION_INTERVAL_MS = 5_000;
const USAGE_INTERVAL_MS = 15 * 60_000;

type BuyRow = {
  wallet_address: string;
  token_mint: string;
  sol_amount: number | string;
  tx_time: string;
};

type LabCandidate = {
  wallet_address: string;
  last_signature: string | null;
  lab_trust_score: number | string | null;
  final_profile: Record<string, unknown> | null;
};

function number(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function confidenceGrade(trust: number): "A" | "B" | "C" | "D" {
  if (trust >= 70) return "A";
  if (trust >= 60) return "B";
  if (trust >= 55) return "C";
  return "D";
}

async function loadTrialCandidates(): Promise<LabCandidate[]> {
  const { data, error } = await supabase
    .from("wallet_lab_candidates")
    .select("wallet_address,last_signature,lab_trust_score,final_profile")
    .eq("status", "trial")
    .order("promoted_at", { ascending: true })
    .limit(2);
  if (error) throw new Error(`lab trial-wallet load failed: ${error.message}`);
  return (data ?? []) as LabCandidate[];
}

async function checkpoint(address: string, signature: string): Promise<void> {
  const { error } = await supabase
    .from("wallet_lab_candidates")
    .update({ last_signature: signature, updated_at: new Date().toISOString() })
    .eq("wallet_address", address)
    .eq("status", "trial");
  if (error) throw new Error(`lab cursor update failed: ${error.message}`);
}

async function storeTrade(candidate: LabCandidate, signature: string): Promise<boolean> {
  usage.increment("transactionRequests");
  const tx = await getParsedTx(connection, signature);
  if (!tx) return false;
  const trade = extractTrade(tx, candidate.wallet_address);
  if (!trade || trade.solAmount < MIN_TRACKED_SOL) return false;
  if (Date.now() - trade.txTime.getTime() > MAX_TRADE_AGE_MS) return false;

  const oppositeSide = trade.side === "buy" ? "sell" : "buy";
  const windowStart = new Date(trade.txTime.getTime() - 5 * 60_000).toISOString();
  const windowEnd = new Date(trade.txTime.getTime() + 5 * 60_000).toISOString();
  const { data: opposite, error: oppositeError } = await supabase
    .from("wallet_lab_transactions")
    .select("id")
    .eq("wallet_address", candidate.wallet_address)
    .eq("token_mint", trade.tokenMint)
    .eq("side", oppositeSide)
    .gte("tx_time", windowStart)
    .lte("tx_time", windowEnd);
  if (oppositeError) throw new Error(`lab scalp lookup failed: ${oppositeError.message}`);
  const isScalp = Boolean(opposite?.length);
  if (opposite?.length) {
    const { error } = await supabase
      .from("wallet_lab_transactions")
      .update({ is_scalp: true })
      .in("id", opposite.map((row) => row.id));
    if (error) throw new Error(`lab scalp update failed: ${error.message}`);
  }

  const { data, error } = await supabase
    .from("wallet_lab_transactions")
    .upsert(
      {
        wallet_address: candidate.wallet_address,
        signature: trade.signature,
        token_mint: trade.tokenMint,
        side: trade.side,
        sol_amount: trade.solAmount,
        token_amount: trade.tokenAmount,
        tx_time: trade.txTime.toISOString(),
        is_scalp: isScalp,
      },
      {
        onConflict: "wallet_address,signature,token_mint,side",
        ignoreDuplicates: true,
      }
    )
    .select("id");
  if (error) throw new Error(`lab transaction insert failed: ${error.message}`);
  if (data?.length) usage.increment("storedTrades");
  return Boolean(data?.length);
}

async function pollCandidate(candidate: LabCandidate): Promise<number> {
  usage.increment("signatureRequests");
  const signatures = await fetchNewSignatures(
    connection,
    candidate.wallet_address,
    candidate.last_signature,
    candidate.last_signature ? 25 : 1
  );
  if (!signatures.length) return 0;

  if (!candidate.last_signature) {
    await checkpoint(candidate.wallet_address, signatures[0].signature);
    console.log(`[wallet-lab-intake] initialized ${candidate.wallet_address.slice(0, 6)}… at now`);
    return 0;
  }

  let stored = 0;
  for (const signature of signatures) {
    try {
      if (await storeTrade(candidate, signature.signature)) stored += 1;
      await checkpoint(candidate.wallet_address, signature.signature);
    } catch (error) {
      console.error(
        `[wallet-lab-intake] ${candidate.wallet_address.slice(0, 6)} ${signature.signature.slice(0, 8)} failed:`,
        error
      );
      break;
    }
  }
  return stored;
}

async function runIntake(): Promise<void> {
  const candidates = await loadTrialCandidates();
  if (candidates.length === 0) return;
  let stored = 0;
  for (const candidate of candidates) stored += await pollCandidate(candidate);
  if (stored > 0) console.log(`[wallet-lab-intake] stored ${stored} new lab-wallet trade(s)`);
}

async function runSignalScan(): Promise<void> {
  const candidates = await loadTrialCandidates();
  if (candidates.length === 0) return;
  const labWallets = candidates.map((candidate) => candidate.wallet_address);
  const candidateMap = new Map(candidates.map((candidate) => [candidate.wallet_address, candidate]));

  const cutoff = new Date(Date.now() - SIGNAL_WINDOW_HOURS * 3_600_000).toISOString();
  const freshCutoff = Date.now() - FRESH_MINUTES * 60_000;
  const { data: buys, error: buyError } = await supabase
    .from("wallet_lab_transactions")
    .select("wallet_address,token_mint,sol_amount,tx_time")
    .in("wallet_address", labWallets)
    .eq("side", "buy")
    .eq("is_scalp", false)
    .gte("tx_time", cutoff);
  if (buyError) throw new Error(`lab buy load failed: ${buyError.message}`);

  const grouped = new Map<
    string,
    { wallets: Set<string>; totalSol: number; lastBuyMs: number; walletSol: Map<string, number> }
  >();
  for (const buy of (buys ?? []) as BuyRow[]) {
    const txMs = Date.parse(buy.tx_time);
    if (!Number.isFinite(txMs)) continue;
    const current = grouped.get(buy.token_mint) ?? {
      wallets: new Set<string>(),
      totalSol: 0,
      lastBuyMs: 0,
      walletSol: new Map<string, number>(),
    };
    const sol = number(buy.sol_amount);
    current.wallets.add(buy.wallet_address);
    current.totalSol += sol;
    current.lastBuyMs = Math.max(current.lastBuyMs, txMs);
    current.walletSol.set(buy.wallet_address, (current.walletSol.get(buy.wallet_address) ?? 0) + sol);
    grouped.set(buy.token_mint, current);
  }

  const { data: recentSignals, error: recentError } = await supabase
    .from("wallet_lab_signals")
    .select("token_mint")
    .gte("created_at", cutoff);
  if (recentError) throw new Error(`lab signal dedupe load failed: ${recentError.message}`);
  const recentMints = new Set((recentSignals ?? []).map((row) => row.token_mint));

  const pending = [...grouped.entries()]
    .filter(([, group]) => group.lastBuyMs >= freshCutoff)
    .filter(([, group]) => group.totalSol >= MIN_TOTAL_SOL)
    .filter(([mint]) => !recentMints.has(mint))
    .sort((a, b) => b[1].lastBuyMs - a[1].lastBuyMs)
    .slice(0, 5);

  for (const [mint, group] of pending) {
    try {
      const participants = [...group.wallets].map((address) => {
        const candidate = candidateMap.get(address);
        return {
          address,
          solAmount: group.walletSol.get(address) ?? 0,
          trustScore: number(candidate?.lab_trust_score, 55),
          profile: candidate?.final_profile ?? null,
        };
      });
      const averageTrust =
        participants.reduce((sum, participant) => sum + participant.trustScore, 0) /
        Math.max(1, participants.length);
      const market = await fetchTokenMarketData(mint);
      const baseScore = computeScore({
        walletsCount: participants.length,
        liquidityUsd: market.liquidityUsd,
        marketCap: market.marketCap,
        holders: market.holders,
        holdersPrev: null,
        dumpDetected: false,
        scalpDetected: false,
      });
      const score = Math.max(baseScore, Math.round(averageTrust / 5));
      const alert: AlertInput = {
        tokenSymbol: market.symbol,
        mint,
        score,
        walletCount: participants.length,
        totalBoughtSol: group.totalSol,
        marketCapUsd: market.marketCap ?? 0,
        liquidityUsd: market.liquidityUsd ?? 0,
        weightedWalletScore: score,
        averageTrustScore: Number(averageTrust.toFixed(2)),
        confidenceGrade: confidenceGrade(averageTrust),
        signalSource: "wallet_lab",
        leaderWallet: participants[0]?.address,
        strategyVersion: "wallet_lab_dual_v1_2026_07_21",
      };

      await onLabAlert(alert);
      const { error: insertError } = await supabase.from("wallet_lab_signals").insert({
        token_mint: mint,
        token_symbol: market.symbol,
        wallets_count: participants.length,
        total_sol_bought: group.totalSol,
        score,
        market_cap_usd: market.marketCap ?? 0,
        liquidity_usd: market.liquidityUsd ?? 0,
        average_trust_score: Number(averageTrust.toFixed(2)),
        participants,
        alert,
        created_at: new Date().toISOString(),
      });
      if (insertError) throw new Error(`lab signal insert failed: ${insertError.message}`);
      console.log(
        `[wallet-lab-signal] ${market.symbol} from ${participants.length} isolated lab wallet(s); ` +
          `${group.totalSol.toFixed(2)} SOL; trust ${averageTrust.toFixed(1)}`
      );
    } catch (error) {
      console.error(`[wallet-lab-signal] ${mint.slice(0, 6)} failed safely:`, error);
    }
  }
}

async function persistUsage(): Promise<void> {
  const snapshot = usage.snapshot();
  const active =
    snapshot.signatureRequests + snapshot.transactionRequests + snapshot.storedTrades > 0;
  if (!active) return;
  const { error } = await supabase.from("monitor_usage_samples").upsert(
    {
      instance_id: instanceId,
      period_started_at: snapshot.periodStartedAt,
      recorded_at: snapshot.capturedAt,
      signature_requests: snapshot.signatureRequests,
      transaction_requests: snapshot.transactionRequests,
      webhook_events: 0,
      websocket_notifications: 0,
      websocket_bytes: 0,
      rate_limit_errors: snapshot.rateLimitErrors,
      rpc_failures: snapshot.rpcFailures,
      stored_trades: snapshot.storedTrades,
      duplicate_events: snapshot.duplicateEvents,
      max_queue_depth: 0,
      mode: "wallet_lab_poll",
    },
    { onConflict: "instance_id,period_started_at" }
  );
  if (error) {
    console.error("[wallet-lab-usage] save failed:", error);
    return;
  }
  usage.commit(snapshot);
  console.log(
    `[wallet-lab-usage] estimated ${estimateHeliusCredits({
      signatureRequests: snapshot.signatureRequests,
      transactionRequests: snapshot.transactionRequests,
      websocketBytes: 0,
    })} credits since ${snapshot.periodStartedAt}`
  );
}

let intakeRunning = false;
let scanRunning = false;
let positionsRunning = false;
let started = false;

export function startLabStrategyScheduler(): void {
  if (started) return;
  started = true;

  const intake = async () => {
    if (intakeRunning) return;
    intakeRunning = true;
    try {
      await runIntake();
    } catch (error) {
      usage.increment("rpcFailures");
      console.error("[wallet-lab-intake] poll failed safely:", error);
    } finally {
      intakeRunning = false;
    }
  };
  const scan = async () => {
    if (scanRunning) return;
    scanRunning = true;
    try {
      await runSignalScan();
    } catch (error) {
      console.error("[wallet-lab-signal] scan failed safely:", error);
    } finally {
      scanRunning = false;
    }
  };
  const check = async () => {
    if (positionsRunning) return;
    positionsRunning = true;
    try {
      await checkLabPositions();
    } catch (error) {
      console.error("[wallet-lab-strategy] position check failed safely:", error);
    } finally {
      positionsRunning = false;
    }
  };

  void intake();
  void scan();
  void check();
  setInterval(() => void intake(), POLL_INTERVAL_MS);
  setInterval(() => void scan(), SCAN_INTERVAL_MS);
  setInterval(() => void check(), POSITION_INTERVAL_MS);
  setInterval(() => void persistUsage(), USAGE_INTERVAL_MS);
  console.log(
    "[wallet-lab-strategy] fully isolated Lab Shadow + Lab Legion enabled; max two trial wallets; 60s low-cost intake"
  );
}
