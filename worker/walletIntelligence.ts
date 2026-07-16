import "dotenv/config";
import { getSupabaseAdmin } from "../lib/supabase";
import { computeAndStoreWalletPerformance } from "../paper-trader/walletPerformance";

const supabase = getSupabaseAdmin();

const RUN_INTERVAL_HOURS = boundedNumber(
  process.env.WALLET_INTELLIGENCE_INTERVAL_HOURS,
  6,
  1,
  72
);

const MIN_TRADES_TO_PROMOTE = Math.floor(
  boundedNumber(process.env.WALLET_PROMOTE_MIN_TRADES, 25, 10, 200)
);
const MIN_TRUST_TO_PROMOTE = boundedNumber(
  process.env.WALLET_PROMOTE_MIN_TRUST,
  55,
  35,
  90
);
const MIN_PROFIT_FACTOR_TO_PROMOTE = boundedNumber(
  process.env.WALLET_PROMOTE_MIN_PROFIT_FACTOR,
  1.3,
  1,
  3
);

const MIN_TRADES_TO_DISABLE = Math.floor(
  boundedNumber(process.env.WALLET_DISABLE_MIN_TRADES, 20, 20, 300)
);
const MAX_PROFIT_FACTOR_TO_DISABLE = boundedNumber(
  process.env.WALLET_DISABLE_MAX_PROFIT_FACTOR,
  0.95,
  0.2,
  1.2
);
const MAX_DISABLE_PER_RUN = Math.floor(
  boundedNumber(process.env.WALLET_DISABLE_MAX_PER_RUN, 3, 1, 10)
);

// A trial wallet can be slightly profitable yet still consume a scarce slot
// without contributing enough edge. Review only after a large sample so normal
// variance cannot remove a potentially good wallet too early.
const MIN_TRADES_TO_DISABLE_MEDIOCRE = Math.floor(
  boundedNumber(process.env.WALLET_DISABLE_MEDIOCRE_MIN_TRADES, 40, 30, 300)
);
const MAX_PROFIT_FACTOR_MEDIOCRE = boundedNumber(
  process.env.WALLET_DISABLE_MEDIOCRE_MAX_PROFIT_FACTOR,
  1.1,
  1,
  1.3
);
const MAX_TRUST_MEDIOCRE = boundedNumber(
  process.env.WALLET_DISABLE_MEDIOCRE_MAX_TRUST,
  45,
  25,
  60
);

// Trial wallets that never produce a matched paper trade eventually block
// discovery from testing fresh candidates. Proven wallets are never disabled
// by this inactivity rule.
const INACTIVE_TRIAL_DAYS = boundedNumber(
  process.env.WALLET_DISABLE_INACTIVE_TRIAL_DAYS,
  3,
  1,
  30
);

function boundedNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

interface PerformanceRow {
  wallet_address: string;
  completed_trades: number | string | null;
  realized_pnl_sol: number | string | null;
  profit_factor: number | string | null;
  trust_score: number | string | null;
}

interface WalletRow {
  address: string;
  active: boolean;
  management_status: "trial" | "proven" | "disabled";
  discovered_at: string | null;
  created_at?: string | null;
}

function n(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function ageDays(value: string | null | undefined, nowMs: number): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, (nowMs - timestamp) / 86_400_000);
}

async function disableWallet(address: string, reason: string, now: string): Promise<boolean> {
  const { error } = await supabase
    .from("wallets")
    .update({
      active: false,
      management_status: "disabled",
      auto_disabled_at: now,
      auto_disable_reason: reason,
      management_updated_at: now,
    })
    .eq("address", address)
    .eq("active", true)
    .eq("management_status", "trial");

  if (error) {
    console.error(`[wallet-intelligence] Failed to disable ${address}:`, error);
    return false;
  }

  return true;
}

