import "dotenv/config";
import { getSupabaseAdmin } from "../lib/supabase";
import { computeAndStoreWalletPerformance } from "../paper-trader/walletPerformance";

const supabase = getSupabaseAdmin();

const RUN_INTERVAL_HOURS = boundedNumber(
  process.env.WALLET_INTELLIGENCE_INTERVAL_HOURS,
  24,
  1,
  72
);

const MIN_TRADES_TO_PROMOTE = Math.floor(
  boundedNumber(process.env.WALLET_PROMOTE_MIN_TRADES, 20, 10, 200)
);
const MIN_TRUST_TO_PROMOTE = boundedNumber(
  process.env.WALLET_PROMOTE_MIN_TRUST,
  45,
  35,
  90
);
const MIN_PROFIT_FACTOR_TO_PROMOTE = boundedNumber(
  process.env.WALLET_PROMOTE_MIN_PROFIT_FACTOR,
  1.1,
  1,
  3
);

const MIN_TRADES_TO_DISABLE = Math.floor(
  boundedNumber(process.env.WALLET_DISABLE_MIN_TRADES, 30, 20, 300)
);
const MAX_PROFIT_FACTOR_TO_DISABLE = boundedNumber(
  process.env.WALLET_DISABLE_MAX_PROFIT_FACTOR,
  1,
  0.2,
  1.2
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
}

function n(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function runWalletIntelligence(): Promise<{
  walletsScored: number;
  promoted: string[];
  disabled: string[];
}> {
  const { walletsUpdated } = await computeAndStoreWalletPerformance();

  const [{ data: wallets, error: walletError }, { data: performance, error: perfError }] =
    await Promise.all([
      supabase.from("wallets").select("address, active, management_status"),
      supabase
        .from("wallet_performance")
        .select("wallet_address, completed_trades, realized_pnl_sol, profit_factor, trust_score"),
    ]);

  if (walletError) throw new Error(`Failed to load wallets: ${walletError.message}`);
  if (perfError) throw new Error(`Failed to load wallet performance: ${perfError.message}`);

  const walletMap = new Map((wallets ?? []).map((row: WalletRow) => [row.address, row]));
  const promoted: string[] = [];
  const disabled: string[] = [];
  const now = new Date().toISOString();

  for (const row of (performance ?? []) as PerformanceRow[]) {
    const wallet = walletMap.get(row.wallet_address);
    if (!wallet || wallet.management_status === "disabled") continue;

    const trades = n(row.completed_trades);
    const pnl = n(row.realized_pnl_sol);
    const trust = n(row.trust_score, 50);
    const profitFactor = row.profit_factor === null ? null : n(row.profit_factor);

    const shouldDisable =
      trades >= MIN_TRADES_TO_DISABLE &&
      pnl < 0 &&
      profitFactor !== null &&
      profitFactor < MAX_PROFIT_FACTOR_TO_DISABLE;

    if (shouldDisable) {
      const reason =
        `Auto-disabled after ${trades} completed trades: ` +
        `${pnl.toFixed(4)} SOL PnL, PF ${profitFactor.toFixed(3)}, trust ${trust.toFixed(1)}`;

      const { error } = await supabase
        .from("wallets")
        .update({
          active: false,
          management_status: "disabled",
          auto_disabled_at: now,
          auto_disable_reason: reason,
          management_updated_at: now,
        })
        .eq("address", row.wallet_address)
        .neq("management_status", "disabled");

      if (error) {
        console.error(`[wallet-intelligence] Failed to disable ${row.wallet_address}:`, error);
      } else {
        disabled.push(row.wallet_address);
      }
      continue;
    }

    const shouldPromote =
      wallet.management_status === "trial" &&
      wallet.active &&
      trades >= MIN_TRADES_TO_PROMOTE &&
      pnl > 0 &&
      trust >= MIN_TRUST_TO_PROMOTE &&
      (profitFactor === null || profitFactor >= MIN_PROFIT_FACTOR_TO_PROMOTE);

    if (shouldPromote) {
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

export function startWalletIntelligenceScheduler(): void {
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
      `promote after ${MIN_TRADES_TO_PROMOTE}+ trades; ` +
      `disable only after ${MIN_TRADES_TO_DISABLE}+ trades`
  );
}
