import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "../lib/supabase";
import { sendTelegramAlert } from "../lib/telegram";
import {
  executeJupiterSwap,
  getLiveSigner,
  getLiveWalletHealth,
  getWalletSolLamports,
  getWalletTokenRawAmount,
  SOL_MINT,
} from "../lib/liveWallet";

export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const USDT_DECIMALS = 6;
const SOL_DECIMALS = 9;
const LAMPORTS_PER_SOL = 1_000_000_000;
const USDT_ATOMIC = 1_000_000;
const POLL_MS = Math.max(2_000, Number(process.env.SOL_SPOT_AUTO_POLL_MS) || 3_000);
const LEASE_MS = Math.max(8_000, Number(process.env.SOL_SPOT_AUTO_LEASE_REFRESH_MS) || 15_000);
const LEASE_SECONDS = Math.max(20, Math.min(300, Number(process.env.SOL_SPOT_AUTO_LEASE_SECONDS) || 45));
const SOL_FEE_RESERVE = Math.max(0.02, Number(process.env.SOL_SPOT_AUTO_SOL_RESERVE) || 0.03);
const ENABLED = process.env.ENABLE_SOL_SPOT_AUTO_EXECUTOR !== "false";

type AutoState = {
  enabled: boolean;
  armed: boolean;
  status: string;
  halt_reason: string | null;
  max_position_usdt: number | string;
  bootstrap_sol_amount: number | string;
  bootstrap_pending: boolean;
  slippage_bps: number;
  max_daily_loss_usdt: number | string;
  max_consecutive_losses: number;
  daily_date: string;
  daily_entries: number;
  daily_realized_pnl_usdt: number | string;
  realized_pnl_usdt: number | string;
  consecutive_losses: number;
};

type PaperPosition = {
  position_id: string;
  entry_fill_price: number | string;
  stop_loss_price: number | string;
  take_profit_price: number | string;
  opened_at: string;
};

type AutoPosition = {
  position_id: string;
  source_paper_position_id: string | null;
  quantity_sol: number | string;
  cost_basis_usdt: number | string;
  entry_price_usdt: number | string;
  entry_signature: string | null;
  bootstrap: boolean;
  opened_at: string;
};

const supabase = getSupabaseAdmin({ noStore: true });
const workerId = `sol-spot-auto-${randomUUID()}`;
let leader = false;
let running = false;

const n = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const atomic = (amount: number, decimals: number): string =>
  String(Math.max(0, Math.floor(amount * 10 ** decimals)));

function html(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function notify(message: string): Promise<void> {
  try {
    await sendTelegramAlert(message);
  } catch (error) {
    console.error("[sol-spot-auto] telegram failed", error);
  }
}

async function patchState(patch: Record<string, unknown>): Promise<void> {
  const { error } = await supabase
    .from("sol_spot_auto_state")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", 1);
  if (error) throw new Error(error.message);
}

async function halt(reason: string, error?: unknown): Promise<void> {
  const detail = error instanceof Error ? error.message : error ? String(error) : reason;
  await patchState({
    armed: false,
    status: "halted",
    halt_reason: reason,
    last_error: detail.slice(0, 500),
  });
  await notify(`🛑 <b>SOL auto bot halted</b>\nReason: <code>${html(reason)}</code>\n${html(detail).slice(0, 500)}`);
}

async function claimLease(): Promise<void> {
  try {
    const { data, error } = await supabase.rpc("sol_spot_claim_auto_worker", {
      p_worker_id: workerId,
      p_lease_seconds: LEASE_SECONDS,
    });
    if (error) throw new Error(error.message);
    leader = data === true;
  } catch (error) {
    leader = false;
    console.error("[sol-spot-auto] lease failed", error);
  }
}

async function loadState(): Promise<AutoState> {
  const { data, error } = await supabase.from("sol_spot_auto_state").select("*").eq("id", 1).single();
  if (error) throw new Error(error.message);
  const state = data as AutoState;
  const today = new Date().toISOString().slice(0, 10);
  if (state.daily_date !== today) {
    const { data: reset, error: resetError } = await supabase
      .from("sol_spot_auto_state")
      .update({
        daily_date: today,
        daily_entries: 0,
        daily_realized_pnl_usdt: 0,
        consecutive_losses: 0,
        updated_at: new Date().toISOString(),
      })
      .eq("id", 1)
      .select("*")
      .single();
    if (resetError) throw new Error(resetError.message);
    return reset as AutoState;
  }
  return state;
}

async function loadPaperPosition(): Promise<PaperPosition | null> {
  const { data, error } = await supabase.from("sol_spot_paper_positions").select("position_id,entry_fill_price,stop_loss_price,take_profit_price,opened_at").maybeSingle();
  if (error) throw new Error(error.message);
  return (data as PaperPosition | null) ?? null;
}

async function loadAutoPosition(): Promise<AutoPosition | null> {
  const { data, error } = await supabase.from("sol_spot_auto_positions").select("*").eq("id", 1).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as AutoPosition | null) ?? null;
}

