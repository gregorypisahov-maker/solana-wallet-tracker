import "dotenv/config";
import { getSupabaseAdmin } from "../lib/supabase";
import { config } from "./config";
import { calculateLiveReadiness, ReadinessPosition } from "./liveReadinessRules";
import { REGULAR_STRATEGY_VERSION } from "./strategyVersion";

const supabase = getSupabaseAdmin();
const CHECK_INTERVAL_MS = 30 * 60_000;

type ReadinessStateRow = {
  started_at: string;
  ready: boolean;
};

export async function runLiveReadinessCheck(): Promise<void> {
  const { data: state, error: stateError } = await supabase
    .from("live_readiness_state")
    .select("started_at, ready")
    .eq("id", 1)
    .single();
  if (stateError) {
    throw new Error(`live readiness state load failed: ${stateError.message}`);
  }

  const current = state as ReadinessStateRow;
  const { data: rows, error: tradeError } = await supabase
    .from("paper_trades")
    .select("id, position_id, pnl_sol, happened_at, entry_alert")
    .gte("happened_at", current.started_at)
    .order("happened_at", { ascending: true });
  if (tradeError) {
    throw new Error(`live readiness trade load failed: ${tradeError.message}`);
  }

  const grouped = new Map<string, ReadinessPosition>();
  for (const row of rows ?? []) {
    if (row.entry_alert?.strategyVersion !== REGULAR_STRATEGY_VERSION) continue;
    const positionId = row.position_id ?? `legacy_${row.id}`;
    const prior = grouped.get(positionId);
    grouped.set(positionId, {
      positionId,
      pnlSol: (prior?.pnlSol ?? 0) + Number(row.pnl_sol ?? 0),
      closedAt: row.happened_at,
    });
  }

  const result = calculateLiveReadiness({
    positions: [...grouped.values()],
    startedAt: current.started_at,
    startingBankrollSol: config.position.simulatedBankrollSol,
  });
  const now = new Date().toISOString();
  const { error: updateError } = await supabase
    .from("live_readiness_state")
    .update({
      strategy_version: REGULAR_STRATEGY_VERSION,
      ready: result.ready,
      completed_trades: result.completedTrades,
      active_days: Number(result.activeDays.toFixed(4)),
      wins: result.wins,
      losses: result.losses,
      win_rate: Number(result.winRate.toFixed(4)),
      realized_pnl_sol: Number(result.realizedPnlSol.toFixed(6)),
      profit_factor:
        result.profitFactor === null
          ? null
          : Number(result.profitFactor.toFixed(4)),
      max_drawdown_pct: Number(result.maxDrawdownPct.toFixed(6)),
      largest_winner_share: Number(result.largestWinnerShare.toFixed(6)),
      blockers: result.blockers,
      last_evaluated_at: now,
      updated_at: now,
    })
    .eq("id", 1);
  if (updateError) {
    throw new Error(`live readiness update failed: ${updateError.message}`);
  }

  console.log(
    `[live-readiness] ${result.ready ? "READY" : "NOT READY"}; ` +
      `${result.completedTrades}/100 trades; ${result.activeDays.toFixed(1)}/45 days; ` +
      `PF ${result.profitFactor?.toFixed(2) ?? "n/a"}; ` +
      `drawdown ${(result.maxDrawdownPct * 100).toFixed(1)}%`
  );
}

let running = false;

export function startLiveReadinessScheduler(): void {
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await runLiveReadinessCheck();
    } catch (error) {
      console.error("[live-readiness] check failed safely:", error);
    } finally {
      running = false;
    }
  };

  void run();
  setInterval(() => void run(), CHECK_INTERVAL_MS);
  console.log("[live-readiness] 100-trade/45-day paper gate enabled");
}
