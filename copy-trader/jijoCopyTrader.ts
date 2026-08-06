import { randomUUID } from "node:crypto";
import type { ConfirmedSignatureInfo, ParsedTransactionWithMeta } from "@solana/web3.js";
import { getSupabaseAdmin } from "../lib/supabase";
import { sendTelegramAlert } from "../lib/telegram";
import {
  executeJupiterBuy,
  executeJupiterSell,
  getLiveConnection,
  getWalletSolLamports,
  getWalletTokenRawAmount,
} from "../lib/liveWallet";
import { evaluateLiveEntrySafety } from "../live-executor/liveSafety";

export const JIJO_COPY_VERSION = "jijo_copy_v1_2026_08_06";
export const DEFAULT_JIJO_WALLET =
  "4BdKaxN8G6ka4GYtQQWk4G4dZRUTX2vQH9GcXdBREFUk";

const LAMPORTS_PER_SOL = 1_000_000_000;
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const POLL_MS = Math.max(1_500, Number(process.env.JIJO_COPY_POLL_MS) || 3_000);
const MAX_SIGNATURE_PAGES = Math.max(
  1,
  Math.min(10, Number(process.env.JIJO_COPY_MAX_SIGNATURE_PAGES) || 5)
);
const SIGNATURES_PER_PAGE = 100;
const MIN_COPY_BUY_SOL = Math.max(
  0.001,
  Number(process.env.JIJO_COPY_MIN_BUY_SOL) || 0.002
);
const CATASTROPHIC_COPY_LOSS_PCT = Math.min(
  -10,
  Number(process.env.JIJO_COPY_CATASTROPHIC_LOSS_PCT) || -50
);

type CopyState = {
  id: number;
  version: string;
  target_wallet: string;
  enabled: boolean;
  execution_mode: "observe" | "live";
  halted: boolean;
  halt_reason: string;
  copy_ratio: string | number;
  max_position_sol: string | number;
  max_open_positions: number;
  max_daily_entries: number;
  max_daily_loss_sol: string | number;
  max_slippage_bps: number;
  min_wallet_reserve_sol: string | number;
  max_source_age_ms: number;
  last_signature: string | null;
  last_seen_at: string | null;
  daily_date: string;
  daily_entries: number;
  daily_realized_pnl_sol: string | number;
  signer_verified_events: string | number;
  ignored_events: string | number;
  blocked_events: string | number;
  confirmed_buys: string | number;
  confirmed_sells: string | number;
  executing: boolean;
};

type TokenChange = {
  mint: string;
  pre: bigint;
  post: bigint;
  delta: bigint;
};

type SignedTrade = {
  signature: string;
  slot: number;
  blockTime: string;
  sourceAgeMs: number;
  mint: string;
  side: "buy" | "sell";
  solDelta: number;
  tokenPre: bigint;
  tokenPost: bigint;
  tokenDelta: bigint;
  sellFraction: number | null;
};

type CopyPosition = {
  id: string;
  mint: string;
  token_symbol: string | null;
  token_amount: string;
  spent_sol: string | number;
  realized_pnl_sol: string | number;
  status: string;
};

const supabase = getSupabaseAdmin();
let cycleRunning = false;
let startupAlertSent = false;

