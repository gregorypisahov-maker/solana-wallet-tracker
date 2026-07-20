"use client";

import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import "./compact-dashboard.css";

type BotId = "legion" | "scalper" | "shadow";
type Bot = {
  id: BotId;
  name: string;
  subtitle: string;
  state: any;
  lastScanAt: string | null;
  openPositions: number;
  completedTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number | null;
  totalPnlSol: number;
  recentTrades: any[];
};
type DashboardData = {
  generatedAt: string;
  bots: Bot[];
  overview: { totalPnlSol: number; completedTrades: number; wins: number; losses: number; openPositions: number };
  recentActivity: any[];
};

const sol = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(3)} SOL`;
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const ageSeconds = (value: string | null | undefined, now: number) => value ? Math.max(0, Math.floor((now - Date.parse(value)) / 1000)) : Infinity;
const ageText = (value: string | null | undefined, now: number) => {
  const seconds = ageSeconds(value, now);
  if (!Number.isFinite(seconds)) return "No scan yet";
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
};

function status(bot: Bot) {
  if (bot.state?.enabled === false) return { text: "Offline", className: "offline" };
  if (bot.state?.halted) return { text: "Paused", className: "paused" };
  return { text: "Active", className: "active" };
}

function seriesFromTrades(trades: any[], fallback: number) {
  const ordered = [...trades].reverse();
  let running = 0;
  const values = ordered.map((trade) => running += Number(trade.pnl ?? trade.pnl_sol ?? 0));
  return values.length > 1 ? [0, ...values] : [0, fallback];
}

function LineChart({ values, tone }: { values: number[]; tone: BotId | "overview" }) {
  const width = 300;
  const height = 72;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values.map((value, index) => {
    const x = (index / Math.max(1, values.length - 1)) * width;
    const y = height - ((value - min) / range) * (height - 12) - 6;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return <svg className={`miniChart ${tone}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true"><polyline points={points} /></svg>;
}

