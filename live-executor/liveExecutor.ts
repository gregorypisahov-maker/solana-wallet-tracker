import "dotenv/config";
import { getSupabaseAdmin } from "../lib/supabase";

const supabase = getSupabaseAdmin();
const POLL_MS = Math.max(5_000, Number(process.env.LIVE_EXECUTOR_POLL_MS) || 10_000);
const APPROVED_STRATEGY = "ai_discovery";

type ExecutorState = {
  enabled: boolean;
  halted: boolean;
  halt_reason: string | null;
  max_position_sol: number | string;
  max_open_positions: number;
  max_daily_entries: number;
  max_daily_loss_sol: number | string;
  daily_date: string;
  daily_entries: number;
  daily_realized_pnl_sol: number | string;
};

type Signal = {
  id: string;
  strategy: string;
  source_position_id: string | null;
  mint: string;
  token_symbol: string | null;
  side: "buy" | "sell";
  requested_size_sol: number | string | null;
  requested_token_amount: number | string | null;
  max_slippage_bps: number;
  status: string;
  created_at: string;
  metadata: Record<string, unknown> | null;
};

const n = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

function runtimeArmed(): boolean {
  return process.env.LIVE_EXECUTION_ENABLED === "true" &&
    process.env.LIVE_EXECUTION_ARM_TOKEN === "I_UNDERSTAND_REAL_SOL_IS_AT_RISK";
}

async function heartbeat(reason?: string): Promise<void> {
  await supabase.from("live_executor_state").update({
    last_heartbeat_at: new Date().toISOString(),
    ...(reason ? { halt_reason: reason } : {}),
    updated_at: new Date().toISOString(),
  }).eq("id", 1);
}

async function loadState(): Promise<ExecutorState> {
  const { data, error } = await supabase.from("live_executor_state").select("*").eq("id", 1).single();
  if (error) throw new Error(error.message);
  return data as ExecutorState;
}

async function reject(signal: Signal, reason: string): Promise<void> {
  const { error } = await supabase.from("live_trade_signals").update({
    status: "rejected",
    rejection_reason: reason,
    completed_at: new Date().toISOString(),
  }).eq("id", signal.id).eq("status", "pending");
  if (error) throw new Error(error.message);
  console.warn(`[live-executor] rejected ${signal.id}: ${reason}`);
}

async function openPositionCount(): Promise<number> {
  const { count, error } = await supabase.from("live_positions").select("id", { count: "exact", head: true }).in("status", ["open", "closing", "reconciliation_required"]);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function validate(signal: Signal, state: ExecutorState): Promise<string | null> {
  if (!runtimeArmed()) return "runtime_not_armed";
  if (!state.enabled) return "database_gate_disabled";
  if (state.halted) return state.halt_reason || "executor_halted";
  if (signal.strategy !== APPROVED_STRATEGY) return "strategy_not_approved";
  if (!signal.source_position_id) return "missing_source_position_id";
  if (!signal.mint || signal.mint.length < 32) return "invalid_mint";
  if (signal.max_slippage_bps < 10 || signal.max_slippage_bps > 200) return "slippage_out_of_bounds";
  if (state.daily_entries >= state.max_daily_entries && signal.side === "buy") return "daily_entry_limit";
  if (n(state.daily_realized_pnl_sol) <= -Math.abs(n(state.max_daily_loss_sol))) return "daily_loss_limit";
  if (signal.side === "buy") {
    const size = n(signal.requested_size_sol);
    if (!(size > 0)) return "invalid_position_size";
    if (size > n(state.max_position_sol)) return "position_size_above_limit";
    if (await openPositionCount() >= state.max_open_positions) return "max_open_positions";
  }
  return null;
}

async function nextSignal(): Promise<Signal | null> {
  const { data, error } = await supabase.from("live_trade_signals")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as Signal | null;
}

async function processOnce(): Promise<void> {
  const state = await loadState();
  await heartbeat(runtimeArmed() ? undefined : "runtime_not_armed");
  const signal = await nextSignal();
  if (!signal) return;

  const signalAgeMs = Date.now() - Date.parse(signal.created_at);
  if (!Number.isFinite(signalAgeMs) || signalAgeMs > 60_000) {
    await reject(signal, "stale_signal");
    return;
  }

  const rejection = await validate(signal, state);
  if (rejection) {
    await reject(signal, rejection);
    return;
  }

  // Deliberately fail closed until the transaction adapter is reviewed and configured.
  // The executor is isolated and ready to receive signals, but it cannot spend SOL yet.
  await reject(signal, "transaction_adapter_not_enabled");
}

export function startLiveExecutor(): void {
  console.log(`[live-executor] isolated service starting; armed=${runtimeArmed()} pollMs=${POLL_MS}`);
  void processOnce().catch((error) => console.error("[live-executor] cycle failed", error));
  setInterval(() => void processOnce().catch((error) => console.error("[live-executor] cycle failed", error)), POLL_MS);
}
