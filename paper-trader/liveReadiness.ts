import "dotenv/config";
import { getSupabaseAdmin } from "../lib/supabase";
import { calculateLiveReadiness, ReadinessPosition } from "./liveReadinessRules";
import { SHADOW_STRATEGY_VERSION } from "./strategyVersion";

const supabase = getSupabaseAdmin();
const CHECK_INTERVAL_MS = 30 * 60_000;

type ReadinessStateRow = {
  started_at: string;
  ready: boolean;
};

export async function runLiveReadinessCheck(): Promise<void> {
  const { data: readinessState, error: stateError } = await supabase
    .from("live_readiness_state")
    .select("started_at, ready")
    .eq("id", 1)
    .single();
  if (stateError) {
    throw new Error(`live readiness state load failed: ${stateError.message}`);
  }

  const current = readinessState as ReadinessStateRow;
  const [{ data: rows, error: tradeError }, { data: shadowState, error: shadowStateError }] =
    await Promise.all([
      supabase
        .from("shadow_trades")
        .select("id, position_id, pnl_sol, happened_at")
        .gte("happened_at", current.started_at)
        .order("happened_at", { ascending: true }),
      supabase
        .from("shadow_strategy_state")
        .select("starting_bankroll_sol")
        .eq("id", 1)
        .single(),
    ]);
  if (tradeError) {
    throw new Error(`shadow readiness trade load failed: ${tradeError.message}`);
  }
  if (shadowStateError) {
    throw new Error(`shadow readiness state load failed: ${shadowStateError.message}`);
  }

  const grouped = new Map<string, ReadinessPosition>();
  for (const row of rows ?? []) {
    const positionId = row.position_id ?? `legacy_${row.id}`;
    const prior = grouped.get(positionId);
    grouped.set(positionId, {
      positionId,
      pnlSol: (prior?.pnlSol ?? 0) + Number(row.pnl_sol ?? 0),
      closedAt: row.happened_at,
    });
  }

  const startingBankrollSol = Number(shadowState?.starting_bankroll_sol ?? 0);
  if (!Number.isFinite(startingBankrollSol) || startingBankrollSol <= 0) {
    throw new Error(`invalid shadow starting bankroll: ${shadowState?.starting_bankroll_sol}`);
  }

  const result = calculateLiveReadiness({
    positions: [...grouped.values()],
    startedAt: current.started_at,
    startingBankrollSol,
  });
  const now = new Date().toISOString();
  const { error: updateError } = await supabase
    .from("live_readiness_state")
    .update({
      strategy_version: SHADOW_STRATEGY_VERSION,
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
    `[live-readiness:shadow] ${result.ready ? "READY" : "NOT READY"}; ` +
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
      console.error("[live-readiness:shadow] check failed safely:", error);
    } finally {
      running = false;
    }
  };

  void run();
  setInterval(() => void run(), CHECK_INTERVAL_MS);
  console.log("[live-readiness:shadow] 100-trade/45-day paper gate enabled");
}
