"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import "./compact-dashboard.css";

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
  overview: {
    totalPnlSol: number;
    completedTrades: number;
    wins: number;
    losses: number;
    openPositions: number;
  };
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
  return <div className={`botMark ${id}`} aria-hidden="true"><span>{id === "legion" ? "L" : id === "scalper" ? "S" : "Ø"}</span></div>;
}

function status(bot: Bot) {
  if (!bot.state?.enabled) return { text: "Offline", className: "offline" };
  if (bot.state?.halted) return { text: "Paused", className: "paused" };
  return { text: "Active", className: "active" };
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [selectedBot, setSelectedBot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [password, setPassword] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/compact-dashboard", { cache: "no-store" });
      if (response.status === 401) {
        setNeedsLogin(true);
        setData(null);
        return;
      }
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
      const response = await fetch("/api/viewer-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
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

  const selected = useMemo(() => data?.bots.find((bot) => bot.id === selectedBot) ?? null, [data, selectedBot]);

  if (!data) {
    if (needsLogin) {
      return <main className="cubeLogin"><div className="loginPanel"><CubeMark /><div><span className="micro">PRIVATE DASHBOARD</span><h1>Solana Tracker</h1><p>Enter the dashboard key to continue.</p></div><form onSubmit={login}><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Dashboard key" autoFocus required /><button disabled={loggingIn}>{loggingIn ? "Opening…" : "Open dashboard"}</button></form>{error && <div className="notice error">{error}</div>}</div></main>;
    }
    return <main className="cubeLogin"><div className="loadingPanel"><CubeMark /><span>{error ?? "Connecting to live data…"}</span></div></main>;
  }

  if (selected) {
    const state = status(selected);
    return <main className="cubeApp"><div className="detailShell"><button className="backButton" onClick={() => setSelectedBot(null)}>← Back</button><section className={`detailHero ${selected.id}`}><BotMark id={selected.id} /><div><div className="botTitleRow"><h1>{selected.name}</h1><span className={`statusPill ${state.className}`}>{state.text}</span></div><p>{selected.subtitle}</p><strong className={selected.totalPnlSol >= 0 ? "positive" : "negative"}>{sol(selected.totalPnlSol)}</strong></div></section><section className="detailStats"><Metric label="Win rate" value={pct(selected.winRate)} sub={`${selected.wins}W / ${selected.losses}L`} /><Metric label="Profit factor" value={selected.profitFactor == null ? "—" : selected.profitFactor.toFixed(2)} /><Metric label="Completed trades" value={String(selected.completedTrades)} /><Metric label="Open positions" value={String(selected.openPositions)} /></section><section className="activityPanel"><div className="sectionHead"><h2>Recent trades</h2><span>Latest activity</span></div>{selected.recentTrades.length ? selected.recentTrades.map((trade, index) => <ActivityRow key={`${trade.id ?? trade.position_id ?? index}`} trade={{ ...trade, botId: selected.id, botName: selected.name }} />) : <div className="emptyState">No completed trades yet.</div>}</section></div></main>;
  }

  const overviewWinRate = data.overview.completedTrades ? data.overview.wins / data.overview.completedTrades : 0;

  return <main className="cubeApp"><div className="appShell"><aside className="sideRail"><div className="brand"><CubeMark /><div><strong>Solana Tracker</strong><span>Live paper trading</span></div></div><nav><button className="selected">Overview</button><button onClick={() => document.getElementById("bots")?.scrollIntoView({ behavior: "smooth" })}>Bots</button><button onClick={() => document.getElementById("activity")?.scrollIntoView({ behavior: "smooth" })}>Activity</button></nav><div className="systemBox"><span><i /> Systems online</span><small>Updated {new Date(data.generatedAt).toLocaleTimeString()}</small></div></aside><div className="mainPanel"><header className="mainHeader"><div><span className="micro">LIVE DASHBOARD</span><h1>Overview</h1><p>Simple performance view across all trading strategies.</p></div><div className="liveBadge"><i /> Live</div></header>{error && <div className="notice error">{error}. Showing the last successful snapshot.</div>}<section className="overviewGrid"><Metric label="Total PnL" value={sol(data.overview.totalPnlSol)} tone={data.overview.totalPnlSol >= 0 ? "positive" : "negative"} /><Metric label="Win rate" value={pct(overviewWinRate)} sub={`${data.overview.wins}W / ${data.overview.losses}L`} /><Metric label="Completed trades" value={String(data.overview.completedTrades)} /><Metric label="Open positions" value={String(data.overview.openPositions)} /></section><section id="bots"><div className="sectionHead"><div><span className="micro">TRADING BOTS</span><h2>Your bots</h2></div><span>Tap a bot for details</span></div><div className="botStack">{data.bots.map((bot) => <BotCard key={bot.id} bot={bot} onOpen={() => setSelectedBot(bot.id)} />)}</div></section><section id="activity" className="activityPanel"><div className="sectionHead"><div><span className="micro">RECENT ACTIVITY</span><h2>Latest trades</h2></div><span>{data.recentActivity.length} shown</span></div>{data.recentActivity.length ? data.recentActivity.map((trade, index) => <ActivityRow key={`${trade.botId}-${trade.id ?? trade.position_id ?? index}`} trade={trade} />) : <div className="emptyState">Waiting for completed trades.</div>}</section><footer>View-only paper trading dashboard. No wallet execution.</footer></div></div></main>;
}

function Metric({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "positive" | "negative" }) {
  return <div className="metricCard"><span>{label}</span><strong className={tone}>{value}</strong>{sub && <small>{sub}</small>}<i className="metricLine" /></div>;
}

function BotCard({ bot, onOpen }: { bot: Bot; onOpen: () => void }) {
  const botStatus = status(bot);
  return <button className={`botCard ${bot.id}`} onClick={onOpen}><div className="botIdentity"><BotMark id={bot.id} /><div><span className={`statusPill ${botStatus.className}`}>{botStatus.text}</span><h3>{bot.name}</h3><p>{bot.subtitle}</p></div></div><div className="botPnl"><strong className={bot.totalPnlSol >= 0 ? "positive" : "negative"}>{sol(bot.totalPnlSol)}</strong><span>{bot.completedTrades} trades</span></div><div className="botStats"><div><span>Win rate</span><b>{pct(bot.winRate)}</b></div><div><span>Profit factor</span><b>{bot.profitFactor == null ? "—" : bot.profitFactor.toFixed(2)}</b></div><div><span>Open</span><b>{bot.openPositions}</b></div></div><div className="openArrow">→</div></button>;
}

function ActivityRow({ trade }: { trade: any }) {
  const pnl = Number(trade.pnl ?? trade.pnl_sol ?? 0);
  const symbol = trade.token_symbol ?? trade.symbol ?? "UNKNOWN";
  return <div className="activityRow"><BotMark id={trade.botId} /><div><strong>{symbol}</strong><span>{trade.botName}</span></div><span className={`resultTag ${pnl >= 0 ? "win" : "loss"}`}>{pnl >= 0 ? "WIN" : "LOSS"}</span><b className={pnl >= 0 ? "positive" : "negative"}>{sol(pnl)}</b><time>{timeAgo(trade.happenedAt)}</time></div>;
}
