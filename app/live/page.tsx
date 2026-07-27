import "./live.css";
import { getLiveWalletHealth } from "@/lib/liveWallet";
import { getSupabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type LivePosition = {
  id: string;
  token_symbol: string | null;
  mint: string;
  status: string;
  spent_sol: number | string | null;
  proceeds_sol: number | string | null;
  realized_pnl_sol: number | string | null;
  entry_tx_signature: string | null;
  exit_tx_signature: string | null;
  opened_at: string | null;
};

type LiveOrder = {
  id: string;
  side: string;
  mint: string;
  status: string;
  requested_size_sol: number | string | null;
  tx_signature: string | null;
  error: string | null;
  created_at: string | null;
};

type ExecutorState = {
  enabled: boolean;
  halted: boolean;
  halt_reason: string | null;
  last_heartbeat_at: string | null;
  daily_entries: number;
  daily_realized_pnl_sol: number | string;
  max_position_sol: number | string;
};

const num = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const short = (value: string | null | undefined) => value ? `${value.slice(0, 6)}…${value.slice(-6)}` : "—";
const when = (value: string | null | undefined) => value ? new Intl.DateTimeFormat("en-IL", {
  timeZone: "Asia/Jerusalem",
  dateStyle: "short",
  timeStyle: "medium",
}).format(new Date(value)) : "—";
const txLink = (signature: string | null | undefined) => signature ? `https://solscan.io/tx/${encodeURIComponent(signature)}` : null;

export default async function LiveTradingPage({
  searchParams,
}: {
  searchParams?: { stopped?: string; resumed?: string; stop_error?: string; resume_error?: string };
}) {
  const health = await getLiveWalletHealth();
  const databaseReady = Boolean((process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL) && process.env.SUPABASE_SERVICE_ROLE_KEY);

  let positions: LivePosition[] = [];
  let orders: LiveOrder[] = [];
  let executor: ExecutorState | null = null;
  let loadError: string | null = null;

  if (databaseReady) {
    try {
      const supabase = getSupabaseAdmin({ noStore: true });
      const [positionResult, orderResult, stateResult] = await Promise.all([
        supabase.from("live_positions").select("id,token_symbol,mint,status,spent_sol,proceeds_sol,realized_pnl_sol,entry_tx_signature,exit_tx_signature,opened_at").order("opened_at", { ascending: false }).limit(30),
        supabase.from("live_orders").select("id,side,mint,status,requested_size_sol,tx_signature,error,created_at").order("created_at", { ascending: false }).limit(30),
        supabase.from("live_executor_state").select("enabled,halted,halt_reason,last_heartbeat_at,daily_entries,daily_realized_pnl_sol,max_position_sol").eq("id", 1).maybeSingle(),
      ]);
      if (positionResult.error) throw positionResult.error;
      if (orderResult.error) throw orderResult.error;
      if (stateResult.error) throw stateResult.error;
      positions = (positionResult.data ?? []) as LivePosition[];
      orders = (orderResult.data ?? []) as LiveOrder[];
      executor = stateResult.data as ExecutorState | null;
    } catch (error) {
      loadError = error instanceof Error ? error.message : "Could not load live data";
    }
  }

  const openPositions = positions.filter((p) => ["open", "closing", "reconciliation_required"].includes(p.status));
  const heartbeatFresh = executor?.last_heartbeat_at ? Date.now() - Date.parse(executor.last_heartbeat_at) < 60_000 : false;
  const running = Boolean(executor?.enabled) && !executor?.halted && heartbeatFresh && health.enabled && health.armed;
  const notice = searchParams?.stopped === "1"
    ? "Live trading was stopped."
    : searchParams?.resumed === "1"
      ? "Live trading was resumed. Railway runtime safety locks must also be armed."
      : null;
  const actionError = searchParams?.stop_error || searchParams?.resume_error;

  return (
    <main className="livePage">
      <nav className="liveNav"><a href="/platform">← Platform</a><strong>LIVE BUILD 2026-07-27-A</strong></nav>

      <section className="liveHero">
        <div className={running ? "status ready" : "status safe"}>{running ? "REAL TRADING RUNNING" : executor?.halted ? "REAL TRADING STOPPED" : "REAL TRADING WAITING"}</div>
        <h1>Live Trading Dashboard</h1>
        <p>Real wallet balance, open positions, completed trades, Jupiter orders and emergency controls.</p>
      </section>

      {notice && <section className="actionNotice">{notice}</section>}
      {actionError && <section className="actionNotice error">Control failed: {decodeURIComponent(actionError)}</section>}

      <details className="controlPanel">
        <summary><strong>Emergency trading controls</strong> — tap to open</summary>
        <div>
          <span>REAL MONEY CONTROL</span>
          <h2>{executor?.halted || !executor?.enabled ? "Trading is stopped" : "Trading control is enabled"}</h2>
          <p>STOP blocks new live execution immediately. RESUME re-enables the database gate; Railway environment safety locks still apply.</p>
        </div>
        <div className="controlButtons">
          <form action="/api/live/stop" method="post"><button className="stopButton" type="submit">STOP REAL TRADING</button></form>
          <form action="/api/live/resume" method="post"><button className="resumeButton" type="submit">RESUME REAL TRADING</button></form>
        </div>
      </details>

      <section className="liveGrid">
        <article className="summaryCard"><span>Wallet balance</span><strong>{health.balanceSol == null ? "—" : `${health.balanceSol.toFixed(4)} SOL`}</strong><small>{health.error ?? "On-chain wallet balance"}</small></article>
        <article className="summaryCard"><span>Executor</span><strong>{running ? "RUNNING" : executor?.halted ? "STOPPED" : "WAITING"}</strong><small>{executor?.halt_reason ?? (heartbeatFresh ? `Heartbeat ${when(executor?.last_heartbeat_at)}` : "No fresh heartbeat")}</small></article>
        <article className="summaryCard"><span>Open positions</span><strong>{openPositions.length}</strong><small>{executor?.daily_entries ?? 0} real entries today</small></article>
        <article className="summaryCard"><span>Realized today</span><strong>{num(executor?.daily_realized_pnl_sol).toFixed(5)} SOL</strong><small>Closed live trades only</small></article>
      </section>

      <section className="panel">
        <div className="panelHeading"><span>REAL MONEY POSITIONS</span><h2>Open and completed live trades</h2></div>
        {loadError ? <p className="negative">{loadError}</p> : positions.length === 0 ? <p>No real trade has executed yet.</p> : (
          <div className="investorRows">{positions.map((position) => {
            const link = txLink(position.exit_tx_signature ?? position.entry_tx_signature);
            return <div key={position.id}>
              <span>{position.token_symbol ?? short(position.mint)} · {position.status.toUpperCase()}</span>
              <strong>{num(position.spent_sol).toFixed(4)} SOL{position.status === "closed" ? ` → ${num(position.proceeds_sol).toFixed(4)} SOL` : " invested"}</strong>
              <b className={num(position.realized_pnl_sol) >= 0 ? "positive" : "negative"}>{position.status === "closed" ? `${num(position.realized_pnl_sol) >= 0 ? "+" : ""}${num(position.realized_pnl_sol).toFixed(5)} SOL` : when(position.opened_at)}</b>
              {link && <a href={link} target="_blank" rel="noreferrer">Solscan ↗</a>}
            </div>;
          })}</div>
        )}
      </section>

      <section className="panel">
        <div className="panelHeading"><span>JUPITER EXECUTION FEED</span><h2>Latest real orders</h2></div>
        {orders.length === 0 ? <p>No Jupiter live order has been submitted yet.</p> : (
          <div className="investorRows">{orders.map((order) => {
            const link = txLink(order.tx_signature);
            return <div key={order.id}>
              <span>{order.side.toUpperCase()} · {short(order.mint)}</span>
              <strong>{order.requested_size_sol == null ? "Token exit" : `${num(order.requested_size_sol).toFixed(4)} SOL`}</strong>
              <b>{order.status.toUpperCase()}</b>
              <small>{order.error ?? when(order.created_at)}</small>
              {link && <a href={link} target="_blank" rel="noreferrer">Solscan ↗</a>}
            </div>;
          })}</div>
        )}
      </section>

      <section className="panel"><div className="panelHeading"><span>SAFETY STATUS</span><h2>Execution locks</h2></div>
        <div className="gateList">
          <div className="gate"><div className={health.enabled ? "dot ok" : "dot"}/><div><strong>LIVE_TRADING_ENABLED</strong><small>{health.enabled ? "true" : "false"}</small></div></div>
          <div className="gate"><div className={health.armed ? "dot ok" : "dot"}/><div><strong>LIVE_EXECUTION_ARMED</strong><small>{health.armed ? "true" : "false"}</small></div></div>
          <div className="gate"><div className={executor?.enabled && !executor?.halted ? "dot ok" : "dot"}/><div><strong>Database execution gate</strong><small>{executor?.enabled && !executor?.halted ? "enabled" : "stopped"}</small></div></div>
          <div className="gate"><div className={heartbeatFresh ? "dot ok" : "dot"}/><div><strong>Executor heartbeat</strong><small>{when(executor?.last_heartbeat_at)}</small></div></div>
        </div>
      </section>

      <footer>Build marker: LIVE-2026-07-27-A · Position cap {num(executor?.max_position_sol).toFixed(2)} SOL</footer>
    </main>
  );
}