function n(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function clean(value: string | undefined): string {
  return (value ?? "").trim().replace(/^["']|["']$/g, "").trim();
}

function runtimeArmed(): boolean {
  return (
    clean(process.env.JIJO_COPY_LIVE_ARMED).toLowerCase() === "true" &&
    clean(process.env.LIVE_TRADING_ENABLED).toLowerCase() === "true" &&
    clean(process.env.LIVE_EXECUTION_ARMED).toLowerCase() === "true"
  );
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function txLink(signature: string): string {
  return `https://solscan.io/tx/${encodeURIComponent(signature)}`;
}

function tokenLink(mint: string): string {
  return `https://dexscreener.com/solana/${encodeURIComponent(mint)}`;
}

async function notify(message: string, forceOperational = false): Promise<void> {
  await sendTelegramAlert(message, { forceOperational });
}

async function loadState(): Promise<CopyState> {
  const { data, error } = await supabase
    .from("jijo_copy_state")
    .select("*")
    .eq("id", 1)
    .single();
  if (error) throw new Error(`jijo_copy_state:${error.message}`);

  const state = data as CopyState;
  if (state.daily_date !== utcDate()) {
    const now = new Date().toISOString();
    const { data: reset, error: resetError } = await supabase
      .from("jijo_copy_state")
      .update({
        daily_date: utcDate(),
        daily_entries: 0,
        daily_realized_pnl_sol: 0,
        updated_at: now,
      })
      .eq("id", 1)
      .select("*")
      .single();
    if (resetError) throw new Error(`jijo_copy_daily_reset:${resetError.message}`);
    return reset as CopyState;
  }
  return state;
}

async function heartbeat(reason?: string): Promise<void> {
  const now = new Date().toISOString();
  await supabase
    .from("jijo_copy_state")
    .update({
      last_heartbeat_at: now,
      updated_at: now,
      ...(reason ? { halt_reason: reason } : {}),
    })
    .eq("id", 1);
}

async function setCursor(signature: string, seenAt?: string): Promise<void> {
  await supabase
    .from("jijo_copy_state")
    .update({
      last_signature: signature,
      last_seen_at: seenAt ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);
}

async function incrementState(
  state: CopyState,
  patch: Partial<Record<keyof CopyState, unknown>>
): Promise<void> {
  await supabase
    .from("jijo_copy_state")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", 1);
}

function accountKey(
  tx: ParsedTransactionWithMeta,
  index: number
): { pubkey: string; signer: boolean } | null {
  const key: any = (tx.transaction.message.accountKeys as any[])[index];
  if (!key) return null;
  if (typeof key === "string") return { pubkey: key, signer: false };
  return {
    pubkey:
      typeof key.pubkey === "string"
        ? key.pubkey
        : key.pubkey?.toBase58?.() ?? String(key.pubkey),
    signer: Boolean(key.signer),
  };
}

function ownerTokenMap(
  rows: readonly any[] | null | undefined,
  owner: string
): Map<string, bigint> {
  const result = new Map<string, bigint>();
  for (const row of rows ?? []) {
    if (String(row.owner ?? "") !== owner) continue;
    const mint = String(row.mint ?? "");
    const amount = String(row.uiTokenAmount?.amount ?? "0");
    if (!mint) continue;
    result.set(mint, (result.get(mint) ?? 0n) + BigInt(amount));
  }
  return result;
}

function tokenChanges(
  tx: ParsedTransactionWithMeta,
  owner: string
): TokenChange[] {
  const pre = ownerTokenMap(tx.meta?.preTokenBalances as any[], owner);
  const post = ownerTokenMap(tx.meta?.postTokenBalances as any[], owner);
  const mints = new Set([...pre.keys(), ...post.keys()]);
  return [...mints]
    .map((mint) => {
      const before = pre.get(mint) ?? 0n;
      const after = post.get(mint) ?? 0n;
      return { mint, pre: before, post: after, delta: after - before };
    })
    .filter(
      (row) =>
        row.delta !== 0n &&
        row.mint !== SOL_MINT &&
        row.mint !== USDC_MINT &&
        row.mint !== USDT_MINT
    );
}

function absoluteBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function largestChange(changes: TokenChange[]): TokenChange | null {
  return changes.reduce<TokenChange | null>((best, current) => {
    if (!best) return current;
    return absoluteBigInt(current.delta) > absoluteBigInt(best.delta)
      ? current
      : best;
  }, null);
}

function parseSignedTrade(
  info: ConfirmedSignatureInfo,
  tx: ParsedTransactionWithMeta,
  targetWallet: string
): SignedTrade | null {
  if (tx.meta?.err) return null;

  const keys = tx.transaction.message.accountKeys as any[];
  const targetIndex = keys.findIndex((_: any, index: number) => {
    const key = accountKey(tx, index);
    return key?.pubkey === targetWallet;
  });
  if (targetIndex < 0) return null;

  const targetKey = accountKey(tx, targetIndex);
  if (!targetKey?.signer) return null;

  const preSol = tx.meta?.preBalances?.[targetIndex];
  const postSol = tx.meta?.postBalances?.[targetIndex];
  if (typeof preSol !== "number" || typeof postSol !== "number") return null;
  const solDelta = (postSol - preSol) / LAMPORTS_PER_SOL;
  const changes = tokenChanges(tx, targetWallet);

  const direction =
    solDelta < 0
      ? changes.filter((change) => change.delta > 0n)
      : solDelta > 0
        ? changes.filter((change) => change.delta < 0n)
        : [];
  const token = largestChange(direction);
  if (!token) return null;

  const side: "buy" | "sell" = token.delta > 0n ? "buy" : "sell";
  const sellFraction =
    side === "sell" && token.pre > 0n
      ? Math.min(
          1,
          Number((absoluteBigInt(token.delta) * 1_000_000n) / token.pre) /
            1_000_000
        )
      : null;
  const blockSeconds = tx.blockTime ?? info.blockTime ?? null;
  if (!blockSeconds) return null;
  const blockTime = new Date(blockSeconds * 1000).toISOString();

  return {
    signature: info.signature,
    slot: info.slot,
    blockTime,
    sourceAgeMs: Math.max(0, Date.now() - blockSeconds * 1000),
    mint: token.mint,
    side,
    solDelta,
    tokenPre: token.pre,
    tokenPost: token.post,
    tokenDelta: token.delta,
    sellFraction,
  };
}

async function signaturesSince(
  targetWallet: string,
  lastSignature: string | null
): Promise<ConfirmedSignatureInfo[]> {
  const connection = getLiveConnection();
  const target = new (await import("@solana/web3.js")).PublicKey(targetWallet);
  const collected: ConfirmedSignatureInfo[] = [];
  let before: string | undefined;
  let foundCursor = false;

  for (let page = 0; page < MAX_SIGNATURE_PAGES; page += 1) {
    const batch = await connection.getSignaturesForAddress(
      target,
      { limit: SIGNATURES_PER_PAGE, ...(before ? { before } : {}) },
      "confirmed"
    );
    if (batch.length === 0) break;

    for (const item of batch) {
      if (lastSignature && item.signature === lastSignature) {
        foundCursor = true;
        break;
      }
      collected.push(item);
    }
    if (foundCursor || batch.length < SIGNATURES_PER_PAGE) break;
    before = batch[batch.length - 1]?.signature;
  }

  if (
    lastSignature &&
    !foundCursor &&
    collected.length >= MAX_SIGNATURE_PAGES * SIGNATURES_PER_PAGE
  ) {
    console.warn(
      `[jijo-copy] cursor not found inside ${collected.length} address events; processing bounded newest window`
    );
  }
  return collected.reverse();
}

async function createEvent(trade: SignedTrade): Promise<string | null> {
  const id = randomUUID();
  const { data, error } = await supabase
    .from("jijo_copy_events")
    .insert({
      id,
      signature: trade.signature,
      slot: trade.slot,
      block_time: trade.blockTime,
      signer_verified: true,
      mint: trade.mint,
      side: trade.side,
      target_sol_delta: trade.solDelta,
      target_token_delta: trade.tokenDelta.toString(),
      target_token_pre_amount: trade.tokenPre.toString(),
      target_token_post_amount: trade.tokenPost.toString(),
      target_sell_fraction: trade.sellFraction,
      source_age_ms: trade.sourceAgeMs,
      status: "detected",
      raw_summary: {
        version: JIJO_COPY_VERSION,
        signer: DEFAULT_JIJO_WALLET,
      },
      updated_at: new Date().toISOString(),
    })
    .select("id")
    .maybeSingle();

  if (error) {
    if (error.code === "23505") return null;
    throw new Error(`jijo_event_insert:${error.message}`);
  }
  return data?.id ?? id;
}

async function eventUpdate(
  eventId: string,
  patch: Record<string, unknown>
): Promise<void> {
  const { error } = await supabase
    .from("jijo_copy_events")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", eventId);
  if (error) throw new Error(`jijo_event_update:${error.message}`);
}

async function openPositions(): Promise<CopyPosition[]> {
  const { data, error } = await supabase
    .from("jijo_copy_positions")
    .select("*")
    .in("status", ["open", "closing", "reconciliation_required"])
    .order("opened_at", { ascending: true });
  if (error) throw new Error(`jijo_positions:${error.message}`);
  return (data ?? []) as CopyPosition[];
}

async function positionForMint(mint: string): Promise<CopyPosition | null> {
  const { data, error } = await supabase
    .from("jijo_copy_positions")
    .select("*")
    .eq("mint", mint)
    .in("status", ["open", "closing", "reconciliation_required"])
    .order("opened_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`jijo_position:${error.message}`);
  return (data as CopyPosition | null) ?? null;
}

async function activeLegacyExecutor(): Promise<boolean> {
  const { data, error } = await supabase
    .from("live_executor_state")
    .select("enabled,halted")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw new Error(`live_executor_state:${error.message}`);
  return Boolean(data?.enabled && !data?.halted);
}

async function claimExecution(eventId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("jijo_copy_state")
    .update({
      executing: true,
      active_event_id: eventId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1)
    .eq("executing", false)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`jijo_claim:${error.message}`);
  return Boolean(data?.id);
}

async function releaseExecution(): Promise<void> {
  await supabase
    .from("jijo_copy_state")
    .update({
      executing: false,
      active_event_id: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);
}

async function blockEvent(
  eventId: string,
  state: CopyState,
  reason: string,
  safetySnapshot: Record<string, unknown> = {}
): Promise<void> {
  await eventUpdate(eventId, {
    status: "blocked",
    reason,
    safety_snapshot: safetySnapshot,
  });
  await incrementState(state, {
    blocked_events: n(state.blocked_events) + 1,
  });
  await notify(
    [
      "🛡️ <b>JIJO COPY TRADE BLOCKED</b>",
      "",
      `Reason: <code>${escapeHtml(reason)}</code>`,
      "No SOL was used.",
    ].join("\n"),
    true
  );
}

async function observeEvent(
  eventId: string,
  trade: SignedTrade,
  reason: string
): Promise<void> {
  await eventUpdate(eventId, { status: "observed", reason });
  await notify(
    [
      trade.side === "buy"
        ? "🟡 <b>JIJO SIGNED BUY DETECTED</b>"
        : "🟡 <b>JIJO SIGNED SELL DETECTED</b>",
      "",
      `Mint: <code>${escapeHtml(trade.mint)}</code>`,
      trade.side === "buy"
        ? `Jijo spent: <b>${Math.abs(trade.solDelta).toFixed(4)} SOL</b>`
        : `Jijo received: <b>${Math.max(0, trade.solDelta).toFixed(4)} SOL</b>`,
      trade.sellFraction !== null
        ? `Jijo sold: <b>${(trade.sellFraction * 100).toFixed(2)}%</b>`
        : "",
      `Mode: <b>live-capable but not armed</b>`,
      "",
      `<a href="${txLink(trade.signature)}">View Jijo transaction</a>`,
      `<a href="${tokenLink(trade.mint)}">Open token chart</a>`,
    ]
      .filter(Boolean)
      .join("\n"),
    true
  );
}

async function waitForTokenChange(
  mint: string,
  before: bigint,
  direction: "up" | "down"
): Promise<bigint> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const current = await getWalletTokenRawAmount(mint);
    if (
      (direction === "up" && current > before) ||
      (direction === "down" && current < before)
    ) {
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error("jijo_copy_token_balance_not_reconciled");
}

async function executeCopyBuy(
  eventId: string,
  trade: SignedTrade,
  state: CopyState
): Promise<void> {
  if (trade.sourceAgeMs > state.max_source_age_ms) {
    await blockEvent(eventId, state, "entry_window_missed_no_chase", {
      sourceAgeMs: trade.sourceAgeMs,
      maximumAgeMs: state.max_source_age_ms,
    });
    return;
  }
  if (state.daily_entries >= state.max_daily_entries) {
    await blockEvent(eventId, state, "daily_entry_limit");
    return;
  }
  if (n(state.daily_realized_pnl_sol) <= -n(state.max_daily_loss_sol)) {
    await blockEvent(eventId, state, "daily_loss_limit");
    return;
  }
  if (await activeLegacyExecutor()) {
    await blockEvent(eventId, state, "shared_wallet_legacy_executor_active");
    return;
  }

  const positions = await openPositions();
  const existing = positions.find(
    (position) => position.mint === trade.mint && position.status === "open"
  );
  if (!existing && positions.length >= state.max_open_positions) {
    await blockEvent(eventId, state, "max_open_positions");
    return;
  }

  const targetSpentSol = Math.abs(trade.solDelta);
  const scaled = targetSpentSol * n(state.copy_ratio);
  const remainingCapacity = Math.max(
    0,
    n(state.max_position_sol) - n(existing?.spent_sol)
  );
  const sizeSol = Math.min(scaled, remainingCapacity, n(state.max_position_sol));
  if (!Number.isFinite(sizeSol) || sizeSol < MIN_COPY_BUY_SOL) {
    await blockEvent(eventId, state, "scaled_buy_below_minimum", {
      targetSpentSol,
      copyRatio: n(state.copy_ratio),
      scaledSizeSol: scaled,
      minimumSizeSol: MIN_COPY_BUY_SOL,
      remainingCapacity,
    });
    return;
  }

  const walletBefore = await getWalletSolLamports();
  const reserveLamports = Math.ceil(n(state.min_wallet_reserve_sol) * LAMPORTS_PER_SOL);
  if (walletBefore - Math.ceil(sizeSol * LAMPORTS_PER_SOL) < reserveLamports) {
    await blockEvent(eventId, state, "wallet_reserve");
    return;
  }

  const safety = await evaluateLiveEntrySafety({
    mint: trade.mint,
    sizeSol,
    slippageBps: state.max_slippage_bps,
    expectedTokenAmount: null,
  });
  if (!safety.passed) {
    await blockEvent(
      eventId,
      state,
      safety.reason || "live_safety_rejected",
      safety.details
    );
    return;
  }

  const tokenBefore = await getWalletTokenRawAmount(trade.mint);
  await eventUpdate(eventId, {
    status: "submitted",
    our_requested_sol: sizeSol,
    safety_snapshot: safety.details,
  });

  try {
    const result = await executeJupiterBuy({
      outputMint: trade.mint,
      lamports: Math.floor(sizeSol * LAMPORTS_PER_SOL),
      slippageBps: state.max_slippage_bps,
    });
    const tokenAfter = await waitForTokenChange(trade.mint, tokenBefore, "up");
    const walletAfter = await getWalletSolLamports();
    const received = tokenAfter - tokenBefore;
    const spentSol = Math.max(0, walletBefore - walletAfter) / LAMPORTS_PER_SOL;
    if (received <= 0n || spentSol <= 0) {
      throw new Error("jijo_copy_buy_reconciliation_invalid");
    }

    const now = new Date().toISOString();
    if (existing) {
      const { error } = await supabase
        .from("jijo_copy_positions")
        .update({
          token_amount: (BigInt(existing.token_amount) + received).toString(),
          spent_sol: n(existing.spent_sol) + spentSol,
          last_target_signature: trade.signature,
          last_copy_tx_signature: result.signature,
          updated_at: now,
        })
        .eq("id", existing.id)
        .eq("status", "open");
      if (error) throw new Error(`jijo_position_scale_in:${error.message}`);
    } else {
      const { error } = await supabase.from("jijo_copy_positions").insert({
        id: randomUUID(),
        mint: trade.mint,
        token_amount: received.toString(),
        spent_sol: spentSol,
        target_entry_signature: trade.signature,
        entry_tx_signature: result.signature,
        last_target_signature: trade.signature,
        last_copy_tx_signature: result.signature,
        status: "open",
        opened_at: now,
        updated_at: now,
      });
      if (error) throw new Error(`jijo_position_open:${error.message}`);
    }

    await eventUpdate(eventId, {
      status: "confirmed",
      our_actual_sol_delta: -spentSol,
      our_actual_token_delta: received.toString(),
      our_tx_signature: result.signature,
      reason: null,
    });
    await incrementState(state, {
      daily_entries: state.daily_entries + 1,
      confirmed_buys: n(state.confirmed_buys) + 1,
      halt_reason: null,
    });

    await notify(
      [
        "🟢 <b>JIJO COPY — REAL MONEY TRADE OPENED</b>",
        "",
        `Mint: <code>${escapeHtml(trade.mint)}</code>`,
        `Jijo spent: <b>${targetSpentSol.toFixed(4)} SOL</b>`,
        `Copy ratio: <b>${(n(state.copy_ratio) * 100).toFixed(3)}%</b>`,
        `Our spend: <b>${spentSol.toFixed(6)} SOL</b>`,
        `Slippage limit: <b>${state.max_slippage_bps / 100}%</b>`,
        "",
        `<a href="${txLink(result.signature)}">Our confirmed transaction</a>`,
        `<a href="${txLink(trade.signature)}">Jijo source transaction</a>`,
        `<a href="${tokenLink(trade.mint)}">Open token chart</a>`,
      ].join("\n")
    );
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    await eventUpdate(eventId, { status: "failed", reason });
    await incrementState(state, {
      halted: true,
      halt_reason: `buy_failed:${reason}`,
    });
    await notify(
      [
        "🚨 <b>JIJO COPY REAL BUY FAILED</b>",
        "",
        `Mint: <code>${escapeHtml(trade.mint)}</code>`,
        `Reason: <code>${escapeHtml(reason)}</code>`,
        "",
        "🛑 Jijo copier halted automatically.",
      ].join("\n"),
      true
    );
    throw cause;
  }
}

function proportionalAmount(total: bigint, fraction: number): bigint {
  const millionths = Math.max(1, Math.min(1_000_000, Math.round(fraction * 1_000_000)));
  return (total * BigInt(millionths)) / 1_000_000n;
}

async function executeCopySell(
  eventId: string,
  trade: SignedTrade,
  state: CopyState
): Promise<void> {
  const position = await positionForMint(trade.mint);
  if (!position || position.status !== "open") {
    await eventUpdate(eventId, {
      status: "ignored",
      reason: "no_open_copy_position",
    });
    await incrementState(state, {
      ignored_events: n(state.ignored_events) + 1,
    });
    return;
  }
  if (await activeLegacyExecutor()) {
    await blockEvent(eventId, state, "shared_wallet_legacy_executor_active");
    return;
  }

  const stored = BigInt(position.token_amount);
  const walletAmount = await getWalletTokenRawAmount(trade.mint);
  const available = walletAmount < stored ? walletAmount : stored;
  const targetSoldAll = trade.tokenPost === 0n || (trade.sellFraction ?? 0) >= 0.999999;
  const requested = targetSoldAll
    ? available
    : proportionalAmount(available, trade.sellFraction ?? 1);
  const sellAmount = requested > 0n ? requested : available;
  if (sellAmount <= 0n) {
    throw new Error("jijo_copy_sell_no_tokens_available");
  }

  const tokenBefore = walletAmount;
  const solBefore = await getWalletSolLamports();
  await supabase
    .from("jijo_copy_positions")
    .update({ status: "closing", updated_at: new Date().toISOString() })
    .eq("id", position.id)
    .eq("status", "open");
  await eventUpdate(eventId, {
    status: "submitted",
    our_requested_token_amount: sellAmount.toString(),
  });

  try {
    const result = await executeJupiterSell({
      inputMint: trade.mint,
      rawTokenAmount: sellAmount.toString(),
      slippageBps: state.max_slippage_bps,
    });
    const tokenAfter = await waitForTokenChange(trade.mint, tokenBefore, "down");
    const solAfter = await getWalletSolLamports();
    const sold = tokenBefore - tokenAfter;
    const proceedsSol = Math.max(0, solAfter - solBefore) / LAMPORTS_PER_SOL;
    if (sold <= 0n || proceedsSol <= 0) {
      throw new Error("jijo_copy_sell_reconciliation_invalid");
    }

    const basisFraction =
      stored > 0n
        ? Number((sold * 1_000_000n) / stored) / 1_000_000
        : 1;
    const costBasis = n(position.spent_sol) * Math.min(1, basisFraction);
    const pnlSol = proceedsSol - costBasis;
    const pnlPct = costBasis > 0 ? (pnlSol / costBasis) * 100 : 0;
    const remainingTokens = stored > sold ? stored - sold : 0n;
    const remainingCost = Math.max(0, n(position.spent_sol) - costBasis);
    const closed = targetSoldAll || remainingTokens === 0n;
    const now = new Date().toISOString();

    const { error } = await supabase
      .from("jijo_copy_positions")
      .update({
        token_amount: remainingTokens.toString(),
        spent_sol: remainingCost,
        realized_pnl_sol: n(position.realized_pnl_sol) + pnlSol,
        last_target_signature: trade.signature,
        last_copy_tx_signature: result.signature,
        status: closed ? "closed" : "open",
        closed_at: closed ? now : null,
        updated_at: now,
      })
      .eq("id", position.id);
    if (error) throw new Error(`jijo_position_close:${error.message}`);

    await eventUpdate(eventId, {
      status: "confirmed",
      our_actual_sol_delta: proceedsSol,
      our_actual_token_delta: (-sold).toString(),
      our_tx_signature: result.signature,
      realized_pnl_sol: pnlSol,
      reason: null,
    });

    const dailyPnl = n(state.daily_realized_pnl_sol) + pnlSol;
    const catastrophic = pnlPct <= CATASTROPHIC_COPY_LOSS_PCT;
    const dailyLimitHit = dailyPnl <= -n(state.max_daily_loss_sol);
    await incrementState(state, {
      daily_realized_pnl_sol: dailyPnl,
      confirmed_sells: n(state.confirmed_sells) + 1,
      ...(catastrophic || dailyLimitHit
        ? {
            enabled: false,
            halted: true,
            halt_reason: catastrophic
              ? `catastrophic_copy_loss:${pnlPct.toFixed(2)}pct`
              : "daily_loss_limit",
          }
        : { halt_reason: null }),
    });

    await notify(
      [
        pnlSol >= 0
          ? "🟢 <b>JIJO COPY — REAL MONEY TRADE CLOSED</b>"
          : "🔴 <b>JIJO COPY — REAL MONEY TRADE CLOSED</b>",
        "",
        `Mint: <code>${escapeHtml(trade.mint)}</code>`,
        `Jijo sold: <b>${((trade.sellFraction ?? 1) * 100).toFixed(2)}%</b>`,
        `Our tokens sold: <b>${sold.toString()}</b>`,
        `Returned: <b>${proceedsSol.toFixed(6)} SOL</b>`,
        `Realized PnL: <b>${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(6)} SOL (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)</b>`,
        closed ? "Position: <b>closed</b>" : "Position: <b>partially open</b>",
        catastrophic || dailyLimitHit
          ? "🛑 <b>COPIER DISABLED — MANUAL REVIEW REQUIRED</b>"
          : "",
        "",
        `<a href="${txLink(result.signature)}">Our confirmed transaction</a>`,
        `<a href="${txLink(trade.signature)}">Jijo source transaction</a>`,
      ]
        .filter(Boolean)
        .join("\n")
    );
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    await eventUpdate(eventId, { status: "failed", reason });
    await supabase
      .from("jijo_copy_positions")
      .update({
        status: "reconciliation_required",
        updated_at: new Date().toISOString(),
      })
      .eq("id", position.id);
    await incrementState(state, {
      halted: true,
      halt_reason: `sell_failed:${reason}`,
    });
    await notify(
      [
        "🚨 <b>JIJO COPY REAL SELL FAILED</b>",
        "",
        `Mint: <code>${escapeHtml(trade.mint)}</code>`,
        `Reason: <code>${escapeHtml(reason)}</code>`,
        "",
        "🛑 Copier halted; wallet reconciliation is required.",
      ].join("\n"),
      true
    );
    throw cause;
  }
}

async function handleSignedTrade(
  trade: SignedTrade,
  state: CopyState
): Promise<void> {
  const eventId = await createEvent(trade);
  if (!eventId) return;

  await incrementState(state, {
    signer_verified_events: n(state.signer_verified_events) + 1,
  });

  if (
    !state.enabled ||
    state.halted ||
    state.execution_mode !== "live" ||
    !runtimeArmed()
  ) {
    await observeEvent(
      eventId,
      trade,
      !state.enabled
        ? "copier_disabled"
        : state.halted
          ? state.halt_reason || "copier_halted"
          : state.execution_mode !== "live"
            ? "observe_mode"
            : "live_runtime_not_armed"
    );
    return;
  }

  if (!(await claimExecution(eventId))) {
    await eventUpdate(eventId, {
      status: "ignored",
      reason: "another_copy_trade_is_executing",
    });
    return;
  }

  try {
    if (trade.side === "buy") await executeCopyBuy(eventId, trade, state);
    else await executeCopySell(eventId, trade, state);
  } finally {
    await releaseExecution();
  }
}

async function processOnce(): Promise<void> {
  if (cycleRunning) return;
  cycleRunning = true;
  try {
    const state = await loadState();
    await heartbeat(
      runtimeArmed() ? state.halt_reason || undefined : "live_runtime_not_armed"
    );

    const signatures = await signaturesSince(
      state.target_wallet,
      state.last_signature
    );
    if (!state.last_signature) {
      const newest = signatures[signatures.length - 1];
      if (newest) await setCursor(newest.signature);
      if (!startupAlertSent) {
        startupAlertSent = true;
        await notify(
          [
            "✅ <b>JIJO COPY WATCHER ONLINE</b>",
            "",
            `Wallet: <code>${escapeHtml(state.target_wallet)}</code>`,
            `Mode: <b>${state.execution_mode}</b>`,
            `Enabled: <b>${state.enabled}</b>`,
            `Real-money runtime armed: <b>${runtimeArmed()}</b>`,
            "",
            "Only transactions actually signed by Jijo can trigger the copier.",
            "Historical trades were not replayed.",
          ].join("\n"),
          true
        );
      }
      return;
    }

    const connection = getLiveConnection();
    for (const info of signatures) {
      if (info.err) {
        await setCursor(
          info.signature,
          info.blockTime
            ? new Date(info.blockTime * 1000).toISOString()
            : undefined
        );
        continue;
      }

      const tx = await connection.getParsedTransaction(info.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) {
        console.warn(`[jijo-copy] transaction unavailable; will retry ${info.signature}`);
        break;
      }

      const trade = parseSignedTrade(info, tx, state.target_wallet);
      if (trade) {
        await handleSignedTrade(trade, await loadState());
      }
      await setCursor(info.signature, trade?.blockTime);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[jijo-copy] cycle failed", message);
    await heartbeat(`cycle_error:${message.slice(0, 160)}`).catch(() => undefined);
  } finally {
    cycleRunning = false;
  }
}

export async function getJijoCopyStatus(): Promise<Record<string, unknown>> {
  const [stateResult, positionsResult, eventsResult] = await Promise.all([
    supabase.from("jijo_copy_state").select("*").eq("id", 1).single(),
    supabase
      .from("jijo_copy_positions")
      .select("*")
      .order("opened_at", { ascending: false })
      .limit(50),
    supabase
      .from("jijo_copy_events")
      .select("*")
      .order("detected_at", { ascending: false })
      .limit(100),
  ]);
  if (stateResult.error) throw stateResult.error;
  if (positionsResult.error) throw positionsResult.error;
  if (eventsResult.error) throw eventsResult.error;

  const events = eventsResult.data ?? [];
  const confirmed = events.filter((event: any) => event.status === "confirmed");
  const realizedPnlSol = confirmed.reduce(
    (sum: number, event: any) => sum + n(event.realized_pnl_sol),
    0
  );
  return {
    version: JIJO_COPY_VERSION,
    runtimeArmed: runtimeArmed(),
    state: stateResult.data,
    positions: positionsResult.data ?? [],
    events,
    performance: {
      detected: events.length,
      confirmed: confirmed.length,
      confirmedBuys: confirmed.filter((event: any) => event.side === "buy").length,
      confirmedSells: confirmed.filter((event: any) => event.side === "sell").length,
      realizedPnlSol,
    },
  };
}

export function startJijoCopyTrader(): void {
  console.log(
    `[jijo-copy] ${JIJO_COPY_VERSION} starting; target=${DEFAULT_JIJO_WALLET}; ` +
      `runtimeArmed=${runtimeArmed()} pollMs=${POLL_MS}`
  );
  void processOnce();
  setInterval(() => void processOnce(), POLL_MS);
}
