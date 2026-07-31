"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import "./trade-timeline.css";

type Trade = any;
type Payload = { generatedAt: string; executor: any; trades: Trade[] };

const fmtSol = (value: number | null) => value == null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(4)} SOL`;
const fmtTime = (value: string | null) => value ? new Intl.DateTimeFormat("en-IL", { timeZone: "Asia/Jerusalem", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)) : "—";
const short = (value: string | null) => value ? `${value.slice(0, 5)}…${value.slice(-4)}` : "—";
const txUrl = (signature: string) => `https://solscan.io/tx/${encodeURIComponent(signature)}`;
const chartUrl = (mint: string) => `https://dexscreener.com/solana/${encodeURIComponent(mint)}`;

function tone(status: string | null) {
  if (!status) return "muted";
  if (["executed", "confirmed", "closed", "open"].includes(status)) return "good";
  if (["rejected", "failed", "halted"].includes(status)) return "bad";
  return "warn";
}

function Stage({ label, status, detail }: { label: string; status: string; detail?: string | null }) {
  return <div className={`ttStage ${tone(status)}`}><span /><div><small>{label}</small><strong>{status.replaceAll("_", " ")}</strong>{detail && <p>{detail}</p>}</div></div>;
}

export default function TradeTimelinePage() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [expanded, setExpanded] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/trade-timeline", { cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 401 ? "Open the main dashboard and log in first." : "Could not load trade timeline");
      setData(await response.json());
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load trade timeline"); }
  }, []);

  useEffect(() => { void refresh(); const id = setInterval(() => void refresh(), 10_000); return () => clearInterval(id); }, [refresh]);

  const trades = useMemo(() => (data?.trades ?? []).filter((trade) => {
    if (filter === "all") return true;
    if (filter === "executed") return trade.live.signalStatus === "executed";
    if (filter === "rejected") return trade.live.signalStatus === "rejected" || trade.live.signalStatus === "failed";
    if (filter === "paper-only") return trade.paper.status !== "not_found" && trade.live.signalStatus === "not_created";
    return true;
  }), [data, filter]);

  const stats = useMemo(() => {
    const rows = data?.trades ?? [];
    return {
      total: rows.length,
      executed: rows.filter((t) => t.live.signalStatus === "executed").length,
      rejected: rows.filter((t) => ["rejected", "failed"].includes(t.live.signalStatus)).length,
      open: rows.filter((t) => t.live.positionStatus === "open").length,
    };
  }, [data]);

  if (!data) return <main className="ttShell"><div className="ttEmpty"><strong>Trade Timeline</strong><p>{error ?? "Loading Supabase trade data…"}</p></div></main>;

  const armed = data.executor?.enabled && !data.executor?.halted;
  return <main className="ttShell">
    <header className="ttHeader">
      <div><a href="/">← Main dashboard</a><h1>Trade Timeline</h1><p>Every AI decision, live safety result, execution and final real PnL in one place.</p></div>
      <div className={`ttExecutor ${armed ? "armed" : "stopped"}`}><span /> <div><small>Real executor</small><strong>{armed ? "ARMED" : "STOPPED"}</strong><p>{data.executor?.halt_reason ?? "No halt reason"}</p></div></div>
    </header>

    <section className="ttStats">
      <div><small>Tracked</small><strong>{stats.total}</strong></div>
      <div><small>Live executed</small><strong>{stats.executed}</strong></div>
      <div><small>Rejected / failed</small><strong>{stats.rejected}</strong></div>
      <div><small>Live open</small><strong>{stats.open}</strong></div>
    </section>

    <nav className="ttFilters">
      {[["all","All"],["executed","Executed"],["rejected","Rejected"],["paper-only","Paper only"]].map(([id,label]) => <button key={id} className={filter === id ? "active" : ""} onClick={() => setFilter(id)}>{label}</button>)}
      <span>Updated {fmtTime(data.generatedAt)}</span>
    </nav>

    <section className="ttList">
      {trades.map((trade) => {
        const isOpen = expanded === trade.sourcePositionId;
        const safety = trade.live.safety ?? {};
        const safetyStatus = trade.live.signalStatus === "executed" ? "passed" : trade.live.rejectionReason ? "blocked" : "not checked";
        return <article className="ttTrade" key={trade.sourcePositionId}>
          <button className="ttTradeHead" onClick={() => setExpanded(isOpen ? null : trade.sourcePositionId)}>
            <div className="ttToken"><strong>{trade.tokenSymbol}</strong><span>{short(trade.mint)}</span></div>
            <div><small>Paper PnL</small><strong className={(trade.paper.pnlSol ?? 0) >= 0 ? "pos" : "neg"}>{fmtSol(trade.paper.pnlSol)}</strong></div>
            <div><small>Live PnL</small><strong className={(trade.live.pnlSol ?? 0) >= 0 ? "pos" : "neg"}>{fmtSol(trade.live.pnlSol)}</strong></div>
            <div><small>Live result</small><strong className={tone(trade.live.signalStatus)}>{trade.live.signalStatus.replaceAll("_", " ")}</strong></div>
            <div><small>Time</small><strong>{fmtTime(trade.createdAt)}</strong></div>
            <b>{isOpen ? "−" : "+"}</b>
          </button>

          {isOpen && <div className="ttDetails">
            <div className="ttFlow">
              <Stage label="AI paper entry" status={trade.paper.status === "not_found" ? "not found" : "created"} detail={trade.paper.sizeSol != null ? `${trade.paper.sizeSol} SOL` : null} />
              <Stage label="Live signal" status={trade.live.signalStatus} detail={trade.live.rejectionReason} />
              <Stage label="Safety gate" status={safetyStatus} detail={trade.live.rejectionReason ?? (safety.roundTripRecoveryPct ? `Round trip ${Number(safety.roundTripRecoveryPct).toFixed(1)}%` : null)} />
              <Stage label="Jupiter buy" status={trade.live.buyOrderStatus ?? "not submitted"} />
              <Stage label="Wallet position" status={trade.live.positionStatus} detail={trade.live.spentSol != null ? `${trade.live.spentSol.toFixed(4)} SOL spent` : null} />
              <Stage label="Exit signal" status={trade.live.exitSignalStatus ?? (trade.paper.closedAt ? "waiting / absent" : "paper open")} detail={trade.live.exitRejectionReason ?? trade.paper.exitReason} />
              <Stage label="Jupiter sell" status={trade.live.sellOrderStatus ?? "not submitted"} />
            </div>

            <div className="ttGrid">
              <div><small>Paper result</small><strong>{fmtSol(trade.paper.pnlSol)}</strong><p>{trade.paper.exitReason ?? "Still open or unavailable"}</p></div>
              <div><small>Actual live result</small><strong>{fmtSol(trade.live.pnlSol)}</strong><p>{trade.live.proceedsSol != null ? `${trade.live.proceedsSol.toFixed(4)} SOL received` : "No completed live sell"}</p></div>
              <div><small>Paper vs live difference</small><strong>{fmtSol(trade.differenceSol)}</strong><p>Negative means live execution performed worse.</p></div>
              <div><small>Live requested size</small><strong>{trade.live.requestedSizeSol == null ? "—" : `${trade.live.requestedSizeSol} SOL`}</strong><p>Compared using the real trade size.</p></div>
            </div>

            <div className="ttLinks">
              {trade.mint && <a href={chartUrl(trade.mint)} target="_blank" rel="noreferrer">Open chart</a>}
              {trade.live.buyTx && <a href={txUrl(trade.live.buyTx)} target="_blank" rel="noreferrer">Buy transaction</a>}
              {trade.live.sellTx && <a href={txUrl(trade.live.sellTx)} target="_blank" rel="noreferrer">Sell transaction</a>}
            </div>
          </div>}
        </article>;
      })}
      {!trades.length && <div className="ttEmpty">No trades match this filter.</div>}
    </section>
  </main>;
}