function BotIcon({ id }: { id: BotId }) {
  if (id === "legion") return <div className="botIcon legion"><span>Ｌ</span></div>;
  if (id === "scalper") return <div className="botIcon scalper"><span>ϟ</span></div>;
  return <div className="botIcon shadow"><span>◆</span></div>;
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [selectedBot, setSelectedBot] = useState<BotId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyBot, setBusyBot] = useState<string | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [password, setPassword] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/compact-dashboard", { cache: "no-store" });
      if (response.status === 401) { setNeedsLogin(true); setData(null); return; }
      if (!response.ok) throw new Error("Could not load live dashboard data");
      setData(await response.json());
      setNeedsLogin(false);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not load dashboard");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const refreshTimer = window.setInterval(() => void refresh(), 10_000);
    const clockTimer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { window.clearInterval(refreshTimer); window.clearInterval(clockTimer); };
  }, [refresh]);

  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoggingIn(true);
    setError(null);
    try {
      const response = await fetch("/api/viewer-login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? "Could not sign in");
      setPassword("");
      await refresh();
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Could not sign in");
    } finally {
      setLoggingIn(false);
    }
  };

  const controlBot = async (bot: Bot, action: "resume" | "pause") => {
    const ownerPassword = window.prompt(`Password required to ${action} ${bot.name}`);
    if (!ownerPassword) return;
    setBusyBot(bot.id);
    setNotice(null);
    try {
      const authorization = `Basic ${window.btoa(`owner:${ownerPassword}`)}`;
      const response = await fetch("/api/bot-control", { method: "POST", headers: { "Content-Type": "application/json", Authorization: authorization }, body: JSON.stringify({ bot: bot.id, action }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? `Could not ${action} bot`);
      setNotice(`${bot.name} ${action === "resume" ? "resumed" : "paused"}.`);
      await refresh();
    } catch (controlError) {
      setNotice(controlError instanceof Error ? controlError.message : "Bot control failed");
    } finally {
      setBusyBot(null);
    }
  };

  const selected = useMemo(() => data?.bots.find((bot) => bot.id === selectedBot) ?? null, [data, selectedBot]);

  if (!data) {
    if (needsLogin) return <main className="appLogin"><div className="loginCard"><div className="appLogo">S</div><h1>Solana Tracker</h1><p>Enter your dashboard password.</p><form onSubmit={login}><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password" autoFocus required /><button disabled={loggingIn}>{loggingIn ? "Opening…" : "Open dashboard"}</button></form>{error && <div className="message error">{error}</div>}</div></main>;
    return <main className="appLogin"><div className="loginCard"><div className="appLogo">S</div><p>{error ?? "Connecting to live data…"}</p></div></main>;
  }

  const dashboardLive = ageSeconds(data.generatedAt, now) < 25;

  if (selected) {
    const selectedStatus = status(selected);
    const canResume = selectedStatus.className !== "active";
    return <main className="friendlyApp"><div className="appShell detailPage"><button className="backLink" onClick={() => setSelectedBot(null)}>← Back</button>{notice && <div className="message success">{notice}</div>}<section className={`detailHeader ${selected.id}`}><BotIcon id={selected.id}/><div className="detailTitle"><div className="titleRow"><h1>{selected.name}</h1><span className={`statusBadge ${selectedStatus.className}`}>{selectedStatus.text}</span></div><p>{selected.subtitle}</p><span className="scanText">Last scan {ageText(selected.lastScanAt, now)}</span></div><strong className={selected.totalPnlSol >= 0 ? "positive" : "negative"}>{sol(selected.totalPnlSol)}</strong></section><section className="detailChart"><LineChart values={seriesFromTrades(selected.recentTrades, selected.totalPnlSol)} tone={selected.id}/></section><section className="detailStats"><Metric label="Win rate" value={pct(selected.winRate)} sub={`${selected.wins}W / ${selected.losses}L`}/><Metric label="Profit factor" value={selected.profitFactor == null ? "—" : selected.profitFactor.toFixed(2)}/><Metric label="Completed trades" value={String(selected.completedTrades)}/><Metric label="Open positions" value={String(selected.openPositions)}/></section><div className="controlRow"><button className="primaryButton" disabled={busyBot === selected.id || !canResume} onClick={() => controlBot(selected, "resume")}>{busyBot === selected.id ? "Updating…" : canResume ? "Resume bot" : "Bot running"}</button><button className="secondaryButton" disabled={busyBot === selected.id || canResume} onClick={() => controlBot(selected, "pause")}>Pause bot</button></div><section className="activitySection"><div className="sectionTitle"><h2>Recent trades</h2></div>{selected.recentTrades.length ? selected.recentTrades.map((trade, index) => <ActivityRow key={`${trade.id ?? trade.position_id ?? index}`} trade={{ ...trade, botId: selected.id, botName: selected.name }} now={now}/>) : <div className="emptyState">No completed trades yet.</div>}</section></div></main>;
  }

  const overviewWinRate = data.overview.completedTrades ? data.overview.wins / data.overview.completedTrades : 0;
  const combined = seriesFromTrades(data.recentActivity, data.overview.totalPnlSol);

  return <main className="friendlyApp"><div className="appShell"><header className="appHeader"><div><p className="eyebrow">David&apos;s Heart</p><h1>Solana Tracker</h1></div><div className="liveCluster"><span className={`liveDot ${dashboardLive ? "" : "stale"}`}/><div><strong>{dashboardLive ? "Live" : "Stale"}</strong><small>{ageText(data.generatedAt, now)}</small></div><time>{new Date(now).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit" })}</time></div></header>{error && <div className="message error">{error}. Showing the last snapshot.</div>}{notice && <div className="message success">{notice}</div>}<section className="summaryGrid"><SummaryCard label="Total PnL" value={sol(data.overview.totalPnlSol)} tone={data.overview.totalPnlSol >= 0 ? "positive" : "negative"}/><SummaryCard label="Win rate" value={pct(overviewWinRate)} sub={`${data.overview.wins}W / ${data.overview.losses}L`}/><SummaryCard label="Open positions" value={String(data.overview.openPositions)} sub={`${data.overview.completedTrades} completed trades`}/></section><section className="overviewChart"><div><h2>Overall performance</h2><p>Recent combined results</p></div><LineChart values={combined} tone="overview"/></section><section className="botsSection"><div className="sectionTitle"><h2>Your bots</h2><span>Updates every 10 seconds</span></div><div className="botList">{data.bots.map((bot) => <BotCard key={bot.id} bot={bot} onOpen={() => setSelectedBot(bot.id)} onResume={() => controlBot(bot, "resume")} busy={busyBot === bot.id} now={now}/>)}</div></section><section className="activitySection"><div className="sectionTitle"><h2>Recent activity</h2></div>{data.recentActivity.length ? data.recentActivity.slice(0, 6).map((trade, index) => <ActivityRow key={`${trade.botId}-${trade.id ?? trade.position_id ?? index}`} trade={trade} now={now}/>) : <div className="emptyState">Waiting for completed trades.</div>}</section></div></main>;
}

function SummaryCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "positive" | "negative" }) {
  return <div className="summaryCard"><span>{label}</span><strong className={tone}>{value}</strong>{sub && <small>{sub}</small>}</div>;
}
function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <div className="metricCard"><span>{label}</span><strong>{value}</strong>{sub && <small>{sub}</small>}</div>;
}
function BotCard({ bot, onOpen, onResume, busy, now }: { bot: Bot; onOpen: () => void; onResume: () => void; busy: boolean; now: number }) {
  const botStatus = status(bot);
  const needsResume = botStatus.className !== "active";
  return <article className={`friendlyBotCard ${bot.id}`}><button className="botOpen" onClick={onOpen}><BotIcon id={bot.id}/><div className="botCopy"><div className="botTopLine"><h3>{bot.name}</h3><span className={`statusBadge ${botStatus.className}`}>{botStatus.text}</span></div><p>{bot.subtitle}</p><div className="botMeta"><span className={bot.totalPnlSol >= 0 ? "positive" : "negative"}>{sol(bot.totalPnlSol)}</span><span>{pct(bot.winRate)} win rate</span><span>Scan {ageText(bot.lastScanAt, now)}</span></div></div><div className="botChart"><LineChart values={seriesFromTrades(bot.recentTrades, bot.totalPnlSol)} tone={bot.id}/></div><span className="chevron">›</span></button>{needsResume && <button className="resumeButton" disabled={busy} onClick={onResume}>{busy ? "Updating…" : "Resume"}</button>}</article>;
}
function ActivityRow({ trade, now }: { trade: any; now: number }) {
  const pnl = Number(trade.pnl ?? trade.pnl_sol ?? 0);
  const symbol = trade.token_symbol ?? trade.symbol ?? "UNKNOWN";
  return <div className="activityRow"><BotIcon id={trade.botId}/><div><strong>{symbol}</strong><span>{trade.botName} · {ageText(trade.happenedAt, now)}</span></div><b className={pnl >= 0 ? "positive" : "negative"}>{sol(pnl)}</b></div>;
}
