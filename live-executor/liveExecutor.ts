import "dotenv/config";
import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "../lib/supabase";
import { sendTelegramAlert } from "../lib/telegram";
import {
  executeJupiterBuy,
  executeJupiterSell,
  getLiveWalletHealth,
  getWalletSolLamports,
  getWalletTokenRawAmount,
} from "../lib/liveWallet";
import { evaluateLiveEntrySafety } from "./liveSafety";
import { evaluateLiveEntryTiming } from "./liveEntryTiming";

const supabase = getSupabaseAdmin();
const VERSION = "live_executor_v2_entry_safety_2026_07_28";
const POLL_MS = Math.max(
  5_000,
  Number(process.env.LIVE_EXECUTOR_POLL_MS) || 10_000
);
const APPROVED_STRATEGY = "ai_discovery";
const LAMPORTS_PER_SOL = 1_000_000_000;
const MIN_WALLET_RESERVE_SOL = Math.max(
  0.02,
  Number(process.env.LIVE_MIN_WALLET_RESERVE_SOL) || 0.02
);
const SOURCE_ENTRY_MAX_AGE_MS = Math.max(
  10_000,
  Number(process.env.LIVE_SOURCE_ENTRY_MAX_AGE_MS) || 20_000
);
const SOURCE_ENTRY_CLOCK_SKEW_TOLERANCE_MS = 5_000;
const MAX_DUPLICATE_SYMBOL_MINTS = Math.max(
  1,
  Math.min(20, Number(process.env.LIVE_MAX_DUPLICATE_SYMBOL_MINTS) || 3)
);
const DUPLICATE_SYMBOL_LOOKBACK_HOURS = Math.max(
  1,
  Number(process.env.LIVE_DUPLICATE_SYMBOL_LOOKBACK_HOURS) || 168
);
const CATASTROPHIC_LOSS_PCT = -Math.abs(
  Number(process.env.LIVE_CATASTROPHIC_LOSS_PCT) || 20
);
let cycleRunning = false;

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

type LivePosition = {
  id: string;
  source_position_id: string;
  mint: string;
  token_symbol: string | null;
  token_amount: string;
  spent_sol: number | string;
  status: string;
};

