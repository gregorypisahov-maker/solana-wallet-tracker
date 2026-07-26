import "./live.css";
import { getLiveWalletHealth } from "@/lib/liveWallet";
import { getSupabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type Gate = { label: string; ready: boolean; detail: string };
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
  closed_at: string | null;
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
  updated_at: string | null;
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

const n = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const short = (value: string | null | undefined) => value ? `${value.slice(0, 6)}…${value.slice(-6)}` : "—";
const when = (value: string | null | undefined) => value ? new Intl.DateTimeFormat("en-IL", {
  timeZone: "Asia/Jerusalem",
  dateStyle: "short",
  timeStyle: "medium",
}).format(new Date(value)) : "—";
const solscan = (signature: string | null | undefined) => signature ? `https://solscan.io/tx/${encodeURIComponent(signature)}` : null;

export default async function LiveTradingPage() {
  const health = await getLiveWalletHealth();
  const limitsConfigured = Boolean(process.env.LIVE_MAX_POSITION_USD && process.env.LIVE_MAX_DAILY_LOSS_USD);
  const databaseControlsConfigured = Boolean((process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL) && process.env.SUPABASE_SERVICE_ROLE_KEY);

  let positions: LivePosition[] = [];
  let orders: LiveOrder[] = [];
  let executor: ExecutorState | null = null;
  let activityError: string | null = null;

  if (databaseControlsConfigured) {
    try {
      const supabase = getSupabaseAdmin({ noStore: true });
      const [positionsResult, ordersResult, stateResult] = await Promise.all([
        supabase.from("live_positions").select("id,token_symbol,mint,status,spent_sol,proceeds_sol,realized_pnl_sol,entry_tx_signature,exit_tx_signature,opened_at,closed_at").order("opened_at", { ascending: false }).limit(20),
        supabase.from("live_orders").select("id,side,mint,status,requested_size_sol,tx_signature,error,created_at,updated_at").order("created_at", { ascending: false }).limit(20),
        supabase.from("live_executor_state").select("enabled,halted,halt_reason,last_heartbeat_at,daily_entries,daily_realized_pnl_sol,max_position_sol").eq("id", 1).maybeSingle(),
      ]);
      if (positionsResult.error) throw positionsResult.error;
      if (ordersResult.error) throw ordersResult.error;
      if (stateResult.error) throw stateResult.error;
      positions = (positionsResult.data ?? []) as LivePosition[];
      orders = (ordersResult.data ?? []) as LiveOrder[];
      executor = stateResult.data as ExecutorState | null;
    } catch (error) {
      activityError = error instanceof Error ? error.message : "Could not load live activity";
    }
  }

  const gates: Gate[] = [
    { label: "Dedicated wallet address", ready: Boolean(health.publicKey), detail: health.publicKey ? `${health.publicKey.slice(0, 6)}…${health.publicKey.slice(-6)}` : "Add LIVE_WALLET_PUBLIC_KEY in the Railway worker and dashboard" },
    { label: "Transaction signer", ready: health.signerConfigured, detail: health.signerConfigured ? "Signing secret is present and never exposed to the browser" : "Add LIVE_WALLET_PRIVATE_KEY only to the Railway worker" },
    { label: "Solana RPC", ready: health.rpcConfigured, detail: health.rpcConfigured ? "RPC provider configured" : "Add SOLANA_RPC_URL or ALCHEMY_RPC_URL" },
    { label: "Database controls", ready: databaseControlsConfigured, detail: databaseControlsConfigured ? "Live controls and audit storage available" : "Supabase service credentials are missing" },
    { label: "Risk limits", ready: limitsConfigured, detail: limitsConfigured ? "Position and daily-loss limits configured" : "Add LIVE_MAX_POSITION_USD and LIVE_MAX_DAILY_LOSS_USD" },
    { label: "Execution enabled", ready: health.enabled, detail: health.enabled ? "LIVE_TRADING_ENABLED=true" : "Safely disabled" },
    { label: "Final execution arm", ready: health.armed, detail: health.armed ? "LIVE_EXECUTION_ARMED=true" : "Second safety lock remains off" },
  ];

  const readyCount = gates.filter((gate) => gate.ready).length;
  const fullyReady = readyCount === gates.length;
  const openPositions = positions.filter((position) => ["open", "closing", "reconciliation_required"].includes(position.status));
  const lastOrder = orders[0] ?? null;
  const heartbeatFresh = executor?.last_heartbeat_at ? Date.now() - Date.parse(executor.last_heartbeat_at) < 60_000 : false;
  const automationActive = fullyReady && Boolean(executor?.enabled) && !executor?.halted && heartbeatFresh;

  return (
    <main className="livePage">
      <nav className="liveNav"><a href="/platform">← Platform</a><a href="/subscribe">Subscriptions</a></nav>
      <section className="liveHero">
        <div className={automationActive ? "status ready" : fullyReady ? "status safe" : "status safe"}>{automationActive ? "AUTO LIVE" : fullyReady ? "ARMED — WAITING FOR WORKER" : "FAIL-CLOSED"}</div>
        <h1>Live Trading Control Center</h1>
        <p>The AI discovery strategy is connected to the guarded live executor. Fresh paper entries are mirrored automatically and their exits are sold automatically.</p>
      </section>

      <section className="liveGrid">
        <article className="summaryCard"><span>Readiness</span><strong>{readyCount}/{gates.length}</strong><small>{fullyReady ? "All configuration gates pass" : "Real trades remain blocked"}</small></article>
        <article className="summaryCard"><span>Wallet balance</span><strong>{health.balanceSol == null ? "—" : `${health.balanceSol.toFixed(4)} SOL`}</strong><small>{health.error ?? (health.publicKey ? "On-chain confirmed balance" : "Wallet not connected")}</small></article>
        <article className="summaryCard"><span>Automation</span><strong>{automationActive ? "RUNNING" : executor?.halted ? "HALTED" : "WAITING"}</strong><small>{executor?.halted ? executor.halt_reason ?? "Emergency stop active" : heartbeatFresh ? `Heartbeat ${when(executor?.last_heartbeat_at)}` : "Waiting for live-executor heartbeat"}</small></article>
        <article className="summaryCard"><span>Open real positions</span><strong>{openPositions.length}</strong><small>{executor ? `${executor.daily_entries ?? 0} live entries today` : "No executor state"}</small></article>
      </section>

      <section className="panel">
        <div className="panelHeading"><div><span>REAL MONEY ACTIVITY</span><h2>Live positions and completed trades</h2></div></div>
        {activityError ? <p className="negative">Could not load live activity: {activityError}</p> : positions.length === 0 ? (
          <p>No real trade has executed yet. This section will update automatically after the next eligible AI discovery entry.</p>
        ) : (
          <div className="investorRows">
            {positions.map((position) => {
              const signature = position.exit_tx_signature ?? position.entry_tx_signature;
              const link = solscan(signature);
              return (
                <div key={position.id}>
                  <span>{position.token_symbol ?? short(position.mint)} · {position.status.toUpperCase()}</span>
                  <strong>{n(position.spent_sol).toFixed(4)} SOL{position.status === "closed" ? ` → ${n(position.proceeds_sol).toFixed(4)} SOL` : " invested"}</strong>
                  <b className={n(position.realized_pnl_sol) >= 0 ? "positive" : "negative"}>{position.status === "closed" ? `${n(position.realized_pnl_sol) >= 0 ? "+" : ""}${n(position.realized_pnl_sol).toFixed(5)} SOL` : when(position.opened_at)}</b>
                  {link && <a href={link} target="_blank" rel="noreferrer">View transaction ↗</a>}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panelHeading"><div><span>EXECUTION FEED</span><h2>Latest Jupiter orders</h2></div></div>
        {orders.length === 0 ? <p>No Jupiter order has been submitted yet.</p> : (
          <div className="investorRows">
            {orders.map((order) => {
              const link = solscan(order.tx_signature);
              return (
                <div key={order.id}>
                  <span>{order.side.toUpperCase()} · {short(order.mint)}</span>
                  <strong>{order.requested_size_sol == null ? "Token exit" : `${n(order.requested_size_sol).toFixed(4)} SOL`}</strong>
                  <b className={order.status === "confirmed" ? "positive" : order.status === "failed" ? "negative" : ""}>{order.status.toUpperCase()}</b>
                  <small>{order.error ?? when(order.updated_at ?? order.created_at)}</small>
                  {link && <a href={link} target="_blank" rel="noreferrer">Solscan ↗</a>}
                </div>
              );
            })}
          </div>
        )}
        {lastOrder?.error && <p className="negative">Latest order error: {lastOrder.error}</p>}
      </section>

      <section className="panel">
        <div className="panelHeading"><div><span>LIVE WALLET</span><h2>Execution safety gates</h2></div></div>
        <div className="gateList">
          {gates.map((gate) => <div className="gate" key={gate.label}><div className={gate.ready ? "dot ok" : "dot"}/><div><strong>{gate.label}</strong><small>{gate.detail}</small></div><b>{gate.ready ? "READY" : "BLOCKED"}</b></div>)}
        </div>
      </section>

      <section className="panel riskPanel">
        <span>AUTOMATIC AI MIRROR</span><h2>Guarded Jupiter execution</h2>
        <div className="riskGrid"><div><strong>{n(executor?.max_position_sol).toFixed(2)} SOL</strong><small>database position cap</small></div><div><strong>0.02 SOL</strong><small>minimum remaining reserve</small></div><div><strong>2 locks</strong><small>enabled and armed</small></div><div><strong>{n(executor?.daily_realized_pnl_sol).toFixed(5)} SOL</strong><small>realized today</small></div></div>
        <p>The executor mirrors only fresh AI discovery positions, rejects stale or oversized signals, permits one configured number of simultaneous positions, records every order and transaction signature, and halts automatically on an execution failure.</p>
      </section>
      <footer>Real trading carries substantial risk. Paper performance does not guarantee live results.</footer>
    </main>
  );
}
