import "dotenv/config";
import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "../lib/supabase";
import { executeJupiterBuy, getLiveWalletHealth } from "../lib/liveWallet";

const supabase = getSupabaseAdmin();
const POLL_MS = Math.max(5_000, Number(process.env.LIVE_EXECUTOR_POLL_MS) || 10_000);
const APPROVED_STRATEGY = "ai_discovery";
const LAMPORTS_PER_SOL = 1_000_000_000;
const MIN_WALLET_RESERVE_SOL = Math.max(0.02, Number(process.env.LIVE_MIN_WALLET_RESERVE_SOL) || 0.02);

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
  return process.env.LIVE_TRADING_ENABLED === "true" && process.env.LIVE_EXECUTION_ARMED === "true";
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
    const health = await getLiveWalletHealth();
    if (!health.publicKey || !health.signerConfigured || !health.rpcConfigured) return "existing_live_wallet_not_ready";
    if (health.error) return "wallet_health_check_failed";
    if (health.balanceSol == null || health.balanceSol - size < MIN_WALLET_RESERVE_SOL) return "wallet_reserve_limit";
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

async function claim(signal: Signal): Promise<boolean> {
  const { data, error } = await supabase.from("live_trade_signals").update({
    status: "claimed",
    claimed_at: new Date().toISOString(),
  }).eq("id", signal.id).eq("status", "pending").select("id").maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data?.id);
}

async function executeBuy(signal: Signal, state: ExecutorState): Promise<void> {
  const sizeSol = n(signal.requested_size_sol);
  const orderId = randomUUID();
  const { error: orderError } = await supabase.from("live_orders").insert({
    id: orderId,
    signal_id: signal.id,
    strategy: signal.strategy,
    mint: signal.mint,
    side: "buy",
    requested_size_sol: sizeSol,
    max_slippage_bps: signal.max_slippage_bps,
    status: "created",
  });
  if (orderError) throw new Error(orderError.message);

  try {
    await supabase.from("live_orders").update({ status: "submitted", updated_at: new Date().toISOString() }).eq("id", orderId);
    const result = await executeJupiterBuy({
      outputMint: signal.mint,
      lamports: Math.floor(sizeSol * LAMPORTS_PER_SOL),
      slippageBps: signal.max_slippage_bps,
    });
    const quote = result.quote as Record<string, unknown>;
    const now = new Date().toISOString();
    await supabase.from("live_orders").update({
      status: "confirmed",
      tx_signature: result.signature,
      quoted_input_amount: String(quote.inAmount ?? ""),
      quoted_output_amount: String(quote.outAmount ?? ""),
      quote,
      updated_at: now,
    }).eq("id", orderId);
    await supabase.from("live_positions").insert({
      id: randomUUID(),
      strategy: signal.strategy,
      source_position_id: signal.source_position_id,
      mint: signal.mint,
      token_symbol: signal.token_symbol,
      status: "reconciliation_required",
      entry_order_id: orderId,
      entry_tx_signature: result.signature,
      token_amount: String(quote.outAmount ?? "0"),
      spent_sol: sizeSol,
      opened_at: now,
      updated_at: now,
    });
    await supabase.from("live_trade_signals").update({ status: "executed", completed_at: now }).eq("id", signal.id).eq("status", "claimed");
    await supabase.from("live_executor_state").update({ daily_entries: state.daily_entries + 1, updated_at: now }).eq("id", 1);
    console.log(`[live-executor] confirmed buy ${signal.token_symbol ?? signal.mint}: ${result.signature}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown_execution_error";
    const now = new Date().toISOString();
    await supabase.from("live_orders").update({ status: "failed", error: reason, updated_at: now }).eq("id", orderId);
    await supabase.from("live_trade_signals").update({ status: "failed", rejection_reason: reason, completed_at: now }).eq("id", signal.id).eq("status", "claimed");
    throw error;
  }
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
  if (signal.side !== "buy") {
    await reject(signal, "sell_adapter_not_enabled");
    return;
  }
  if (!(await claim(signal))) return;
  await executeBuy(signal, state);
}

export function startLiveExecutor(): void {
  console.log(`[live-executor] isolated service starting; armed=${runtimeArmed()} pollMs=${POLL_MS}; wallet=reused-existing-live-wallet`);
  void processOnce().catch((error) => console.error("[live-executor] cycle failed", error));
  setInterval(() => void processOnce().catch((error) => console.error("[live-executor] cycle failed", error)), POLL_MS);
}
