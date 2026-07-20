"use client";

import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import "./compact-dashboard.css";

type BotId = "legion" | "scalper" | "shadow";
type View = "overview" | "bots" | "trades" | "wallets" | "analytics";
type Bot = {
  id: BotId; name: string; subtitle: string; version: string; state: any;
  lastScanAt: string | null; openPositions: number; positions: any[];
  completedTrades: number; wins: number; losses: number; winRate: number;
  profitFactor: number | null; totalPnlSol: number; bankrollSol: number;
  startingBankrollSol: number; maxDrawdownSol: number; recentTrades: any[]; scans?: any[];
};
type DashboardData = {
  generatedAt: string; bots: Bot[];
  overview: { totalPnlSol: number; totalEquitySol: number; completedTrades: number; wins: number; losses: number; openPositions: number; profitFactor: number | null };
  recentActivity: any[]; wallets: any[]; walletPerformance: any[]; tokenScores: any[];
  readiness: any; adaptive: any; usage: any; discoveryRuns: any[];
};

const sol = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(3)} SOL`;
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const short = (value: string | null | undefined) => value ? `${value.slice(0, 5)}…${value.slice(-4)}` : "—";
const ageSeconds = (value: string | null | undefined, now: number) => value ? Math.max(0, Math.floor((now - Date.parse(value)) / 1000)) : Infinity;
const ageText = (value: string | null | undefined, now: number) => {
  const seconds = ageSeconds(value, now);
  if (!Number.isFinite(seconds)) return "No data";
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
};

function botStatus(bot: Bot) {
  if (bot.state?.enabled === false) return { label: "Offline", tone: "offline" };
  if (bot.state?.halted) return { label: "Paused", tone: "paused" };
  return { label: "Active", tone: "active" };
}

function equitySeries(trades: any[], fallback = 0) {
  const ordered = [...trades].reverse();
  let running = 0;
  const values = ordered.map((trade) => running += Number(trade.pnl ?? trade.pnl_sol ?? 0));
  return values.length > 1 ? [0, ...values] : [0, fallback];
}

function Chart({ values, tone = "green", large = false }: { values: number[]; tone?: string; large?: boolean }) {
  const width = 600; const height = large ? 180 : 68;
  const min = Math.min(...values); const max = Math.max(...values); const range = max - min || 1;
  const points = values.map((value, index) => {
    const x = (index / Math.max(1, values.length - 1)) * width;
    const y = height - ((value - min) / range) * (height - 18) - 9;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return <svg className={`platformChart ${tone} ${large ? "large" : ""}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true"><polyline points={points}/></svg>;
}

