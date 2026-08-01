import { getSupabaseAdmin } from "../lib/supabase";
import { calculateSpotExit } from "./solSpotPaper";

const finite = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const signed = (value: number, digits = 2): string =>
  `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;

const money = (value: unknown, digits = 2): string => `${finite(value).toFixed(digits)} USDT`;
const short = (value: string | null | undefined): string =>
  value ? `${value.slice(0, 5)}…${value.slice(-5)}` : "not linked";

const israelTime = (value: string | null | undefined): string => {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat("en-IL", {
    timeZone: "Asia/Jerusalem",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
};

function healthLabel(state: any): string {
  if (!state) return "⚫ unavailable";
  if (state.enabled === false) return "⚫ disabled";
  if (state.halted) return `🔴 halted${state.halt_reason ? ` — ${state.halt_reason}` : ""}`;
  const heartbeat = state.last_heartbeat_at ?? state.last_ws_message_at ?? state.updated_at;
  const ageMs = heartbeat ? Date.now() - Date.parse(heartbeat) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(ageMs) || ageMs > 90_000) {
    return state.connection_status === "error"
      ? `🔴 error${state.last_error ? ` — ${String(state.last_error).slice(0, 120)}` : ""}`
      : "🟠 offline / starting";
  }
  if (["degraded", "error"].includes(String(state.connection_status ?? ""))) {
    return `🟠 ${state.connection_status}${state.last_error ? ` — ${String(state.last_error).slice(0, 120)}` : ""}`;
  }
  return "🟢 scanning";
}

async function loadSpotSection(): Promise<string[]> {
  const supabase = getSupabaseAdmin({ noStore: true });
  const [stateResult, positionResult, tradesResult, scanResult] = await Promise.all([
    supabase.from("sol_spot_paper_state").select("*").eq("id", 1).maybeSingle(),
    supabase.from("sol_spot_paper_positions").select("*").maybeSingle(),
    supabase
      .from("sol_spot_paper_trades")
      .select("net_pnl_usdt,net_return_pct,exit_reason,closed_at")
      .order("closed_at", { ascending: false })
      .limit(500),
    supabase
      .from("sol_spot_paper_scan_runs")
      .select("score,threshold,action,reasons,candle_close_time,close_price")
      .order("candle_close_time", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const failed = [stateResult, positionResult, tradesResult, scanResult].find((result) => result.error);
  if (failed?.error) throw new Error(`SOL spot stats unavailable: ${failed.error.message}`);

  const state = stateResult.data;
  const position = positionResult.data;
  const trades = tradesResult.data ?? [];
  const latestScan = scanResult.data;
  const wins = trades.filter((trade: any) => finite(trade.net_pnl_usdt) > 0).length;
  const losses = trades.filter((trade: any) => finite(trade.net_pnl_usdt) < 0).length;
  const pnl = trades.reduce((sum: number, trade: any) => sum + finite(trade.net_pnl_usdt), 0);
  const currentPrice = finite(state?.last_market_price ?? position?.last_market_price);
  let equity = finite(state?.bankroll_usdt);
  let openLine = "Open position: <b>none</b>";

  if (position && currentPrice > 0) {
    const mark = calculateSpotExit({
      quantity: finite(position.quantity),
      entryFillPrice: finite(position.entry_fill_price),
      entryFeeUsdt: finite(position.entry_fee_usdt),
      quoteSpentUsdt: finite(position.quote_spent_usdt),
      marketExitPrice: currentPrice,
    });
    equity += mark.proceedsUsdt;
    openLine = [
      `Open position: <b>${finite(position.quantity).toFixed(4)} SOL</b>`,
      `Entry ${finite(position.entry_fill_price).toFixed(4)} · Mark ${currentPrice.toFixed(4)}`,
      `Open PnL <b>${signed(mark.netPnlUsdt)} USDT (${signed(mark.netReturnPct)}%)</b>`,
      `Stop ${finite(position.stop_loss_price).toFixed(4)} · Target ${finite(position.take_profit_price).toFixed(4)}`,
    ].join("\n");
  }

  const scanReasons = Array.isArray(latestScan?.reasons)
    ? latestScan.reasons.map((reason: unknown) => String(reason).replaceAll("_", " ")).join(", ")
    : "—";

  return [
    "🟣 <b>SOL/USDT SPOT PAPER</b>",
    `Status: <b>${healthLabel(state)}</b>`,
    `Price: <b>${currentPrice > 0 ? `${currentPrice.toFixed(4)} USDT` : "no live price"}</b>`,
    `Cash: <b>${money(state?.bankroll_usdt)}</b> · Equity: <b>${money(equity)}</b>`,
    `Realized PnL: <b>${signed(pnl)} USDT</b>`,
    `Trades: <b>${trades.length}</b> · ${wins}W/${losses}L · Win rate <b>${trades.length ? ((wins / trades.length) * 100).toFixed(1) : "0.0"}%</b>`,
    `Today: ${state?.entries_today ?? 0} entries · ${signed(finite(state?.daily_realized_pnl_usdt))} USDT`,
    openLine,
    latestScan
      ? `Latest decision: <b>${String(latestScan.action).replaceAll("_", " ")}</b> · score ${latestScan.score ?? "—"}/${latestScan.threshold ?? "—"}\n${scanReasons}`
      : "Latest decision: <b>no scans recorded</b>",
    `Heartbeat: ${israelTime(state?.last_heartbeat_at)} Israel`,
  ];
}

async function loadLiveWalletSection(): Promise<string[]> {
  const supabase = getSupabaseAdmin({ noStore: true });
  const [settingsResult, livePositionResult, paperPositionResult, tradesResult] = await Promise.all([
    supabase.from("sol_spot_live_settings").select("*").eq("id", 1).maybeSingle(),
    supabase.from("sol_spot_live_positions").select("*").eq("id", 1).maybeSingle(),
    supabase.from("sol_spot_paper_positions").select("position_id").maybeSingle(),
    supabase.from("sol_spot_live_trades").select("pnl_usdt").limit(500),
  ]);
  const failed = [settingsResult, livePositionResult, paperPositionResult, tradesResult]
    .find((result) => result.error);
  if (failed?.error) return ["🔐 <b>REAL SOL/USDT WALLET</b>", "Status unavailable"];

  const settings = settingsResult.data;
  const livePosition = livePositionResult.data;
  const paperPosition = paperPositionResult.data;
  const armed = Boolean(
    settings?.armed && settings?.armed_until && Date.parse(settings.armed_until) > Date.now()
  );
  const nextAction = livePosition ? (paperPosition ? "HOLD" : "APPROVE SELL") : paperPosition ? "APPROVE BUY" : "WAIT";
  const pnl = (tradesResult.data ?? []).reduce(
    (sum: number, trade: any) => sum + finite(trade.pnl_usdt),
    0
  );

  return [
    "🔐 <b>REAL SOL/USDT WALLET</b>",
    `Wallet: <b>${short(settings?.wallet_public_key)}</b>`,
    `Mode: <b>${armed ? "🟢 ARMED" : "⚫ DISARMED"}</b>${armed ? ` until ${israelTime(settings?.armed_until)}` : ""}`,
    `Maximum buy: <b>${money(settings?.max_position_usdt)}</b> · manual wallet approval`,
    livePosition
      ? `Tracked position: <b>${finite(livePosition.quantity_sol).toFixed(6)} SOL</b> · cost ${money(livePosition.cost_usdt)}`
      : "Tracked position: <b>none</b>",
    `Next action: <b>${nextAction}</b>`,
    `Completed real PnL: <b>${signed(pnl)} USDT</b>`,
    "The bot never stores the wallet seed phrase or private key.",
  ];
}

async function loadLegacyFuturesSection(): Promise<string[]> {
  const supabase = getSupabaseAdmin({ noStore: true });
  const [stateResult, positionsResult, tradesResult] = await Promise.all([
    supabase.from("binance_futures_state").select("*").eq("id", 1).maybeSingle(),
    supabase.from("binance_futures_positions").select("position_id").limit(2),
    supabase.from("binance_futures_trades").select("net_pnl_usdt").limit(500),
  ]);
  const failed = [stateResult, positionsResult, tradesResult].find((result) => result.error);
  if (failed?.error) return ["₿ <b>BTC FUTURES PAPER</b>", "Status unavailable"];
  const state = stateResult.data;
  const trades = tradesResult.data ?? [];
  const pnl = trades.reduce((sum: number, trade: any) => sum + finite(trade.net_pnl_usdt), 0);
  return [
    "₿ <b>BTC FUTURES PAPER (LEGACY)</b>",
    `Status: <b>${healthLabel(state)}</b>`,
    `Bankroll: <b>${money(state?.bankroll_usdt)}</b> · Open slots: <b>${positionsResult.data?.length ?? 0}</b>`,
    `Completed: <b>${trades.length}</b> · PnL: <b>${signed(pnl)} USDT</b>`,
  ];
}

export async function handleBinanceFuturesStats(): Promise<string> {
  const [spot, liveWallet, futures] = await Promise.all([
    loadSpotSection(),
    loadLiveWalletSection(),
    loadLegacyFuturesSection(),
  ]);
  return [
    "📊 <b>BINANCE / SOL SPOT TRADING</b>",
    "",
    ...spot,
    "",
    ...liveWallet,
    "",
    ...futures,
    "",
    `🌐 <a href="https://solana-wallet-tracker-murex.vercel.app/platform/binance#sol-spot-live">Open wallet and real-trade controls</a>`,
  ].join("\n");
}
