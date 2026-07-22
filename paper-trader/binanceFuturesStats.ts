import { getSupabaseAdmin } from "../lib/supabase";

type Numeric = number | string | null;

const n = (value: Numeric | undefined): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const money = (value: number): string =>
  `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`;

export async function handleBinanceFuturesStats(): Promise<string> {
  const supabase = getSupabaseAdmin({ noStore: true });
  const [stateResult, positionResult, tradesResult, latestScanResult] = await Promise.all([
    supabase.from("binance_futures_state").select("*").eq("id", 1).single(),
    supabase.from("binance_futures_positions").select("*").maybeSingle(),
    supabase
      .from("binance_futures_trades")
      .select("net_pnl_usdt,margin_return_pct,exit_reason,closed_at")
      .order("closed_at", { ascending: false })
      .limit(500),
    supabase
      .from("binance_futures_scan_runs")
      .select("candle_close_time,close_price,rolling_change_pct,triggered,action,reason")
      .order("candle_close_time", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (stateResult.error) throw new Error(stateResult.error.message);
  if (positionResult.error) throw new Error(positionResult.error.message);
  if (tradesResult.error) throw new Error(tradesResult.error.message);
  if (latestScanResult.error) throw new Error(latestScanResult.error.message);

  const state = stateResult.data;
  const position = positionResult.data;
  const trades = tradesResult.data ?? [];
  const wins = trades.filter((row) => n(row.net_pnl_usdt) > 0);
  const losses = trades.filter((row) => n(row.net_pnl_usdt) < 0);
  const grossProfit = wins.reduce((sum, row) => sum + n(row.net_pnl_usdt), 0);
  const grossLoss = Math.abs(losses.reduce((sum, row) => sum + n(row.net_pnl_usdt), 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : null;
  const winRate = wins.length + losses.length > 0 ? wins.length / (wins.length + losses.length) : 0;
  const scan = latestScanResult.data;
  const connectionStatus = String(state.connection_status ?? "unknown");
  const connectionIcon = connectionStatus === "connected" ? "🟢" : connectionStatus === "degraded" ? "🟡" : "🔴";
  const source = String(state.data_source ?? "unavailable").replaceAll("_", " ");

  const lines = [
    "📉 <b>BINANCE FUTURES PAPER BOT</b>",
    "",
    `${connectionIcon} Market data: <b>${connectionStatus.toUpperCase()}</b>`,
    `Source: <b>${source}</b>`,
    `Mode: <b>BTCUSDT pump-fade SHORT · paper only</b>`,
    `Paper bankroll: <b>$${n(state.bankroll_usdt).toFixed(2)}</b>`,
    `Total PnL: <b>${money(n(state.realized_pnl_usdt))}</b>`,
    `Entries today: <b>${n(state.entries_today)}</b>`,
    `Completed trades: <b>${trades.length}</b>`,
    `Win rate: <b>${(winRate * 100).toFixed(1)}%</b>`,
    `Profit factor: <b>${profitFactor == null ? "n/a" : Number.isFinite(profitFactor) ? profitFactor.toFixed(2) : "∞"}</b>`,
    `Risk state: <b>${state.halted ? `HALTED — ${state.halt_reason ?? "risk guard"}` : "ACTIVE"}</b>`,
  ];

  if (position) {
    const current = n(position.last_market_price);
    const entry = n(position.entry_fill_price);
    const unrealized = n(position.quantity) * (entry - current) - n(position.entry_fee_usdt);
    lines.push(
      "",
      "<b>OPEN PAPER SHORT</b>",
      `Entry: <b>$${entry.toLocaleString(undefined, { maximumFractionDigits: 2 })}</b>`,
      `Current: <b>$${current.toLocaleString(undefined, { maximumFractionDigits: 2 })}</b>`,
      `Margin: <b>$${n(position.margin_usdt).toFixed(2)}</b> @ ${n(position.leverage)}x`,
      `Unrealized before exit fee: <b>${money(unrealized)}</b>`,
      `Stop: <b>$${n(position.stop_loss_price).toLocaleString()}</b>`,
      `Target: <b>$${n(position.take_profit_price).toLocaleString()}</b>`,
    );
  } else {
    lines.push("", "Open position: <b>None</b>");
  }

  if (scan) {
    lines.push(
      "",
      `<b>Latest 1-minute scan</b>`,
      `BTC: <b>$${n(scan.close_price).toLocaleString(undefined, { maximumFractionDigits: 2 })}</b>`,
      `Rolling move: <b>${n(scan.rolling_change_pct) >= 0 ? "+" : ""}${n(scan.rolling_change_pct).toFixed(2)}%</b>`,
      `Result: <b>${String(scan.action).replaceAll("_", " ")}</b>`,
    );
  }

  if (state.last_error) {
    lines.push("", `Note: ${String(state.last_error)}`);
  }

  lines.push("", "No Binance API key is connected. No real order can be placed.");
  return lines.join("\n");
}
