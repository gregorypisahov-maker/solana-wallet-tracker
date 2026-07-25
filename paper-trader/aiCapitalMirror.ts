import { getSupabaseAdmin } from "../lib/supabase";
import { sendTelegramAlert } from "../lib/telegram";

// Paper-only accounting mirror. It never scans, signs, swaps, or touches a wallet.
// It copies the existing AI discovery paper bot's position lifecycle at 5x size.
const supabase = getSupabaseAdmin();
const VERSION = "ai_capital_paper_mirror_v1_2026_07_25";
const FIXED_SIZE_SOL = 1;
const DAILY_LOSS_LIMIT_SOL = 0.25;
const MAX_CONSECUTIVE_LOSSES = 3;
const SYNC_INTERVAL_MS = 5_000;
let syncRunning = false;

type CapitalState = {
  enabled: boolean;
  halted: boolean;
  halt_reason: string | null;
  bankroll_sol: number | string;
  starting_bankroll_sol: number | string;
  entries_today: number;
  daily_date: string;
  daily_realized_pnl_sol: number | string;
  consecutive_losses: number;
};

type SourcePosition = {
  position_id: string;
  mint: string;
  token_symbol: string;
  pair_address: string;
  entry_price_usd: number | string;
  last_price_usd: number | string;
  peak_price_usd: number | string;
  size_sol: number | string;
  opened_at: string;
  entry_snapshot: Record<string, unknown>;
};

type CapitalPosition = SourcePosition & {
  source_position_id: string;
  source_size_sol: number | string;
};