function BotIcon({ id }: { id: BotId }) {
  return <div className={`botGlyph ${id}`}>{id === "legion" ? "L" : id === "scalper" ? "ϟ" : "◆"}</div>;
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [view, setView] = useState<View>("overview");
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
      setData(await response.json()); setNeedsLogin(false); setError(null);
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Could not load dashboard"); }
  }, []);

  useEffect(() => {
    void refresh();
    const refreshTimer = window.setInterval(() => void refresh(), 10_000);
    const clockTimer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { window.clearInterval(refreshTimer); window.clearInterval(clockTimer); };
  }, [refresh]);

  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setLoggingIn(true); setError(null);
    try {
      const response = await fetch("/api/viewer-login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? "Could not sign in");
      setPassword(""); await refresh();
    } catch (loginError) { setError(loginError instanceof Error ? loginError.message : "Could not sign in"); }
    finally { setLoggingIn(false); }
  };

  const controlBot = async (bot: Bot, action: "resume" | "pause") => {
    const ownerPassword = window.prompt(`Password required to ${action} ${bot.name}`);
    if (!ownerPassword) return;
    setBusyBot(bot.id); setNotice(null);
    try {
      const authorization = `Basic ${window.btoa(`owner:${ownerPassword}`)}`;
      const response = await fetch("/api/bot-control", { method: "POST", headers: { "Content-Type": "application/json", Authorization: authorization }, body: JSON.stringify({ bot: bot.id, action }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? `Could not ${action} bot`);
      setNotice(`${bot.name} ${action === "resume" ? "resumed" : "paused"}.`); await refresh();
    } catch (controlError) { setNotice(controlError instanceof Error ? controlError.message : "Bot control failed"); }
    finally { setBusyBot(null); }
  };

  const selected = useMemo(() => data?.bots.find((bot) => bot.id === selectedBot) ?? null, [data, selectedBot]);

  if (!data) {
    if (needsLogin) return <main className="platformLogin"><div className="loginPanel"><div className="productMark">S</div><div><h1>Solana Tracker</h1><p>Private trading intelligence platform</p></div><form onSubmit={login}><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Dashboard password" autoFocus required/><button disabled={loggingIn}>{loggingIn ? "Opening…" : "Open platform"}</button></form>{error && <div className="toast error">{error}</div>}</div></main>;
    return <main className="platformLogin"><div className="loadingPanel"><div className="heartPulse"><span>♥</span></div><div><strong>David&apos;s Heart</strong><p>{error ?? "Connecting to live systems…"}</p></div></div></main>;
  }

  const dashboardLive = ageSeconds(data.generatedAt, now) < 25;
  const overviewWinRate = data.overview.completedTrades ? data.overview.wins / data.overview.completedTrades : 0;
  const combinedSeries = equitySeries(data.recentActivity, data.overview.totalPnlSol);

  if (selected) return <BotDetail bot={selected} now={now} onBack={() => setSelectedBot(null)} onControl={controlBot} busy={busyBot === selected.id} notice={notice}/>;

  return <main className="platformApp">
    <aside className="platformSidebar">
      <div className="brandBlock"><div className="productMark">S</div><div><strong>Solana Tracker</strong><span>Trading Intelligence</span></div></div>
      <nav>{(["overview","bots","trades","wallets","analytics"] as View[]).map((item) => <button key={item} className={view === item ? "active" : ""} onClick={() => setView(item)}><span>{item === "overview" ? "⌂" : item === "bots" ? "◈" : item === "trades" ? "⇄" : item === "wallets" ? "◉" : "⌁"}</span>{item[0].toUpperCase() + item.slice(1)}</button>)}</nav>
      <div className="sidebarFoot"><span className={`systemDot ${dashboardLive ? "" : "stale"}`}/><div><strong>{dashboardLive ? "All systems live" : "Connection stale"}</strong><small>Updated {ageText(data.generatedAt, now)}</small></div></div>
    </aside>

    <section className="platformMain">
      <header className="platformTopbar"><div><p>Workspace</p><h1>{view[0].toUpperCase() + view.slice(1)}</h1></div><div className="topbarRight"><div className="livePill"><span className={`systemDot ${dashboardLive ? "" : "stale"}`}/>{dashboardLive ? "Live" : "Stale"}</div><time>{new Date(now).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></div></header>
      {error && <div className="toast error">{error}. Showing last snapshot.</div>}{notice && <div className="toast success">{notice}</div>}
      {view === "overview" && <Overview data={data} overviewWinRate={overviewWinRate} combinedSeries={combinedSeries} now={now} onBot={(id) => setSelectedBot(id)} onControl={controlBot} busyBot={busyBot}/>}      
      {view === "bots" && <BotsView bots={data.bots} now={now} onOpen={setSelectedBot} onControl={controlBot} busyBot={busyBot}/>}      
      {view === "trades" && <TradesView trades={data.recentActivity}/>}      
      {view === "wallets" && <WalletsView wallets={data.wallets} performance={data.walletPerformance}/>}      
      {view === "analytics" && <AnalyticsView data={data}/>}      
    </section>

    <nav className="mobileNav">{(["overview","bots","trades","wallets","analytics"] as View[]).map((item) => <button key={item} className={view === item ? "active" : ""} onClick={() => setView(item)}>{item === "overview" ? "⌂" : item === "bots" ? "◈" : item === "trades" ? "⇄" : item === "wallets" ? "◉" : "⌁"}<span>{item}</span></button>)}</nav>
  </main>;
}

function Overview({ data, overviewWinRate, combinedSeries, now, onBot, onControl, busyBot }: any) {
  return <div className="viewStack"><section className="kpiGrid">
    <Kpi label="Total equity" value={`${data.overview.totalEquitySol.toFixed(3)} SOL`} sub="Across all paper strategies"/>
    <Kpi label="Total PnL" value={sol(data.overview.totalPnlSol)} tone={data.overview.totalPnlSol >= 0 ? "positive" : "negative"} sub={`${data.overview.completedTrades} completed trades`}/>
    <Kpi label="Win rate" value={pct(overviewWinRate)} sub={`${data.overview.wins} wins · ${data.overview.losses} losses`}/>
    <Kpi label="Profit factor" value={data.overview.profitFactor == null ? "—" : data.overview.profitFactor.toFixed(2)} sub={`${data.overview.openPositions} open positions`}/>
  </section>
  <section className="heroGrid"><div className="panel performancePanel"><PanelTitle title="Portfolio performance" sub="Combined realized PnL across all bots"/><Chart values={combinedSeries} tone="green" large/></div><div className="panel readinessPanel"><PanelTitle title="Live readiness" sub={data.readiness?.strategy_version ?? "Current forward test"}/><div className={`readinessScore ${data.readiness?.ready ? "ready" : "notReady"}`}>{data.readiness?.ready ? "Ready" : "Testing"}</div><dl><div><dt>Trades</dt><dd>{data.readiness?.completed_trades ?? 0}</dd></div><div><dt>Active days</dt><dd>{Number(data.readiness?.active_days ?? 0).toFixed(1)}</dd></div><div><dt>Drawdown</dt><dd>{Number(data.readiness?.max_drawdown_pct ?? 0).toFixed(1)}%</dd></div></dl></div></section>
  <section><PanelTitle title="Strategy modules" sub="Live status and current performance"/><div className="strategyGrid">{data.bots.map((bot: Bot) => <BotModule key={bot.id} bot={bot} now={now} onOpen={() => onBot(bot.id)} onControl={onControl} busy={busyBot === bot.id}/>)}</div></section>
  <section className="twoCol"><div className="panel"><PanelTitle title="Recent trades" sub="Newest completed positions"/><TradeTable trades={data.recentActivity.slice(0, 7)} compact/></div><div className="panel"><PanelTitle title="Live scanner" sub="Latest scalper scan activity"/><ScanList scans={data.bots.find((bot: Bot) => bot.id === "scalper")?.scans ?? []} now={now}/></div></section></div>;
}

function BotsView({ bots, now, onOpen, onControl, busyBot }: any) { return <div className="viewStack"><div className="pageIntro"><h2>Strategy modules</h2><p>Performance, risk state, scan freshness and controls for every bot.</p></div><div className="botsFullGrid">{bots.map((bot: Bot) => <BotModule key={bot.id} bot={bot} now={now} onOpen={() => onOpen(bot.id)} onControl={onControl} busy={busyBot === bot.id} expanded/>)}</div></div>; }
function TradesView({ trades }: { trades: any[] }) { const [query,setQuery]=useState(""); const filtered=trades.filter((t)=>`${t.token_symbol ?? t.symbol ?? ""} ${t.botName ?? ""} ${t.reason ?? t.exit_reason ?? ""}`.toLowerCase().includes(query.toLowerCase())); return <div className="viewStack"><div className="pageIntro split"><div><h2>Trade history</h2><p>Searchable completed trades across every strategy.</p></div><input className="searchInput" value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="Search token, bot or exit reason"/></div><div className="panel"><TradeTable trades={filtered}/></div></div>; }
function WalletsView({ wallets, performance }: { wallets: any[]; performance: any[] }) { const merged=wallets.map((wallet)=>({ ...wallet, perf: performance.find((p)=>p.wallet_address===wallet.address) })); return <div className="viewStack"><div className="pageIntro"><h2>Wallet intelligence</h2><p>{wallets.filter((w)=>w.active).length} active wallets · {performance.length} scored wallets</p></div><div className="panel tableWrap"><table className="dataTable"><thead><tr><th>Wallet</th><th>Status</th><th>Trust</th><th>Win rate</th><th>Profit factor</th><th>Realized PnL</th></tr></thead><tbody>{merged.slice(0,25).map((wallet)=><tr key={wallet.address}><td><strong>{wallet.label || short(wallet.address)}</strong><small>{short(wallet.address)}</small></td><td><Badge tone={wallet.active?"active":"offline"}>{wallet.management_status ?? "trial"}</Badge></td><td>{Number(wallet.perf?.trust_score ?? 0).toFixed(0)}</td><td>{Number(wallet.perf?.win_rate ?? 0).toFixed(1)}%</td><td>{wallet.perf?.profit_factor == null ? "—" : Number(wallet.perf.profit_factor).toFixed(2)}</td><td className={Number(wallet.perf?.realized_pnl_sol ?? 0)>=0?"positive":"negative"}>{sol(Number(wallet.perf?.realized_pnl_sol ?? 0))}</td></tr>)}</tbody></table></div></div>; }
function AnalyticsView({ data }: { data: DashboardData }) { return <div className="viewStack"><div className="pageIntro"><h2>Analytics</h2><p>Strategy comparison, wallet quality and monitoring health.</p></div><section className="strategyCompare">{data.bots.map((bot)=><div className="panel" key={bot.id}><div className="compareHead"><BotIcon id={bot.id}/><div><strong>{bot.name}</strong><span>{bot.version}</span></div></div><dl className="compareStats"><div><dt>PnL</dt><dd className={bot.totalPnlSol>=0?"positive":"negative"}>{sol(bot.totalPnlSol)}</dd></div><div><dt>Profit factor</dt><dd>{bot.profitFactor?.toFixed(2) ?? "—"}</dd></div><div><dt>Win rate</dt><dd>{pct(bot.winRate)}</dd></div><div><dt>Max drawdown</dt><dd>{bot.maxDrawdownSol.toFixed(3)} SOL</dd></div></dl><Chart values={equitySeries(bot.recentTrades,bot.totalPnlSol)} tone={bot.id}/></div>)}</section><section className="twoCol"><div className="panel"><PanelTitle title="Top wallets" sub="Highest trust score"/><div className="rankList">{data.walletPerformance.slice(0,8).map((wallet,index)=><div key={wallet.wallet_address}><b>{index+1}</b><span>{short(wallet.wallet_address)}</span><strong>{Number(wallet.trust_score).toFixed(0)}</strong></div>)}</div></div><div className="panel"><PanelTitle title="Monitor health" sub="Latest usage sample"/><dl className="healthStats"><div><dt>Mode</dt><dd>{data.usage?.mode ?? "—"}</dd></div><div><dt>Transactions</dt><dd>{data.usage?.transaction_requests ?? 0}</dd></div><div><dt>WebSocket events</dt><dd>{data.usage?.websocket_notifications ?? 0}</dd></div><div><dt>RPC failures</dt><dd>{data.usage?.rpc_failures ?? 0}</dd></div><div><dt>Rate limits</dt><dd>{data.usage?.rate_limit_errors ?? 0}</dd></div><div><dt>Queue peak</dt><dd>{data.usage?.max_queue_depth ?? 0}</dd></div></dl></div></section></div>; }

function BotDetail({ bot, now, onBack, onControl, busy, notice }: any) { const state=botStatus(bot); const canResume=state.tone!=="active"; return <main className="platformApp detailOnly"><section className="platformMain"><button className="backButton" onClick={onBack}>← Back to platform</button>{notice&&<div className="toast success">{notice}</div>}<div className="detailHero panel"><BotIcon id={bot.id}/><div><div className="detailName"><h1>{bot.name}</h1><Badge tone={state.tone}>{state.label}</Badge></div><p>{bot.subtitle}</p><span>{bot.version}</span></div><div className="detailPnl"><small>Total PnL</small><strong className={bot.totalPnlSol>=0?"positive":"negative"}>{sol(bot.totalPnlSol)}</strong></div></div><section className="kpiGrid"><Kpi label="Bankroll" value={`${bot.bankrollSol.toFixed(3)} SOL`} sub={`Started with ${bot.startingBankrollSol.toFixed(3)}`}/><Kpi label="Win rate" value={pct(bot.winRate)} sub={`${bot.wins}W · ${bot.losses}L`}/><Kpi label="Profit factor" value={bot.profitFactor?.toFixed(2) ?? "—"} sub={`${bot.completedTrades} completed trades`}/><Kpi label="Last scan" value={ageText(bot.lastScanAt,now)} sub={bot.state?.halt_reason ?? "No active risk halt"}/></section><section className="panel detailPerformance"><PanelTitle title="Equity curve" sub="Realized trade-by-trade performance"/><Chart values={equitySeries(bot.recentTrades,bot.totalPnlSol)} tone={bot.id} large/></section><div className="detailActions"><button className="primaryAction" disabled={busy||!canResume} onClick={()=>onControl(bot,"resume")}>{busy?"Updating…":canResume?"Resume bot":"Bot running"}</button><button className="dangerAction" disabled={busy||canResume} onClick={()=>onControl(bot,"pause")}>Pause bot</button></div><section className="twoCol"><div className="panel"><PanelTitle title="Open positions" sub={`${bot.openPositions} currently open`}/>{bot.positions.length?bot.positions.map((p:any)=><div className="positionRow" key={p.position_id??p.mint}><div><strong>{p.token_symbol}</strong><span>{short(p.mint)}</span></div><b>{Number(p.size_sol??0).toFixed(3)} SOL</b></div>):<div className="emptyState">No open positions.</div>}</div><div className="panel"><PanelTitle title="Risk state" sub="Current bot controls"/><dl className="healthStats"><div><dt>Status</dt><dd>{state.label}</dd></div><div><dt>Consecutive losses</dt><dd>{bot.state?.consecutive_losses ?? 0}</dd></div><div><dt>Open positions</dt><dd>{bot.openPositions}</dd></div><div><dt>Max drawdown</dt><dd>{bot.maxDrawdownSol.toFixed(3)} SOL</dd></div></dl></div></section><section className="panel"><PanelTitle title="Recent trades" sub="Newest completed positions"/><TradeTable trades={bot.recentTrades.map((trade:any)=>({...trade,botId:bot.id,botName:bot.name}))}/></section></section></main>; }

function BotModule({ bot, now, onOpen, onControl, busy, expanded=false }: any) { const state=botStatus(bot); return <article className={`strategyCard panel ${bot.id} ${expanded?"expanded":""}`}><div className="strategyHead"><BotIcon id={bot.id}/><div><div><h3>{bot.name}</h3><Badge tone={state.tone}>{state.label}</Badge></div><p>{bot.subtitle}</p><span>{bot.version}</span></div></div><div className="strategyNumbers"><div><small>PnL</small><strong className={bot.totalPnlSol>=0?"positive":"negative"}>{sol(bot.totalPnlSol)}</strong></div><div><small>Win rate</small><strong>{pct(bot.winRate)}</strong></div><div><small>Profit factor</small><strong>{bot.profitFactor?.toFixed(2)??"—"}</strong></div></div><Chart values={equitySeries(bot.recentTrades,bot.totalPnlSol)} tone={bot.id}/><div className="strategyFoot"><span>Last scan {ageText(bot.lastScanAt,now)}</span><div>{state.tone!=="active"&&<button className="resumeSmall" disabled={busy} onClick={()=>onControl(bot,"resume")}>{busy?"Updating…":"Resume"}</button>}<button className="openSmall" onClick={onOpen}>Open</button></div></div></article>; }
function Kpi({label,value,sub,tone}:{label:string;value:string;sub?:string;tone?:string}){return <div className="kpiCard"><span>{label}</span><strong className={tone}>{value}</strong>{sub&&<small>{sub}</small>}</div>}
function PanelTitle({title,sub}:{title:string;sub?:string}){return <div className="panelTitle"><div><h2>{title}</h2>{sub&&<p>{sub}</p>}</div></div>}
function Badge({tone,children}:{tone:string;children:ReactNode}){return <span className={`badge ${tone}`}>{children}</span>}
function ScanList({scans,now}:{scans:any[];now:number}){return <div className="scanList">{scans.slice(0,7).map((scan)=><div key={scan.id}><span className={`scanDot ${scan.status}`}/><div><strong>{scan.message?.replaceAll("_"," ")||scan.status}</strong><small>{scan.scanned_count} scanned · {scan.qualified_count} qualified</small></div><time>{ageText(scan.started_at,now)}</time></div>)}</div>}
function TradeTable({trades,compact=false}:{trades:any[];compact?:boolean}){return <div className="tableWrap"><table className="dataTable"><thead><tr><th>Token</th><th>Bot</th>{!compact&&<th>Exit reason</th>}<th>PnL</th><th>Return</th><th>Time</th></tr></thead><tbody>{trades.map((trade,index)=>{const pnl=Number(trade.pnl??trade.pnl_sol??0);const ret=Number(trade.net_return_pct??trade.gross_return_pct??((Number(trade.multiple??0)-1)*100));return <tr key={`${trade.botId}-${trade.id??trade.position_id??index}`}><td><strong>{trade.token_symbol??trade.symbol??"UNKNOWN"}</strong><small>{short(trade.mint)}</small></td><td>{trade.botName??"—"}</td>{!compact&&<td>{String(trade.reason??trade.exit_reason??"—").replaceAll("_"," ")}</td>}<td className={pnl>=0?"positive":"negative"}>{sol(pnl)}</td><td className={ret>=0?"positive":"negative"}>{Number.isFinite(ret)?`${ret>=0?"+":""}${ret.toFixed(1)}%`:"—"}</td><td>{trade.happenedAt?new Date(trade.happenedAt).toLocaleDateString():"—"}</td></tr>})}</tbody></table></div>}