const n = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function runtimeArmed(): boolean {
  return (
    process.env.LIVE_TRADING_ENABLED === "true" &&
    process.env.LIVE_EXECUTION_ARMED === "true"
  );
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function tokenName(signal: Signal): string {
  return escapeHtml(
    signal.token_symbol?.trim() ||
      `${signal.mint.slice(0, 6)}…${signal.mint.slice(-6)}`
  );
}

function txLink(signature: string): string {
  return `https://solscan.io/tx/${encodeURIComponent(signature)}`;
}

function exitReason(signal: Signal): string {
  const reason = signal.metadata?.exit_reason;
  return typeof reason === "string" && reason.trim()
    ? reason.trim()
    : "strategy exit";
}

async function notifyTelegram(message: string): Promise<void> {
  try {
    await sendTelegramAlert(message);
  } catch (error) {
    console.error("[live-executor] Telegram notification failed", error);
  }
}

async function heartbeat(reason?: string): Promise<void> {
  await supabase
    .from("live_executor_state")
    .update({
      last_heartbeat_at: new Date().toISOString(),
      ...(reason ? { halt_reason: reason } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);
}

async function loadState(): Promise<ExecutorState> {
  const { data, error } = await supabase
    .from("live_executor_state")
    .select("*")
    .eq("id", 1)
    .single();
  if (error) throw new Error(error.message);
  const state = data as ExecutorState;
  const today = new Date().toISOString().slice(0, 10);
  if (state.daily_date !== today) {
    const { data: reset, error: resetError } = await supabase
      .from("live_executor_state")
      .update({
        daily_date: today,
        daily_entries: 0,
        daily_realized_pnl_sol: 0,
        updated_at: new Date().toISOString(),
      })
      .eq("id", 1)
      .select("*")
      .single();
    if (resetError) throw new Error(resetError.message);
    return reset as ExecutorState;
  }
  return state;
}

async function reject(
  signal: Signal,
  reason: string,
  details?: Record<string, unknown>
): Promise<void> {
  const metadata = {
    ...(signal.metadata ?? {}),
    ...(details ? { live_safety: details } : {}),
  };
  const { error } = await supabase
    .from("live_trade_signals")
    .update({
      status: "rejected",
      rejection_reason: reason,
      metadata,
      completed_at: new Date().toISOString(),
    })
    .eq("id", signal.id)
    .eq("status", "pending");
  if (error) throw new Error(error.message);
  console.warn(`[live-executor] rejected ${signal.id}: ${reason}`);
}

async function openPositionCount(): Promise<number> {
  const { count, error } = await supabase
    .from("live_positions")
    .select("id", { count: "exact", head: true })
    .in("status", ["open", "closing", "reconciliation_required"]);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function validate(
  signal: Signal,
  state: ExecutorState
): Promise<string | null> {
  if (!runtimeArmed()) return "runtime_not_armed";
  if (!state.enabled) return "database_gate_disabled";
  if (state.halted) return state.halt_reason || "executor_halted";
  if (signal.strategy !== APPROVED_STRATEGY) return "strategy_not_approved";
  if (!signal.source_position_id) return "missing_source_position_id";
  if (!signal.mint || signal.mint.length < 32) return "invalid_mint";
  if (signal.max_slippage_bps < 10 || signal.max_slippage_bps > 200) {
    return "slippage_out_of_bounds";
  }
  if (
    n(state.daily_realized_pnl_sol) <=
    -Math.abs(n(state.max_daily_loss_sol))
  ) {
    return "daily_loss_limit";
  }

  const health = await getLiveWalletHealth();
  if (!health.publicKey || !health.signerConfigured || !health.rpcConfigured) {
    return "existing_live_wallet_not_ready";
  }
  if (health.error) return "wallet_health_check_failed";

  if (signal.side === "buy") {
    const size = n(signal.requested_size_sol);
    if (state.daily_entries >= state.max_daily_entries) {
      return "daily_entry_limit";
    }
    if (!(size > 0)) return "invalid_position_size";
    if (size > n(state.max_position_sol)) return "position_size_above_limit";
    if ((await openPositionCount()) >= state.max_open_positions) {
      return "max_open_positions";
    }
    if (
      health.balanceSol == null ||
      health.balanceSol - size < MIN_WALLET_RESERVE_SOL
    ) {
      return "wallet_reserve_limit";
    }
  } else {
    const { data } = await supabase
      .from("live_positions")
      .select("id")
      .eq("source_position_id", signal.source_position_id)
      .eq("status", "open")
      .maybeSingle();
    if (!data) return "open_live_position_not_found";
  }
  return null;
}

async function duplicateSymbolCount(signal: Signal): Promise<number> {
  const symbol = signal.token_symbol?.trim();
  if (!symbol) return 1;
  const cutoff = new Date(
    Date.now() - DUPLICATE_SYMBOL_LOOKBACK_HOURS * 60 * 60_000
  ).toISOString();
  const { data, error } = await supabase
    .from("market_opportunities")
    .select("mint")
    .ilike("token_symbol", symbol)
    .gte("last_seen_at", cutoff)
    .limit(100);
  if (error) throw new Error(error.message);
  return new Set((data ?? []).map((row: any) => String(row.mint))).size;
}

async function evaluateBuySignalSafety(
  signal: Signal
): Promise<{ reason: string | null; details: Record<string, unknown> }> {
  const duplicateMints = await duplicateSymbolCount(signal);
  if (duplicateMints > MAX_DUPLICATE_SYMBOL_MINTS) {
    return {
      reason: "duplicate_brand_cluster",
      details: {
        duplicateSymbolMints: duplicateMints,
        maximumAllowed: MAX_DUPLICATE_SYMBOL_MINTS,
      },
    };
  }

  const expectedTokenAmount =
    typeof signal.metadata?.expected_token_amount === "string"
      ? signal.metadata.expected_token_amount
      : null;
  const safety = await evaluateLiveEntrySafety({
    mint: signal.mint,
    sizeSol: n(signal.requested_size_sol),
    slippageBps: signal.max_slippage_bps,
    expectedTokenAmount,
  });
  return {
    reason: safety.passed ? null : safety.reason || "live_safety_rejected",
    details: {
      ...safety.details,
      duplicateSymbolMints: duplicateMints,
    },
  };
}

async function createSourceSignals(state: ExecutorState): Promise<void> {
  if (!runtimeArmed() || !state.enabled || state.halted) return;

  if (
    state.daily_entries < state.max_daily_entries &&
    (await openPositionCount()) < state.max_open_positions
  ) {
    const cutoff = new Date(Date.now() - SOURCE_ENTRY_MAX_AGE_MS).toISOString();
    const { data: source } = await supabase
      .from("ai_discovery_positions")
      .select(
        "position_id,mint,token_symbol,size_sol,token_amount,opened_at,entry_snapshot"
      )
      .gte("opened_at", cutoff)
      .order("opened_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (source) {
      await supabase.from("live_trade_signals").upsert(
        {
          id: randomUUID(),
          strategy: APPROVED_STRATEGY,
          source_position_id: source.position_id,
          mint: source.mint,
          token_symbol: source.token_symbol,
          side: "buy",
          requested_size_sol: Math.min(
            n(source.size_sol),
            n(state.max_position_sol)
          ),
          max_slippage_bps: Math.min(
            200,
            Math.max(10, Number(process.env.LIVE_MAX_SLIPPAGE_BPS) || 100)
          ),
          metadata: {
            source: "ai_discovery_positions",
            source_opened_at: source.opened_at,
            expected_token_amount: source.token_amount,
            entry_snapshot_version:
              (source.entry_snapshot as any)?.version ?? null,
          },
        },
        {
          onConflict: "strategy,source_position_id,side",
          ignoreDuplicates: true,
        }
      );
    }
  }

  const { data: positions } = await supabase
    .from("live_positions")
    .select(
      "id,source_position_id,mint,token_symbol,token_amount,spent_sol,status"
    )
    .eq("status", "open");

  for (const position of (positions ?? []) as LivePosition[]) {
    const { data: close } = await supabase
      .from("ai_discovery_trades")
      .select("position_id,exit_reason,closed_at")
      .eq("position_id", position.source_position_id)
      .limit(1)
      .maybeSingle();
    if (!close) continue;

    await supabase.from("live_trade_signals").upsert(
      {
        id: randomUUID(),
        strategy: APPROVED_STRATEGY,
        source_position_id: position.source_position_id,
        mint: position.mint,
        token_symbol: position.token_symbol,
        side: "sell",
        requested_token_amount: position.token_amount,
        max_slippage_bps: Math.min(
          200,
          Math.max(10, Number(process.env.LIVE_MAX_SLIPPAGE_BPS) || 100)
        ),
        metadata: {
          source: "ai_discovery_trades",
          exit_reason: close.exit_reason,
          source_closed_at: close.closed_at,
        },
      },
      {
        onConflict: "strategy,source_position_id,side",
        ignoreDuplicates: true,
      }
    );
  }
}

async function nextSignal(): Promise<Signal | null> {
  const { data, error } = await supabase
    .from("live_trade_signals")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as Signal | null;
}

async function claim(signal: Signal): Promise<boolean> {
  const { data, error } = await supabase
    .from("live_trade_signals")
    .update({ status: "claimed", claimed_at: new Date().toISOString() })
    .eq("id", signal.id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data?.id);
}

async function waitForTokenChange(
  mint: string,
  before: bigint,
  direction: "up" | "down"
): Promise<bigint> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const current = await getWalletTokenRawAmount(mint);
    if (
      (direction === "up" && current > before) ||
      (direction === "down" && current < before)
    ) {
      return current;
    }
    await sleep(2_000);
  }
  throw new Error("confirmed_transaction_token_balance_not_reconciled");
}

async function executeBuy(
  signal: Signal,
  state: ExecutorState
): Promise<void> {
  const sizeSol = n(signal.requested_size_sol);
  const orderId = randomUUID();
  const tokenBefore = await getWalletTokenRawAmount(signal.mint);
  const solBefore = await getWalletSolLamports();
  const { error } = await supabase.from("live_orders").insert({
    id: orderId,
    signal_id: signal.id,
    strategy: signal.strategy,
    mint: signal.mint,
    side: "buy",
    requested_size_sol: sizeSol,
    max_slippage_bps: signal.max_slippage_bps,
    status: "created",
  });
  if (error) throw new Error(error.message);

  try {
    await supabase
      .from("live_orders")
      .update({ status: "submitted", updated_at: new Date().toISOString() })
      .eq("id", orderId);
    const result = await executeJupiterBuy({
      outputMint: signal.mint,
      lamports: Math.floor(sizeSol * LAMPORTS_PER_SOL),
      slippageBps: signal.max_slippage_bps,
    });
    const tokenAfter = await waitForTokenChange(
      signal.mint,
      tokenBefore,
      "up"
    );
    const solAfter = await getWalletSolLamports();
    const received = tokenAfter - tokenBefore;
    const spentLamports = Math.max(0, solBefore - solAfter);
    if (received <= 0n) {
      throw new Error("buy_reconciliation_received_zero_tokens");
    }
    const spentSol = spentLamports / LAMPORTS_PER_SOL;
    const now = new Date().toISOString();
    const quote = result.quote as Record<string, unknown>;

    await supabase
      .from("live_orders")
      .update({
        status: "confirmed",
        tx_signature: result.signature,
        quoted_input_amount: String(quote.inAmount ?? ""),
        quoted_output_amount: String(quote.outAmount ?? ""),
        actual_input_amount: String(spentLamports),
        actual_output_amount: received.toString(),
        quote,
        updated_at: now,
      })
      .eq("id", orderId);
    await supabase.from("live_positions").insert({
      id: randomUUID(),
      strategy: signal.strategy,
      source_position_id: signal.source_position_id,
      mint: signal.mint,
      token_symbol: signal.token_symbol,
      status: "open",
      entry_order_id: orderId,
      entry_tx_signature: result.signature,
      token_amount: received.toString(),
      spent_sol: spentSol,
      opened_at: now,
      updated_at: now,
    });
    await supabase
      .from("live_trade_signals")
      .update({ status: "executed", completed_at: now })
      .eq("id", signal.id)
      .eq("status", "claimed");
    await supabase
      .from("live_executor_state")
      .update({ daily_entries: state.daily_entries + 1, updated_at: now })
      .eq("id", 1);

    console.log(
      `[live-executor] reconciled buy ${signal.token_symbol ?? signal.mint}: ${result.signature}`
    );
    await notifyTelegram(
      [
        "🟢 <b>REAL MONEY TRADE OPENED</b>",
        "",
        `Token: <b>${tokenName(signal)}</b>`,
        `Size: <b>${spentSol.toFixed(6)} SOL</b>`,
        `Wallet balance: <b>${(solAfter / LAMPORTS_PER_SOL).toFixed(6)} SOL</b>`,
        `Slippage limit: <b>${signal.max_slippage_bps / 100}%</b>`,
        "Safety: <b>entry gate passed</b>",
        "",
        `<a href="${txLink(result.signature)}">View confirmed transaction</a>`,
        `<a href="https://dexscreener.com/solana/${encodeURIComponent(signal.mint)}">Open token chart</a>`,
      ].join("\n")
    );
  } catch (cause) {
    const reason =
      cause instanceof Error ? cause.message : "unknown_execution_error";
    const now = new Date().toISOString();
    await supabase
      .from("live_orders")
      .update({ status: "failed", error: reason, updated_at: now })
      .eq("id", orderId);
    await supabase
      .from("live_trade_signals")
      .update({
        status: "failed",
        rejection_reason: reason,
        completed_at: now,
      })
      .eq("id", signal.id)
      .eq("status", "claimed");
    await supabase
      .from("live_executor_state")
      .update({
        halted: true,
        halt_reason: `buy_failed:${reason}`,
        updated_at: now,
      })
      .eq("id", 1);
    await notifyTelegram(
      [
        "⚠️ <b>REAL MONEY BUY FAILED</b>",
        "",
        `Token: <b>${tokenName(signal)}</b>`,
        `Requested: <b>${sizeSol.toFixed(6)} SOL</b>`,
        `Reason: <code>${escapeHtml(reason)}</code>`,
        "",
        "🛑 The real executor was halted automatically.",
      ].join("\n")
    );
    throw cause;
  }
}

async function executeSell(
  signal: Signal,
  state: ExecutorState
): Promise<void> {
  const { data, error } = await supabase
    .from("live_positions")
    .select("*")
    .eq("source_position_id", signal.source_position_id)
    .eq("status", "open")
    .single();
  if (error) throw new Error(error.message);
  const position = data as LivePosition;
  const walletAmount = await getWalletTokenRawAmount(position.mint);
  const storedAmount = BigInt(position.token_amount);
  const sellAmount = walletAmount < storedAmount ? walletAmount : storedAmount;
  if (sellAmount <= 0n) {
    throw new Error("sell_reconciliation_no_tokens_available");
  }

  const tokenBefore = walletAmount;
  const solBefore = await getWalletSolLamports();
  const orderId = randomUUID();
  await supabase
    .from("live_positions")
    .update({ status: "closing", updated_at: new Date().toISOString() })
    .eq("id", position.id)
    .eq("status", "open");
  const { error: orderError } = await supabase.from("live_orders").insert({
    id: orderId,
    signal_id: signal.id,
    strategy: signal.strategy,
    mint: signal.mint,
    side: "sell",
    requested_token_amount: sellAmount.toString(),
    max_slippage_bps: signal.max_slippage_bps,
    status: "created",
  });
  if (orderError) throw new Error(orderError.message);

  try {
    await supabase
      .from("live_orders")
      .update({ status: "submitted", updated_at: new Date().toISOString() })
      .eq("id", orderId);
    const result = await executeJupiterSell({
      inputMint: position.mint,
      rawTokenAmount: sellAmount.toString(),
      slippageBps: signal.max_slippage_bps,
    });
    const quote = result.quote as Record<string, unknown>;
    await supabase
      .from("live_orders")
      .update({
        status: "submitted",
        tx_signature: result.signature,
        quoted_input_amount: String(quote.inAmount ?? ""),
        quoted_output_amount: String(quote.outAmount ?? ""),
        quote,
        updated_at: new Date().toISOString(),
      })
      .eq("id", orderId);

    const tokenAfter = await waitForTokenChange(
      position.mint,
      tokenBefore,
      "down"
    );
    const solAfter = await getWalletSolLamports();
    const sold = tokenBefore - tokenAfter;
    const walletDeltaLamports = solAfter - solBefore;
    const quotedOutputLamports = Number(quote.outAmount ?? 0);
    const receivedLamports =
      walletDeltaLamports > 0 ? walletDeltaLamports : quotedOutputLamports;
    if (
      sold <= 0n ||
      !Number.isFinite(receivedLamports) ||
      receivedLamports <= 0
    ) {
      throw new Error("sell_reconciliation_balance_delta_invalid");
    }

    const proceedsSol = receivedLamports / LAMPORTS_PER_SOL;
    const spentSol = n(position.spent_sol);
    const pnlSol = proceedsSol - spentSol;
    const pnlPct = spentSol > 0 ? (pnlSol / spentSol) * 100 : 0;
    const now = new Date().toISOString();
    const catastrophic = pnlPct <= CATASTROPHIC_LOSS_PCT;

    await supabase
      .from("live_orders")
      .update({
        status: "confirmed",
        tx_signature: result.signature,
        quoted_input_amount: String(quote.inAmount ?? ""),
        quoted_output_amount: String(quote.outAmount ?? ""),
        actual_input_amount: sold.toString(),
        actual_output_amount: String(receivedLamports),
        quote,
        error: null,
        updated_at: now,
      })
      .eq("id", orderId);
    await supabase
      .from("live_positions")
      .update({
        status: "closed",
        exit_order_id: orderId,
        exit_tx_signature: result.signature,
        proceeds_sol: proceedsSol,
        realized_pnl_sol: pnlSol,
        closed_at: now,
        updated_at: now,
      })
      .eq("id", position.id);
    await supabase
      .from("live_trade_signals")
      .update({
        status: "executed",
        rejection_reason: null,
        completed_at: now,
      })
      .eq("id", signal.id)
      .eq("status", "claimed");
    await supabase
      .from("live_executor_state")
      .update({
        daily_realized_pnl_sol:
          n(state.daily_realized_pnl_sol) + pnlSol,
        ...(catastrophic
          ? {
              enabled: false,
              halted: true,
              halt_reason: `catastrophic_live_loss:${pnlPct.toFixed(2)}pct`,
            }
          : {}),
        updated_at: now,
      })
      .eq("id", 1);

    console.log(
      `[live-executor] reconciled sell ${signal.token_symbol ?? signal.mint}: ${result.signature}; pnl=${pnlSol.toFixed(6)} SOL`
    );
    await notifyTelegram(
      [
        pnlSol >= 0
          ? "🟢 <b>REAL MONEY TRADE CLOSED — PROFIT</b>"
          : "🔴 <b>REAL MONEY TRADE CLOSED — LOSS</b>",
        "",
        `Token: <b>${tokenName(signal)}</b>`,
        `Exit: <b>${escapeHtml(exitReason(signal))}</b>`,
        `Spent: <b>${spentSol.toFixed(6)} SOL</b>`,
        `Returned: <b>${proceedsSol.toFixed(6)} SOL</b>`,
        `Net PnL: <b>${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(6)} SOL (${pnlSol >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)</b>`,
        `Wallet balance: <b>${(solAfter / LAMPORTS_PER_SOL).toFixed(6)} SOL</b>`,
        ...(catastrophic
          ? ["", "🛑 <b>LIVE EXECUTOR DISABLED — MANUAL REVIEW REQUIRED</b>"]
          : []),
        "",
        `<a href="${txLink(result.signature)}">View confirmed transaction</a>`,
      ].join("\n")
    );
  } catch (cause) {
    const reason =
      cause instanceof Error ? cause.message : "unknown_execution_error";
    const now = new Date().toISOString();
    await supabase
      .from("live_orders")
      .update({ status: "failed", error: reason, updated_at: now })
      .eq("id", orderId);
    await supabase
      .from("live_trade_signals")
      .update({
        status: "failed",
        rejection_reason: reason,
        completed_at: now,
      })
      .eq("id", signal.id)
      .eq("status", "claimed");
    await supabase
      .from("live_positions")
      .update({ status: "reconciliation_required", updated_at: now })
      .eq("id", position.id);
    await supabase
      .from("live_executor_state")
      .update({
        halted: true,
        halt_reason: `sell_failed:${reason}`,
        updated_at: now,
      })
      .eq("id", 1);
    await notifyTelegram(
      [
        "🚨 <b>REAL MONEY SELL FAILED</b>",
        "",
        `Token: <b>${tokenName(signal)}</b>`,
        `Reason: <code>${escapeHtml(reason)}</code>`,
        "",
        "🛑 The executor was halted and the position requires reconciliation.",
      ].join("\n")
    );
    throw cause;
  }
}

async function processOnce(): Promise<void> {
  if (cycleRunning) return;
  cycleRunning = true;
  try {
    const state = await loadState();
    await heartbeat(runtimeArmed() ? undefined : "runtime_not_armed");
    await createSourceSignals(state);
    const signal = await nextSignal();
    if (!signal) return;

    const signalAgeMs = Date.now() - Date.parse(signal.created_at);
    if (!Number.isFinite(signalAgeMs) || signalAgeMs > 60_000) {
      await reject(signal, "stale_signal");
      return;
    }

    const validationRejection = await validate(signal, state);
    if (validationRejection) {
      await reject(signal, validationRejection);
      return;
    }

    if (signal.side === "buy") {
      const sourceTiming = evaluateLiveEntryTiming(
        signal,
        SOURCE_ENTRY_MAX_AGE_MS,
        Date.now(),
        SOURCE_ENTRY_CLOCK_SKEW_TOLERANCE_MS
      );
      console.log(
        `[live-executor] entry timing ${signal.token_symbol ?? signal.mint}: ` +
          `timestampField=${sourceTiming.field ?? "none"} ` +
          `sourceTimestamp=${sourceTiming.timestamp ?? "invalid"} ` +
          `sourceAgeMs=${sourceTiming.sourceAgeMs ?? "invalid"} ` +
          `rawSourceAgeMs=${sourceTiming.rawAgeMs ?? "invalid"} ` +
          `maximumAgeMs=${SOURCE_ENTRY_MAX_AGE_MS}`
      );
      if (
        !sourceTiming.valid ||
        sourceTiming.tooFarInFuture ||
        sourceTiming.expired
      ) {
        await reject(signal, "entry_window_missed_no_chase", {
          sourceTimestampField: sourceTiming.field,
          sourceTimestamp: sourceTiming.timestamp,
          sourceAgeMs: sourceTiming.sourceAgeMs,
          rawSourceAgeMs: sourceTiming.rawAgeMs,
          maximumAgeMs: SOURCE_ENTRY_MAX_AGE_MS,
          clockSkewToleranceMs: SOURCE_ENTRY_CLOCK_SKEW_TOLERANCE_MS,
        });
        return;
      }

      const safety = await evaluateBuySignalSafety(signal);
      if (safety.reason) {
        await reject(signal, safety.reason, safety.details);
        await notifyTelegram(
          [
            "🛡️ <b>REAL MONEY ENTRY BLOCKED</b>",
            "",
            `Token: <b>${tokenName(signal)}</b>`,
            `Reason: <code>${escapeHtml(safety.reason)}</code>`,
            "",
            "No SOL was used.",
          ].join("\n")
        );
        return;
      }
      console.log(
        `[live-executor] safety passed ${signal.token_symbol ?? signal.mint}: ${JSON.stringify(safety.details)}`
      );
    }

    if (!(await claim(signal))) return;
    if (signal.side === "buy") await executeBuy(signal, state);
    else await executeSell(signal, state);
  } finally {
    cycleRunning = false;
  }
}

export function startLiveExecutor(): void {
  console.log(
    `[live-executor] ${VERSION} starting; armed=${runtimeArmed()} pollMs=${POLL_MS}; ` +
      `entryWindowMs=${SOURCE_ENTRY_MAX_AGE_MS}; safety=fail_closed`
  );
  void notifyTelegram(
    [
      "✅ <b>REAL MONEY TELEGRAM ALERTS ACTIVE</b>",
      "",
      "The live executor is online with the fail-closed entry safety gate.",
      "This is a system-status message — no trade was executed.",
    ].join("\n")
  );
  void processOnce().catch((error) =>
    console.error("[live-executor] cycle failed", error)
  );
  setInterval(
    () =>
      void processOnce().catch((error) =>
        console.error("[live-executor] cycle failed", error)
      ),
    POLL_MS
  );
}