function n(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function loadState(): Promise<CapitalState> {
  const { data, error } = await supabase.from("ai_capital_state").select("*").eq("id", 1).single();
  if (error) throw new Error(error.message);
  return data as CapitalState;
}

async function resetDay(state: CapitalState): Promise<CapitalState> {
  const today = new Date().toISOString().slice(0, 10);
  if (state.daily_date === today) return state;
  const manuallyPaused = state.halt_reason === "manual_dashboard_pause";
  const { data, error } = await supabase
    .from("ai_capital_state")
    .update({
      entries_today: 0,
      daily_date: today,
      daily_realized_pnl_sol: 0,
      consecutive_losses: 0,
      halted: manuallyPaused,
      halt_reason: manuallyPaused ? state.halt_reason : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as CapitalState;
}

async function sourcePositions(): Promise<SourcePosition[]> {
  const { data, error } = await supabase.from("ai_discovery_positions").select("*").order("opened_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as SourcePosition[];
}

async function capitalPositions(): Promise<CapitalPosition[]> {
  const { data, error } = await supabase.from("ai_capital_positions").select("*").order("opened_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as CapitalPosition[];
}

async function closeCapitalPosition(position: CapitalPosition): Promise<void> {
  const { data: sourceTrade, error: sourceError } = await supabase
    .from("ai_discovery_trades")
    .select("*")
    .eq("position_id", position.source_position_id)
    .order("closed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (sourceError) throw new Error(sourceError.message);
  if (!sourceTrade) return;

  const { data: existing, error: existingError } = await supabase
    .from("ai_capital_trades")
    .select("id")
    .eq("source_position_id", position.source_position_id)
    .limit(1);
  if (existingError) throw new Error(existingError.message);
  if (existing?.length) {
    await supabase.from("ai_capital_positions").delete().eq("position_id", position.position_id);
    return;
  }

  const sizeSol = n(position.size_sol, FIXED_SIZE_SOL);
  const netPct = n(sourceTrade.net_return_pct);
  const pnlSol = sizeSol * netPct / 100;
  const proceedsSol = Math.max(0, sizeSol + pnlSol);
  const now = new Date().toISOString();

  const { error: insertError } = await supabase.from("ai_capital_trades").insert({
    position_id: position.position_id,
    source_position_id: position.source_position_id,
    mint: position.mint,
    token_symbol: position.token_symbol,
    pair_address: position.pair_address,
    entry_price_usd: n(position.entry_price_usd),
    exit_price_usd: n(sourceTrade.exit_price_usd),
    size_sol: sizeSol,
    gross_return_pct: n(sourceTrade.gross_return_pct),
    net_return_pct: netPct,
    pnl_sol: pnlSol,
    exit_reason: sourceTrade.exit_reason,
    opened_at: position.opened_at,
    closed_at: sourceTrade.closed_at,
    source_trade_id: sourceTrade.id,
    entry_snapshot: {
      version: VERSION,
      sourcePositionId: position.source_position_id,
      sourceEntrySnapshot: position.entry_snapshot,
      scaleMultiple: 5,
    },
    exit_snapshot: {
      version: VERSION,
      sourceTradeId: sourceTrade.id,
      sourceExitSnapshot: sourceTrade.exit_snapshot,
    },
  });
  if (insertError) throw new Error(insertError.message);

  const { error: deleteError } = await supabase.from("ai_capital_positions").delete().eq("position_id", position.position_id);
  if (deleteError) throw new Error(deleteError.message);

  const state = await loadState();
  const losses = pnlSol < 0 ? state.consecutive_losses + 1 : 0;
  const dailyPnl = n(state.daily_realized_pnl_sol) + pnlSol;
  const shouldHalt = dailyPnl <= -DAILY_LOSS_LIMIT_SOL || losses >= MAX_CONSECUTIVE_LOSSES;
  const haltReason = dailyPnl <= -DAILY_LOSS_LIMIT_SOL
    ? "daily_loss_limit"
    : losses >= MAX_CONSECUTIVE_LOSSES
      ? "consecutive_loss_limit"
      : state.halt_reason;

  const { error: stateError } = await supabase
    .from("ai_capital_state")
    .update({
      bankroll_sol: n(state.bankroll_sol) + proceedsSol,
      daily_realized_pnl_sol: dailyPnl,
      consecutive_losses: losses,
      halted: state.halted || shouldHalt,
      halt_reason: state.halted ? state.halt_reason : haltReason,
      last_sync_at: now,
      updated_at: now,
    })
    .eq("id", 1);
  if (stateError) throw new Error(stateError.message);

  await sendTelegramAlert([
    `${pnlSol >= 0 ? "✅" : "🔴"} <b>AI CAPITAL PAPER TRADE CLOSED</b>`,
    "",
    `Token: <b>${position.token_symbol}</b>`,
    `Exit: <b>${String(sourceTrade.exit_reason).replaceAll("_", " ")}</b>`,
    `Size: <b>${sizeSol.toFixed(3)} SOL</b>`,
    `Net: <b>${netPct >= 0 ? "+" : ""}${netPct.toFixed(2)}%</b>`,
    `PnL: <b>${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(5)} SOL</b>`,
    "",
    "🧪 Paper-only 5× mirror — no real SOL used.",
  ].join("\n"));
}

async function openCapitalPosition(state: CapitalState, source: SourcePosition): Promise<void> {
  if (!state.enabled || state.halted) return;
  if (n(state.daily_realized_pnl_sol) <= -DAILY_LOSS_LIMIT_SOL || state.consecutive_losses >= MAX_CONSECUTIVE_LOSSES) {
    const reason = n(state.daily_realized_pnl_sol) <= -DAILY_LOSS_LIMIT_SOL ? "daily_loss_limit" : "consecutive_loss_limit";
    await supabase.from("ai_capital_state").update({ halted: true, halt_reason: reason, updated_at: new Date().toISOString() }).eq("id", 1);
    return;
  }
  if (n(state.bankroll_sol) < FIXED_SIZE_SOL) return;
  if ((await capitalPositions()).length > 0) return;

  const now = new Date().toISOString();
  const positionId = `aicap_${source.position_id}`;
  const { error } = await supabase.from("ai_capital_positions").insert({
    position_id: positionId,
    source_position_id: source.position_id,
    mint: source.mint,
    token_symbol: source.token_symbol,
    pair_address: source.pair_address,
    entry_price_usd: n(source.entry_price_usd),
    last_price_usd: n(source.last_price_usd, n(source.entry_price_usd)),
    peak_price_usd: n(source.peak_price_usd, n(source.entry_price_usd)),
    size_sol: FIXED_SIZE_SOL,
    opened_at: source.opened_at,
    source_size_sol: n(source.size_sol),
    entry_snapshot: {
      version: VERSION,
      sourcePositionId: source.position_id,
      sourceEntrySnapshot: source.entry_snapshot,
      scaleMultiple: 5,
    },
    updated_at: now,
  });
  if (error) throw new Error(error.message);

  const { error: stateError } = await supabase
    .from("ai_capital_state")
    .update({
      bankroll_sol: n(state.bankroll_sol) - FIXED_SIZE_SOL,
      entries_today: state.entries_today + 1,
      last_sync_at: now,
      updated_at: now,
    })
    .eq("id", 1);
  if (stateError) throw new Error(stateError.message);

  await sendTelegramAlert([
    "🧠💰 <b>AI CAPITAL PAPER TRADE OPENED</b>",
    "",
    `Token: <b>${source.token_symbol}</b>`,
    `Size: <b>${FIXED_SIZE_SOL.toFixed(3)} SOL</b>`,
    `Source AI size: <b>${n(source.size_sol).toFixed(3)} SOL</b>`,
    `Scale: <b>5×</b>`,
    "",
    `<a href=\"https://dexscreener.com/solana/${source.pair_address}\">Open chart</a>`,
    "",
    "🧪 Paper-only mirror — no real SOL used.",
  ].join("\n"));
}

async function syncMirror(): Promise<void> {
  if (syncRunning) return;
  syncRunning = true;
  try {
    const sources = await sourcePositions();
    const sourceIds = new Set(sources.map((position) => position.position_id));
    const mirrors = await capitalPositions();

    for (const mirror of mirrors) {
      const source = sources.find((position) => position.position_id === mirror.source_position_id);
      if (!sourceIds.has(mirror.source_position_id)) {
        await closeCapitalPosition(mirror);
      } else if (source) {
        await supabase.from("ai_capital_positions").update({
          last_price_usd: n(source.last_price_usd, n(mirror.last_price_usd)),
          peak_price_usd: n(source.peak_price_usd, n(mirror.peak_price_usd)),
          updated_at: new Date().toISOString(),
        }).eq("position_id", mirror.position_id);
      }
    }

    const state = await resetDay(await loadState());
    const currentMirrors = await capitalPositions();
    if (!currentMirrors.length && sources[0]) await openCapitalPosition(state, sources[0]);

    await supabase.from("ai_capital_state").update({ last_sync_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", 1);
  } finally {
    syncRunning = false;
  }
}

export function startAiCapitalMirror(): void {
  console.log(`[ai-capital-mirror] ${VERSION} enabled; paper-only; 5.00 SOL bankroll; 1.00 SOL mirrored positions`);
  void syncMirror().catch((error) => console.error("[ai-capital-mirror] initial sync failed", error));
  setInterval(() => void syncMirror().catch((error) => console.error("[ai-capital-mirror] sync failed", error)), SYNC_INTERVAL_MS);
}
