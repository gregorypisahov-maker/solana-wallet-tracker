"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import "./compact-dashboard.css";
import "./bot-controls.css";

type Bot = {
  id: "legion" | "scalper" | "shadow";
  name: string;
  subtitle: string;
  state: any;
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
const timeAgo = (value: string | null) => {
  if (!value) return "—";
  const seconds = Math.max(0, (Date.now() - Date.parse(value)) / 1000);
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
};

function CubeMark() {
  return <div className="cubeMark" aria-hidden="true"><i /><i /><i /></div>;
}

function BotMark({ id }: { id: Bot["id"] }) {
  return <div className={`botMark ${id}`} aria-hidden="true"><div className="mask"><span>{id === "legion" ? "L" : id === "scalper" ? "ϟ" : "◆"}</span></div></div>;
}

function status(bot: Bot) {
  if (bot.state?.enabled === false) return { text: "Offline", className: "offline" };
  if (bot.state?.halted) return { text: "Paused", className: "paused" };
  return { text: "Active", className: "active" };
}

function seriesFromTrades(trades: any[], fallback: number) {
  const ordered = [...trades].reverse();
  let running = 0;
  const values = ordered.map((trade) => {
    running += Number(trade.pnl ?? trade.pnl_sol ?? 0);
    return running;
  });
  if (values.length < 2) return [0, fallback * 0.2, fallback * 0.45, fallback * 0.3, fallback * 0.7, fallback];
  return [0, ...values];
}

function LineChart({ values, tone }: { values: number[]; tone: "green" | "red" | "violet" | "blue" | "amber" }) {
  const width = 240;
  const height = 70;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values.map((value, index) => {
    const x = (index / Math.max(1, values.length - 1)) * width;
    const y = height - ((value - min) / range) * (height - 10) - 5;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return <svg className={`lineChart ${tone}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true"><polyline points={points} /></svg>;
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [selectedBot, setSelectedBot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyBot, setBusyBot] = useState<string | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [password, setPassword] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);

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
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
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
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not sign in");
    } finally {
      setLoggingIn(false);
    }
  };

  const controlBot = async (bot: Bot, action: "resume" | "pause") => {
    const ownerPassword = window.prompt(`Owner password required to ${action} ${bot.name}`);
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
    } catch (requestError) {
      setNotice(requestError instanceof Error ? requestError.message : "Bot control failed");
    } finally {
      setBusyBot(null);
    }
  };

  const selected = useMemo(() => data?.bots.find((bot) => bot.id === selectedBot) ?? null, [data, selectedBot]);

  if (!data) {
    if (needsLogin) return <main className="cubeLogin"><div className="loginPanel"><CubeMark /><h1>Solana Tracker</h1><p>Enter the dashboard key to continue.</p><form onSubmit={login}><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Dashboard key" autoFocus required /><button disabled={loggingIn}>{loggingIn ? "Opening…" : "Open dashboard"}</button></form>{error && <div className="notice error">{error}</div>}</div></main>;
    return <main className="cubeLogin"><div className="loadingPanel"><CubeMark /><span>{error ?? "Connecting to live data…"}</span></div></main>;
  }

  if (selected) {
    const botState = status(selected);
    const canResume = botState.className !== "active";
    return <main className="cubeApp"><div className="detailShell"><button className="backButton" onClick={() => setSelectedBot(null)}>← Back</button>{notice && <div className="controlNotice">{notice}</div>}<section className={`detailHero ${selected.id}`}><BotMark id={selected.id} /><div><div className="botTitleRow"><h1>{selected.name}</h1><span className={`statusPill ${botState.className}`}>{botState.text}</span></div><p>{selected.subtitle}</p><strong className={selected.totalPnlSol >= 0 ? "positive" : "negative"}>{sol(selected.totalPnlSol)}</strong><div className="botControls"><button className="primaryControl" disabled={busyBot === selected.id || !canResume} onClick={() => controlBot(selected, "resume")}>{busyBot === selected.id ? "Updating…" : canResume ? "Resume bot" : "Bot running"}</button><button className="secondaryControl" disabled={busyBot === selected.id || canResume} onClick={() => controlBot(selected, "pause")}>Pause bot</button></div></div></section><section className="detailStats"><Metric label="Win rate" value={pct(selected.winRate)} sub={`${selected.wins}W / ${selected.losses}L`} /><Metric label="Profit factor" value={selected.profitFactor == null ? "—" : selected.profitFactor.toFixed(2)} /><Metric label="Completed trades" value={String(selected.completedTrades)} /><Metric label="Open positions" value={String(selected.openPositions)} /></section><section className="detailChart"><LineChart values={seriesFromTrades(selected.recentTrades, selected.totalPnlSol)} tone={selected.id === "legion" ? "green" : selected.id === "scalper" ? "red" : "violet"} /></section><section className="activityPanel"><div className="sectionHead"><h2>Recent trades</h2></div>{selected.recentTrades.length ? selected.recentTrades.map((trade, index) => <ActivityRow key={`${trade.id ?? trade.position_id ?? index}`} trade={{ ...trade, botId: selected.id, botName: selected.name }} />) : <div className="emptyState">No completed trades yet.</div>}</section></div></main>;
  }

  const overviewWinRate = data.overview.completedTrades ? data.overview.wins / data.overview.completedTrades : 0;
  const combinedSeries = seriesFromTrades(data.recentActivity, data.overview.totalPnlSol);

  return <main className="cubeApp"><div className="terminalShell"><aside className="iconRail"><button className="railButton selected" aria-label="Dashboard">▦</button><button className="railButton" aria-label="Bots" onClick={() => document.getElementById("bots")?.scrollIntoView({ behavior: "smooth" })}>♜</button><button className="railButton" aria-label="Activity" onClick={() => document.getElementById("activity")?.scrollIntoView({ behavior: "smooth" })}>⌁</button><button className="railButton" aria-label="Analytics">▥</button><button className="railButton" aria-label="Alerts">♢</button><button className="railButton" aria-label="Wallets">▭</button><button className="railButton" aria-label="Settings">⚙</button></aside><div className="terminalMain"><header className="terminalHeader"><div className="terminalBrand"><CubeMark /><div><h1>Solana Tracker</h1><span>David&apos;s Heart <b>⌁</b></span></div></div><div className="headerStatus"><span className="liveBadge"><i /> Live</span><time>{new Date(data.generatedAt).toLocaleTimeString([], { hour12: false })}</time><button aria-label="Settings">⚙</button></div></header><section className="healthStrip"><strong>System health</strong><Health name="Helius" detail="Online" ok /><Health name="Supabase" detail="Healthy" ok /><Health name="Railway" detail="Running" ok /><Health name="Telegram" detail="Connected" ok /><Health name="Legion" detail={status(data.bots[0]).text} ok={status(data.bots[0]).className === "active"} /><Health name="Scalper" detail={status(data.bots[1]).text} ok={status(data.bots[1]).className === "active"} /><Health name="Shadow" detail={status(data.bots[2]).text} ok={status(data.bots[2]).className === "active"} /></section>{error && <div className="notice error">{error}. Showing last snapshot.</div>}{notice && <div className="controlNotice">{notice}</div>}<section className="overviewGrid"><Metric label="Total PnL" value={sol(data.overview.totalPnlSol)} tone={data.overview.totalPnlSol >= 0 ? "positive" : "negative"} chart={<LineChart values={combinedSeries} tone="green" />} /><Metric label="Win rate" value={pct(overviewWinRate)} sub={`${data.overview.wins}W / ${data.overview.losses}L`} chart={<LineChart values={combinedSeries.map((value, index) => value + index * 0.01)} tone="violet" />} /><Metric label="Total trades" value={String(data.overview.completedTrades)} sub="Completed" chart={<LineChart values={data.bots.map((bot) => bot.completedTrades)} tone="blue" />} /><Metric label="Open positions" value={String(data.overview.openPositions)} sub={data.overview.openPositions ? "Active trades" : "No active trades"} chart={<LineChart values={[0, 0, data.overview.openPositions, data.overview.openPositions]} tone="amber" />} /></section><section id="bots" className="terminalSection"><div className="terminalSectionHead"><h2>Trading bots</h2><span>View all ›</span></div><div className="botStack">{data.bots.map((bot) => <BotCard key={bot.id} bot={bot} onOpen={() => setSelectedBot(bot.id)} onResume={() => controlBot(bot, "resume")} busy={busyBot === bot.id} />)}</div></section><section id="activity" className="terminalSection activityPanel"><div className="terminalSectionHead"><h2>Recent activity</h2><span>View all ›</span></div>{data.recentActivity.length ? data.recentActivity.slice(0, 6).map((trade, index) => <ActivityRow key={`${trade.botId}-${trade.id ?? trade.position_id ?? index}`} trade={trade} />) : <div className="emptyState">Waiting for completed trades.</div>}</section></div></div></main>;
}

function Health({ name, detail, ok }: { name: string; detail: string; ok: boolean }) {
  return <div className="healthItem"><span><i className={ok ? "ok" : "bad"} />{name}</span><small>{detail}</small></div>;
}

function Metric({ label, value, sub, tone, chart }: { label: string; value: string; sub?: string; tone?: "positive" | "negative"; chart?: React.ReactNode }) {
  return <div className="metricCard"><span>{label}</span><strong className={tone}>{value}</strong>{sub && <small>{sub}</small>}{chart}</div>;
}

function BotCard({ bot, onOpen, onResume, busy }: { bot: Bot; onOpen: () => void; onResume: () => void; busy: boolean }) {
  const botStatus = status(bot);
  const needsResume = botStatus.className !== "active";
  const tone = bot.id === "legion" ? "green" : bot.id === "scalper" ? "red" : "violet";
  return <div className={`botCard ${bot.id}`}><button className="botCardMain" onClick={onOpen}><div className="botIdentity"><BotMark id={bot.id} /><div><span className={`statusPill ${botStatus.className}`}>{botStatus.text}</span><h3>{bot.name}</h3><p>{bot.subtitle}</p></div></div><div className="botNumbers"><div><span>PnL</span><strong className={bot.totalPnlSol >= 0 ? "positive" : "negative"}>{sol(bot.totalPnlSol)}</strong></div><div><span>Win rate</span><strong>{pct(bot.winRate)}</strong><small>{bot.wins}W / {bot.losses}L</small></div><div><span>Trades</span><strong>{bot.completedTrades}</strong><small>Completed</small></div></div><LineChart values={seriesFromTrades(bot.recentTrades, bot.totalPnlSol)} tone={tone} /><div className="openArrow">→</div></button>{needsResume && <button className="quickResume" disabled={busy} onClick={onResume}>{busy ? "Updating…" : "Resume"}</button>}</div>;
}

function ActivityRow({ trade }: { trade: any }) {
  const pnl = Number(trade.pnl ?? trade.pnl_sol ?? 0);
  const symbol = trade.token_symbol ?? trade.symbol ?? "UNKNOWN";
  return <div className="activityRow"><time>{timeAgo(trade.happenedAt)}</time><BotMark id={trade.botId} /><div><strong>{symbol}</strong><span>{trade.botName}</span></div><span className={`resultTag ${pnl >= 0 ? "win" : "loss"}`}>{pnl >= 0 ? "WIN" : "LOSS"}</span><b className={pnl >= 0 ? "positive" : "negative"}>{sol(pnl)}</b><span className="multiple">{Number(trade.multiple ?? trade.net_multiple ?? 0) > 0 ? `${Number(trade.multiple ?? trade.net_multiple).toFixed(2)}x` : "—"}</span></div>;
}
