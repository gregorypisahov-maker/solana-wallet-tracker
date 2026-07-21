import "dotenv/config";
import { getSupabaseAdmin } from "../lib/supabase";
import { fetchTokenMarketData } from "../lib/tokenData";
import { computeScore } from "../lib/scoring";
import { onLabAlert, checkLabPositions } from "../paper-trader/labStrategy";
import { AlertInput } from "../paper-trader/types";

const supabase = getSupabaseAdmin();

const SIGNAL_WINDOW_HOURS = 24;
const FRESH_MINUTES = 20;
const MIN_TOTAL_SOL = 0.25;
const SCAN_INTERVAL_MS = 15_000;
const POSITION_INTERVAL_MS = 5_000;

type BuyRow = {
  wallet_address: string;
  token_mint: string;
  sol_amount: number | string;
  tx_time: string;
};

type LabCandidate = {
  wallet_address: string;
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

async function runSignalScan(): Promise<void> {
  const { data: walletRows, error: walletError } = await supabase
    .from("wallets")
    .select("address")
    .eq("active", true)
    .eq("discovery_source", "wallet_lab");
  if (walletError) throw new Error(`lab wallet load failed: ${walletError.message}`);
  const labWallets = (walletRows ?? []).map((row) => row.address);
  if (labWallets.length === 0) return;

  const cutoff = new Date(Date.now() - SIGNAL_WINDOW_HOURS * 3_600_000).toISOString();
  const freshCutoff = Date.now() - FRESH_MINUTES * 60_000;
  const [{ data: buys, error: buyError }, { data: candidates, error: candidateError }] =
    await Promise.all([
      supabase
        .from("wallet_transactions")
        .select("wallet_address,token_mint,sol_amount,tx_time")
        .in("wallet_address", labWallets)
        .eq("side", "buy")
        .eq("is_scalp", false)
        .gte("tx_time", cutoff),
      supabase
        .from("wallet_lab_candidates")
        .select("wallet_address,lab_trust_score,final_profile")
        .in("wallet_address", labWallets),
    ]);
  if (buyError) throw new Error(`lab buy load failed: ${buyError.message}`);
  if (candidateError) throw new Error(`lab candidate profile load failed: ${candidateError.message}`);

  const candidateMap = new Map(
    ((candidates ?? []) as LabCandidate[]).map((candidate) => [candidate.wallet_address, candidate])
  );
  const grouped = new Map<
    string,
    {
      wallets: Set<string>;
      totalSol: number;
      lastBuyMs: number;
      walletSol: Map<string, number>;
    }
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
        `[wallet-lab-signal] ${market.symbol} from ${participants.length} lab wallet(s); ` +
          `${group.totalSol.toFixed(2)} SOL; trust ${averageTrust.toFixed(1)}`
      );
    } catch (error) {
      console.error(`[wallet-lab-signal] ${mint.slice(0, 6)} failed safely:`, error);
    }
  }
}

let scanRunning = false;
let positionsRunning = false;
let started = false;

export function startLabStrategyScheduler(): void {
  if (started) return;
  started = true;

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

  void scan();
  void check();
  setInterval(() => void scan(), SCAN_INTERVAL_MS);
  setInterval(() => void check(), POSITION_INTERVAL_MS);
  console.log(
    "[wallet-lab-strategy] isolated Lab Shadow + Lab Legion enabled; core strategies excluded"
  );
}