async function loadMarketPrice(): Promise<number> {
  const { data, error } = await supabase
    .from("sol_spot_paper_state")
    .select("last_market_price")
    .eq("id", 1)
    .single();
  if (error) throw new Error(error.message);
  const price = n(data?.last_market_price);
  if (price <= 0) throw new Error("SOL market price is unavailable");
  return price;
}

async function walletSnapshot() {
  const signer = getLiveSigner();
  const [solLamports, usdtRaw] = await Promise.all([
    getWalletSolLamports(),
    getWalletTokenRawAmount(USDT_MINT),
  ]);
  return {
    publicKey: signer.publicKey.toBase58(),
    solLamports,
    sol: solLamports / LAMPORTS_PER_SOL,
    usdtRaw,
    usdt: Number(usdtRaw) / USDT_ATOMIC,
  };
}

async function pendingOrderGuard(): Promise<boolean> {
  const { data, error } = await supabase
    .from("sol_spot_auto_orders")
    .select("order_id,status,created_at")
    .in("status", ["pending", "reconciliation_required"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return false;
  if (data.status === "reconciliation_required") {
    await halt("execution_reconciliation_required");
    return true;
  }
  if (Date.now() - Date.parse(data.created_at) > 90_000) {
    await supabase
      .from("sol_spot_auto_orders")
      .update({ status: "reconciliation_required", error: "executor restarted or timed out after order creation" })
      .eq("order_id", data.order_id);
    await halt("execution_reconciliation_required");
    return true;
  }
  return true;
}

async function createOrder(input: {
  side: "buy" | "sell" | "bootstrap_sell";
  sourcePaperPositionId?: string | null;
  inputMint: string;
  outputMint: string;
  inputAmountAtomic: string;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const orderId = randomUUID();
  const { error } = await supabase.from("sol_spot_auto_orders").insert({
    order_id: orderId,
    side: input.side,
    status: "pending",
    source_paper_position_id: input.sourcePaperPositionId ?? null,
    input_mint: input.inputMint,
    output_mint: input.outputMint,
    input_amount_atomic: input.inputAmountAtomic,
    metadata: input.metadata ?? {},
  });
  if (error) throw new Error(error.message);
  return orderId;
}

async function confirmOrder(orderId: string, signature: string, outputAmountAtomic: string): Promise<void> {
  const { error } = await supabase
    .from("sol_spot_auto_orders")
    .update({
      status: "confirmed",
      signature,
      output_amount_atomic: outputAmountAtomic,
      completed_at: new Date().toISOString(),
    })
    .eq("order_id", orderId);
  if (error) throw new Error(error.message);
}

async function failOrder(orderId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await supabase
    .from("sol_spot_auto_orders")
    .update({ status: "failed", error: message.slice(0, 500), completed_at: new Date().toISOString() })
    .eq("order_id", orderId);
}

async function adoptExistingSol(state: AutoState, paper: PaperPosition, marketPrice: number): Promise<void> {
  const wallet = await walletSnapshot();
  const requested = n(state.bootstrap_sol_amount);
  const available = Math.max(0, wallet.sol - SOL_FEE_RESERVE);
  const quantity = Math.min(requested, available);
  if (quantity <= 0) throw new Error("No SOL is available above the fee reserve");
  const positionId = randomUUID();
  const costBasis = quantity * marketPrice;
  const now = new Date().toISOString();
  const { error } = await supabase.from("sol_spot_auto_positions").insert({
    id: 1,
    position_id: positionId,
    source_paper_position_id: paper.position_id,
    quantity_sol: quantity,
    cost_basis_usdt: costBasis,
    entry_price_usdt: marketPrice,
    entry_signature: null,
    bootstrap: true,
    opened_at: now,
  });
  if (error) throw new Error(error.message);
  await patchState({ bootstrap_pending: false, status: "position_open", last_error: null });
  await notify([
    "🤖 <b>SOL auto bot adopted existing SOL</b>",
    `Quantity: <b>${quantity.toFixed(6)} SOL</b>`,
    `Tracking entry: <b>${marketPrice.toFixed(4)} USDT</b>`,
    "No buy swap was made. The bot will automatically sell this tracked amount when the strategy exits.",
  ].join("\n"));
}

async function bootstrapToUsdt(state: AutoState, marketPrice: number): Promise<void> {
  const wallet = await walletSnapshot();
  const requested = n(state.bootstrap_sol_amount);
  const available = Math.max(0, wallet.sol - SOL_FEE_RESERVE);
  const quantity = Math.min(requested, available);
  if (quantity <= 0) throw new Error("No SOL is available above the fee reserve");
  const rawAmount = atomic(quantity, SOL_DECIMALS);
  const orderId = await createOrder({
    side: "bootstrap_sell",
    inputMint: SOL_MINT,
    outputMint: USDT_MINT,
    inputAmountAtomic: rawAmount,
    metadata: { marketPrice, reason: "one_time_strategy_funding" },
  });
  try {
    const result = await executeJupiterSwap({
      inputMint: SOL_MINT,
      outputMint: USDT_MINT,
      rawAmount,
      slippageBps: state.slippage_bps,
    });
    const outputRaw = String(result.quote.outAmount);
    const proceeds = Number(outputRaw) / USDT_ATOMIC;
    await confirmOrder(orderId, result.signature, outputRaw);
    await patchState({
      bootstrap_pending: false,
      status: "waiting_for_entry",
      last_trade_at: new Date().toISOString(),
      last_error: null,
    });
    await notify([
      "💵 <b>SOL auto bot funded with USDT</b>",
      `Sold once: <b>${quantity.toFixed(6)} SOL</b>`,
      `Received: <b>${proceeds.toFixed(2)} USDT</b>`,
      "The bot is now waiting for a valid SOL entry and will trade automatically.",
      `<a href="https://solscan.io/tx/${encodeURIComponent(result.signature)}">View transaction</a>`,
    ].join("\n"));
  } catch (error) {
    await failOrder(orderId, error);
    throw error;
  }
}

async function openFromUsdt(state: AutoState, paper: PaperPosition, marketPrice: number): Promise<void> {
  const wallet = await walletSnapshot();
  const size = Math.min(n(state.max_position_usdt), wallet.usdt * 0.98);
  if (size < 10) {
    await patchState({ status: "awaiting_usdt", last_error: "At least 10 USDT is required" });
    return;
  }
  const rawAmount = atomic(size, USDT_DECIMALS);
  const orderId = await createOrder({
    side: "buy",
    sourcePaperPositionId: paper.position_id,
    inputMint: USDT_MINT,
    outputMint: SOL_MINT,
    inputAmountAtomic: rawAmount,
    metadata: { marketPrice, paperEntryPrice: n(paper.entry_fill_price) },
  });
  try {
    const result = await executeJupiterSwap({
      inputMint: USDT_MINT,
      outputMint: SOL_MINT,
      rawAmount,
      slippageBps: state.slippage_bps,
    });
    const inputRaw = String(result.quote.inAmount ?? rawAmount);
    const outputRaw = String(result.quote.outAmount);
    const costUsdt = Number(inputRaw) / USDT_ATOMIC;
    const quantitySol = Number(outputRaw) / LAMPORTS_PER_SOL;
    if (quantitySol <= 0 || costUsdt <= 0) throw new Error("Confirmed buy returned invalid amounts");
    await confirmOrder(orderId, result.signature, outputRaw);
    const positionId = randomUUID();
    const now = new Date().toISOString();
    const { error } = await supabase.from("sol_spot_auto_positions").insert({
      id: 1,
      position_id: positionId,
      source_paper_position_id: paper.position_id,
      quantity_sol: quantitySol,
      cost_basis_usdt: costUsdt,
      entry_price_usdt: costUsdt / quantitySol,
      entry_signature: result.signature,
      bootstrap: false,
      opened_at: now,
    });
    if (error) {
      await supabase.from("sol_spot_auto_orders").update({ status: "reconciliation_required", error: error.message }).eq("order_id", orderId);
      throw new Error(`Buy confirmed but position persistence failed: ${error.message}`);
    }
    await patchState({
      status: "position_open",
      daily_entries: state.daily_entries + 1,
      last_trade_at: now,
      last_error: null,
    });
    await notify([
      "🟢 <b>Automatic SOL BUY confirmed</b>",
      `Spent: <b>${costUsdt.toFixed(2)} USDT</b>`,
      `Received: <b>${quantitySol.toFixed(6)} SOL</b>`,
      `Actual entry: <b>${(costUsdt / quantitySol).toFixed(4)} USDT</b>`,
      `Paper stop: <b>${n(paper.stop_loss_price).toFixed(4)}</b>`,
      `Paper target: <b>${n(paper.take_profit_price).toFixed(4)}</b>`,
      `<a href="https://solscan.io/tx/${encodeURIComponent(result.signature)}">View transaction</a>`,
    ].join("\n"));
  } catch (error) {
    await failOrder(orderId, error);
    throw error;
  }
}

async function paperExitReason(sourceId: string | null): Promise<string> {
  if (!sourceId) return "strategy_exit";
  const { data } = await supabase
    .from("sol_spot_paper_trades")
    .select("exit_reason")
    .eq("position_id", sourceId)
    .order("closed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return typeof data?.exit_reason === "string" ? data.exit_reason : "strategy_exit";
}

async function closeToUsdt(state: AutoState, position: AutoPosition, exitReason: string): Promise<void> {
  const quantity = n(position.quantity_sol);
  const rawAmount = atomic(quantity, SOL_DECIMALS);
  if (BigInt(rawAmount) <= 0n) throw new Error("Tracked SOL quantity is invalid");
  const orderId = await createOrder({
    side: "sell",
    sourcePaperPositionId: position.source_paper_position_id,
    inputMint: SOL_MINT,
    outputMint: USDT_MINT,
    inputAmountAtomic: rawAmount,
    metadata: { exitReason },
  });
  try {
    const result = await executeJupiterSwap({
      inputMint: SOL_MINT,
      outputMint: USDT_MINT,
      rawAmount,
      slippageBps: state.slippage_bps,
    });
    const outputRaw = String(result.quote.outAmount);
    const proceeds = Number(outputRaw) / USDT_ATOMIC;
    const cost = n(position.cost_basis_usdt);
    const pnl = proceeds - cost;
    const returnPct = cost > 0 ? (pnl / cost) * 100 : 0;
    await confirmOrder(orderId, result.signature, outputRaw);
    const closedAt = new Date().toISOString();
    const { error: tradeError } = await supabase.from("sol_spot_auto_trades").insert({
      trade_id: randomUUID(),
      position_id: position.position_id,
      source_paper_position_id: position.source_paper_position_id,
      quantity_sol: quantity,
      cost_usdt: cost,
      proceeds_usdt: proceeds,
      pnl_usdt: pnl,
      return_pct: returnPct,
      entry_signature: position.entry_signature,
      exit_signature: result.signature,
      entry_reason: position.bootstrap ? "existing_sol_adopted" : "paper_entry_mirrored",
      exit_reason: exitReason,
      bootstrap: position.bootstrap,
      opened_at: position.opened_at,
      closed_at: closedAt,
      metadata: { execution: "automatic", venue: "jupiter", outputRaw },
    });
    if (tradeError) {
      await supabase.from("sol_spot_auto_orders").update({ status: "reconciliation_required", error: tradeError.message }).eq("order_id", orderId);
      throw new Error(`Sell confirmed but trade persistence failed: ${tradeError.message}`);
    }
    const { error: deleteError } = await supabase.from("sol_spot_auto_positions").delete().eq("id", 1);
    if (deleteError) throw new Error(deleteError.message);
    const nextLosses = pnl < 0 ? state.consecutive_losses + 1 : 0;
    const nextDaily = n(state.daily_realized_pnl_usdt) + pnl;
    await patchState({
      status: "waiting_for_entry",
      realized_pnl_usdt: n(state.realized_pnl_usdt) + pnl,
      daily_realized_pnl_usdt: nextDaily,
      consecutive_losses: nextLosses,
      last_trade_at: closedAt,
      last_error: null,
    });
    await notify([
      `${pnl >= 0 ? "✅" : "🔻"} <b>Automatic SOL SELL confirmed</b>`,
      `Received: <b>${proceeds.toFixed(2)} USDT</b>`,
      `Realized P&amp;L: <b>${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDT</b> (${returnPct.toFixed(2)}%)`,
      `Exit: <b>${html(exitReason)}</b>`,
      "Funds and profit remain in USDT for the next trade or withdrawal.",
      `<a href="https://solscan.io/tx/${encodeURIComponent(result.signature)}">View transaction</a>`,
    ].join("\n"));
  } catch (error) {
    await failOrder(orderId, error);
    throw error;
  }
}

async function processOnce(): Promise<void> {
  if (!ENABLED || !leader || running) return;
  running = true;
  try {
    const state = await loadState();
    const [health, wallet, marketPrice] = await Promise.all([
      getLiveWalletHealth(),
      walletSnapshot(),
      loadMarketPrice(),
    ]);
    await patchState({
      wallet_public_key: wallet.publicKey,
      sol_balance: wallet.sol,
      usdt_balance: wallet.usdt,
      last_market_price: marketPrice,
      last_heartbeat_at: new Date().toISOString(),
      last_error: null,
    });

    if (!state.enabled || !state.armed) {
      await patchState({ status: state.enabled ? "disarmed" : "disabled" });
      return;
    }
    if (!health.enabled || !health.armed || !health.signerConfigured || !health.rpcConfigured) {
      await patchState({
        status: "runtime_not_armed",
        last_error: "The existing live-executor wallet runtime is not enabled, armed, signed and connected",
      });
      return;
    }
    if (n(state.daily_realized_pnl_usdt) <= -Math.abs(n(state.max_daily_loss_usdt))) {
      await halt("daily_loss_limit");
      return;
    }
    if (state.consecutive_losses >= state.max_consecutive_losses) {
      await halt("consecutive_loss_limit");
      return;
    }
    if (await pendingOrderGuard()) return;

    const [paper, position] = await Promise.all([loadPaperPosition(), loadAutoPosition()]);

    if (state.bootstrap_pending && n(state.bootstrap_sol_amount) > 0 && !position) {
      if (paper) await adoptExistingSol(state, paper, marketPrice);
      else await bootstrapToUsdt(state, marketPrice);
      return;
    }

    if (!position) {
      if (!paper) {
        await patchState({ status: wallet.usdt >= 10 ? "waiting_for_entry" : "awaiting_usdt" });
        return;
      }
      await openFromUsdt(state, paper, marketPrice);
      return;
    }

    if (paper && paper.position_id === position.source_paper_position_id) {
      await patchState({ status: "position_open" });
      return;
    }

    const reason = await paperExitReason(position.source_paper_position_id);
    await closeToUsdt(state, position, reason);
  } catch (error) {
    console.error("[sol-spot-auto] cycle failed", error);
    const message = error instanceof Error ? error.message : String(error);
    if (/reconciliation|confirmed but/i.test(message)) await halt("execution_reconciliation_required", error);
    else await patchState({ status: "error", last_error: message.slice(0, 500), last_heartbeat_at: new Date().toISOString() });
  } finally {
    running = false;
  }
}

export function startSolSpotAutoExecutor(): void {
  if (!ENABLED) {
    console.log("[sol-spot-auto] disabled by ENABLE_SOL_SPOT_AUTO_EXECUTOR=false");
    return;
  }
  void claimLease();
  setInterval(() => void claimLease(), LEASE_MS);
  setInterval(() => void processOnce(), POLL_MS);
  setTimeout(() => void processOnce(), 1_000);
  console.log(`[sol-spot-auto] monitor started; worker=${workerId}; live trading remains database-gated`);
}