export async function runWalletIntelligence(): Promise<{
  walletsScored: number;
  promoted: string[];
  disabled: string[];
}> {
  const { walletsUpdated } = await computeAndStoreWalletPerformance();

  const [{ data: wallets, error: walletError }, { data: performance, error: perfError }] =
    await Promise.all([
      supabase.from("wallets").select("address, active, management_status, discovered_at, created_at"),
      supabase
        .from("wallet_performance")
        .select("wallet_address, completed_trades, realized_pnl_sol, profit_factor, trust_score"),
    ]);

  if (walletError) throw new Error(`Failed to load wallets: ${walletError.message}`);
  if (perfError) throw new Error(`Failed to load wallet performance: ${perfError.message}`);

  const walletRows = (wallets ?? []) as WalletRow[];
  const walletMap = new Map(walletRows.map((row) => [row.address, row]));
  const performanceMap = new Map(
    ((performance ?? []) as PerformanceRow[]).map((row) => [row.wallet_address, row])
  );
  const promoted: string[] = [];
  const disabled: string[] = [];
  const now = new Date().toISOString();
  const nowMs = Date.now();

  const ranked = ((performance ?? []) as PerformanceRow[])
    .map((row) => ({
      row,
      wallet: walletMap.get(row.wallet_address),
      trades: n(row.completed_trades),
      pnl: n(row.realized_pnl_sol),
      trust: n(row.trust_score, 50),
      profitFactor: row.profit_factor === null ? null : n(row.profit_factor),
    }))
    .filter((item) => item.wallet && item.wallet.management_status !== "disabled")
    .sort((a, b) => {
      const aPf = a.profitFactor ?? 1;
      const bPf = b.profitFactor ?? 1;
      return aPf - bPf || a.pnl - b.pnl || b.trades - a.trades;
    });

  // First free slots held by trial wallets that have produced no usable evidence.
  // Old manually-added rows may lack discovered_at, so created_at is used as a fallback.
  const inactiveTrials = walletRows
    .filter((wallet) => wallet.active && wallet.management_status === "trial")
    .map((wallet) => {
      const perf = performanceMap.get(wallet.address);
      const trades = n(perf?.completed_trades);
      const age = ageDays(wallet.discovered_at ?? wallet.created_at, nowMs);
      return { wallet, trades, age };
    })
    .filter((item) => item.trades === 0 && item.age !== null && item.age >= INACTIVE_TRIAL_DAYS)
    .sort((a, b) => (b.age ?? 0) - (a.age ?? 0));

  for (const item of inactiveTrials) {
    if (disabled.length >= MAX_DISABLE_PER_RUN) break;
    const reason =
      `Auto-disabled inactive trial wallet after ${(item.age ?? 0).toFixed(1)} days ` +
      `with 0 matched paper trades, freeing a slot for a fresh candidate`;
    if (await disableWallet(item.wallet.address, reason, now)) {
      disabled.push(item.wallet.address);
    }
  }

  // Then remove confirmed losing or persistently weak TRIAL wallets. Proven
  // wallets are protected from automatic removal and require manual review.
  for (const item of ranked) {
    if (disabled.length >= MAX_DISABLE_PER_RUN) break;
    const { row, wallet, trades, pnl, trust, profitFactor } = item;
    if (!wallet || wallet.management_status !== "trial" || !wallet.active) continue;

    const confirmedLoser =
      trades >= MIN_TRADES_TO_DISABLE &&
      pnl < 0 &&
      profitFactor !== null &&
      profitFactor < MAX_PROFIT_FACTOR_TO_DISABLE;

    const confirmedMediocre =
      trades >= MIN_TRADES_TO_DISABLE_MEDIOCRE &&
      profitFactor !== null &&
      profitFactor < MAX_PROFIT_FACTOR_MEDIOCRE &&
      trust < MAX_TRUST_MEDIOCRE;

    if (!confirmedLoser && !confirmedMediocre) continue;

    const reason = confirmedLoser
      ? `Auto-disabled confirmed losing trial after ${trades} trades: ${pnl.toFixed(4)} SOL PnL, ` +
        `PF ${profitFactor!.toFixed(3)}, trust ${trust.toFixed(1)}`
      : `Auto-disabled persistently weak trial after ${trades} trades: ${pnl.toFixed(4)} SOL PnL, ` +
        `PF ${profitFactor!.toFixed(3)}, trust ${trust.toFixed(1)}`;

    if (await disableWallet(row.wallet_address, reason, now)) {
      disabled.push(row.wallet_address);
    }
  }

  // Promote only wallets whose edge is strong enough for the real-SOL readiness target.
  for (const item of ranked) {
    const { row, wallet, trades, pnl, trust, profitFactor } = item;
    if (!wallet || disabled.includes(row.wallet_address)) continue;

    const shouldPromote =
      wallet.management_status === "trial" &&
      wallet.active &&
      trades >= MIN_TRADES_TO_PROMOTE &&
      pnl > 0 &&
      trust >= MIN_TRUST_TO_PROMOTE &&
      profitFactor !== null &&
      profitFactor >= MIN_PROFIT_FACTOR_TO_PROMOTE;

    if (!shouldPromote) continue;

    const { error } = await supabase
      .from("wallets")
      .update({
        management_status: "proven",
        management_updated_at: now,
        auto_disable_reason: null,
        auto_disabled_at: null,
      })
      .eq("address", row.wallet_address)
      .eq("management_status", "trial")
      .eq("active", true);

    if (error) {
      console.error(`[wallet-intelligence] Failed to promote ${row.wallet_address}:`, error);
    } else {
      promoted.push(row.wallet_address);
    }
  }

  const { error: auditError } = await supabase.from("wallet_intelligence_runs").insert({
    wallets_scored: walletsUpdated,
    promoted_count: promoted.length,
    disabled_count: disabled.length,
    promoted_addresses: promoted,
    disabled_addresses: disabled,
    notes: {
      promote_rules: {
        min_trades: MIN_TRADES_TO_PROMOTE,
        min_trust: MIN_TRUST_TO_PROMOTE,
        min_profit_factor: MIN_PROFIT_FACTOR_TO_PROMOTE,
        positive_pnl_required: true,
      },
      disable_rules: {
        min_trades: MIN_TRADES_TO_DISABLE,
        max_profit_factor: MAX_PROFIT_FACTOR_TO_DISABLE,
        negative_pnl_required: true,
        mediocre_min_trades: MIN_TRADES_TO_DISABLE_MEDIOCRE,
        mediocre_max_profit_factor: MAX_PROFIT_FACTOR_MEDIOCRE,
        mediocre_max_trust: MAX_TRUST_MEDIOCRE,
        inactive_trial_days: INACTIVE_TRIAL_DAYS,
        max_disabled_per_run: MAX_DISABLE_PER_RUN,
        trial_wallets_only: true,
        bottom_performers_first: true,
      },
    },
  });

  if (auditError) {
    console.error("[wallet-intelligence] Failed to store audit run:", auditError);
  }

  console.log(
    `[wallet-intelligence] scored ${walletsUpdated}; promoted ${promoted.length}; disabled ${disabled.length}`
  );

  return { walletsScored: walletsUpdated, promoted, disabled };
}

let running = false;
let schedulerStarted = false;

export function startWalletIntelligenceScheduler(): void {
  if (schedulerStarted) {
    console.warn("[wallet-intelligence] scheduler already started in this process; duplicate ignored");
    return;
  }
  schedulerStarted = true;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      await runWalletIntelligence();
    } catch (error) {
      console.error("[wallet-intelligence] run failed safely:", error);
    } finally {
      running = false;
    }
  };

  void run();
  setInterval(() => void run(), RUN_INTERVAL_HOURS * 3_600_000);

  console.log(
    `[wallet-intelligence] enabled every ${RUN_INTERVAL_HOURS}h; ` +
      `promote after ${MIN_TRADES_TO_PROMOTE}+ trades at PF ${MIN_PROFIT_FACTOR_TO_PROMOTE}+; ` +
      `disable up to ${MAX_DISABLE_PER_RUN} weak/inactive trial wallets per run`
  );
}
