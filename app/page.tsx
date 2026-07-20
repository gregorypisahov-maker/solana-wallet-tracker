"use client";

import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import "./compact-dashboard.css";
import "./bot-controls.css";
import "./live-status.css";

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
const ageSeconds = (value: string | null | undefined, now: number) => value ? Math.max(0, Math.floor((now - Date.parse(value)) / 1000)) : Number.POSITIVE_INFINITY;
const ageText = (value: string | null | undefined, now: number) => {
  const seconds = ageSeconds(value, now);
  if (!Number.isFinite(seconds)) return "No scan recorded";
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
};

function CubeMark() { return <div className="cubeMark" aria-hidden="true"><i /><i /><i /></div>; }
function BotMark({ id }: { id: BotId }) {
  if (id === "legion") return <div className="botMark legion" aria-hidden="true"><svg viewBox="0 0 180 200"><path className="armor" d="M90 8 151 42 143 140 90 190 37 140 29 42Z"/><path className="plate" d="M90 18v118M35 48l55 34 55-34M42 139l48-26 48 26M60 31l30 51 30-51"/><path className="visor" d="m48 89 34 12-13 14-27-9Zm84 0-34 12 13 14 27-9Z"/><path className="jaw" d="m62 128 28 20 28-20-8 36-20 18-20-18Z"/></svg></div>;
  if (id === "scalper") return <div className="botMark scalper" aria-hidden="true"><svg viewBox="0 0 180 200"><path className="shield" d="M90 10 155 40 145 135c-12 28-31 45-55 56-24-11-43-28-55-56L25 40Z"/><path className="shieldLine" d="M90 20v158M34 48l56 29 56-29"/><path className="bolt" d="m105 27-53 78h31l-19 67 65-91H96Z"/></svg></div>;
  return <div className="botMark shadow" aria-hidden="true"><svg viewBox="0 0 180 200"><path className="hood" d="M90 8c35 20 58 55 65 105-15 39-38 64-65 79-27-15-50-40-65-79C32 63 55 28 90 8Z"/><path className="face" d="M90 43c25 17 39 42 42 77-12 29-26 46-42 56-16-10-30-27-42-56 3-35 17-60 42-77Z"/><path className="eye" d="m48 101 32-9-12 18-21 2Zm84 0-32-9 12 18 21 2Z"/></svg></div>;
}
function status(bot: Bot) { if (bot.state?.enabled === false) return { text: "Offline", className: "offline" }; if (bot.state?.halted) return { text: "Paused", className: "paused" }; return { text: "Active", className: "active" }; }
function seriesFromTrades(trades: any[], fallback: number) { const ordered = [...trades].reverse(); let running = 0; const values = ordered.map((trade) => running += Number(trade.pnl ?? trade.pnl_sol ?? 0)); return values.length > 1 ? [0, ...values] : [0, fallback]; }
function LineChart({ values, tone }: { values: number[]; tone: "green" | "red" | "violet" | "blue" | "amber" }) { const width=260,height=74,min=Math.min(...values),max=Math.max(...values),range=max-min||1; const points=values.map((value,index)=>`${(index/Math.max(1,values.length-1)*width).toFixed(1)},${(height-((value-min)/range)*(height-12)-6).toFixed(1)}`).join(" "); return <svg className={`lineChart ${tone}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true"><polyline points={points}/></svg>; }

export default function Dashboard() {
  const [data,setData]=useState<DashboardData|null>(null);
  const [selectedBot,setSelectedBot]=useState<BotId|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [notice,setNotice]=useState<string|null>(null);
  const [busyBot,setBusyBot]=useState<string|null>(null);
  const [needsLogin,setNeedsLogin]=useState(false);
  const [password,setPassword]=useState("");
  const [loggingIn,setLoggingIn]=useState(false);
  const [now,setNow]=useState(Date.now());

  const refresh=useCallback(async()=>{ try { const response=await fetch("/api/compact-dashboard",{cache:"no-store"}); if(response.status===401){setNeedsLogin(true);setData(null);return;} if(!response.ok) throw new Error("Could not load live dashboard data"); setData(await response.json()); setNeedsLogin(false); setError(null); } catch(requestError){setError(requestError instanceof Error?requestError.message:"Could not load dashboard");}},[]);
  useEffect(()=>{void refresh();const refreshTimer=window.setInterval(()=>void refresh(),10000);const clockTimer=window.setInterval(()=>setNow(Date.now()),1000);return()=>{window.clearInterval(refreshTimer);window.clearInterval(clockTimer);};},[refresh]);

  const login=async(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();setLoggingIn(true);setError(null);try{const response=await fetch("/api/viewer-login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password})});const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(result.error??"Could not sign in");setPassword("");await refresh();}catch(loginError){setError(loginError instanceof Error?loginError.message:"Could not sign in");}finally{setLoggingIn(false);}};
  const controlBot=async(bot:Bot,action:"resume"|"pause")=>{const ownerPassword=window.prompt(`Owner password required to ${action} ${bot.name}`);if(!ownerPassword)return;setBusyBot(bot.id);setNotice(null);try{const authorization=`Basic ${window.btoa(`owner:${ownerPassword}`)}`;const response=await fetch("/api/bot-control",{method:"POST",headers:{"Content-Type":"application/json",Authorization:authorization},body:JSON.stringify({bot:bot.id,action})});const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(result.error??`Could not ${action} bot`);setNotice(`${bot.name} ${action==="resume"?"resumed":"paused"}.`);await refresh();}catch(controlError){setNotice(controlError instanceof Error?controlError.message:"Bot control failed");}finally{setBusyBot(null);}};
  const selected=useMemo(()=>data?.bots.find((bot)=>bot.id===selectedBot)??null,[data,selectedBot]);

  if(!data){if(needsLogin)return <main className="cubeLogin"><div className="loginPanel"><CubeMark/><h1>Solana Tracker</h1><p>Enter the dashboard key to continue.</p><form onSubmit={login}><input type="password" value={password} onChange={(event)=>setPassword(event.target.value)} placeholder="Dashboard key" autoFocus required/><button disabled={loggingIn}>{loggingIn?"Opening…":"Open dashboard"}</button></form>{error&&<div className="notice error">{error}</div>}</div></main>;return <main className="cubeLogin"><div className="loadingPanel"><CubeMark/><span>{error??"Connecting to live data…"}</span></div></main>;}

  const dashboardAge=ageSeconds(data.generatedAt,now);
  const dashboardLive=dashboardAge<25;

  if(selected){const selectedStatus=status(selected),canResume=selectedStatus.className!=="active",tone=selected.id==="legion"?"green":selected.id==="scalper"?"red":"violet";return <main className="cubeApp"><div className="detailShell"><button className="backButton" onClick={()=>setSelectedBot(null)}>← Back</button>{notice&&<div className="controlNotice">{notice}</div>}<section className={`detailHero ${selected.id}`}><BotMark id={selected.id}/><div><div className="botTitleRow"><h1>{selected.name}</h1><span className={`statusPill ${selectedStatus.className}`}>{selectedStatus.text}</span></div><p>{selected.subtitle}</p><div className="scanStamp"><i className={ageSeconds(selected.lastScanAt,now)<120?"fresh":"stale"}/>Last scan {ageText(selected.lastScanAt,now)}</div><strong className={selected.totalPnlSol>=0?"positive":"negative"}>{sol(selected.totalPnlSol)}</strong><div className="botControls"><button className="primaryControl" disabled={busyBot===selected.id||!canResume} onClick={()=>controlBot(selected,"resume")}>{busyBot===selected.id?"Updating…":canResume?"Resume bot":"Bot running"}</button><button className="secondaryControl" disabled={busyBot===selected.id||canResume} onClick={()=>controlBot(selected,"pause")}>Pause bot</button></div></div></section><section className="detailStats"><Metric label="Win rate" value={pct(selected.winRate)} sub={`${selected.wins}W / ${selected.losses}L`}/><Metric label="Profit factor" value={selected.profitFactor==null?"—":selected.profitFactor.toFixed(2)}/><Metric label="Completed trades" value={String(selected.completedTrades)}/><Metric label="Open positions" value={String(selected.openPositions)}/></section><section className="detailChart"><LineChart values={seriesFromTrades(selected.recentTrades,selected.totalPnlSol)} tone={tone}/></section><section className="activityPanel"><div className="terminalSectionHead"><h2>Recent trades</h2></div>{selected.recentTrades.length?selected.recentTrades.map((trade,index)=><ActivityRow key={`${trade.id??trade.position_id??index}`} trade={{...trade,botId:selected.id,botName:selected.name}} now={now}/>):<div className="emptyState">No completed trades yet.</div>}</section></div></main>;}

  const overviewWinRate=data.overview.completedTrades?data.overview.wins/data.overview.completedTrades:0;
  const combined=seriesFromTrades(data.recentActivity,data.overview.totalPnlSol);
  return <main className="cubeApp"><div className="terminalShell"><aside className="iconRail"><button className="railButton selected">▦</button><button className="railButton" onClick={()=>document.getElementById("bots")?.scrollIntoView({behavior:"smooth"})}>♜</button><button className="railButton" onClick={()=>document.getElementById("activity")?.scrollIntoView({behavior:"smooth"})}>⌁</button><button className="railButton">▥</button><button className="railButton">♢</button><button className="railButton">▭</button><button className="railButton">⚙</button></aside><div className="terminalMain"><header className="terminalHeader"><div className="terminalBrand"><CubeMark/><div><h1>Solana Tracker</h1><span>David&apos;s Heart <b>⌁</b></span></div></div><div className="headerStatus"><span className={`liveBadge ${dashboardLive?"":"stale"}`}><i/>{dashboardLive?"Live":"Stale"}</span><time className="realClock">{new Date(now).toLocaleTimeString([],{hour12:false,hour:"2-digit",minute:"2-digit",second:"2-digit"})}</time><span className="refreshAge">Data {ageText(data.generatedAt,now)}</span></div></header><section className="healthStrip"><strong>System<br/>health</strong><Health name="Dashboard" detail={dashboardLive?`Updated ${ageText(data.generatedAt,now)}`:"Connection stale"} ok={dashboardLive}/>{data.bots.map((bot)=><Health key={bot.id} name={bot.name.replace(" Bot","")} detail={`Scan ${ageText(bot.lastScanAt,now)}`} ok={status(bot).className==="active"&&ageSeconds(bot.lastScanAt,now)<180}/>)}</section>{error&&<div className="notice error">{error}. Showing last snapshot.</div>}{notice&&<div className="controlNotice">{notice}</div>}<section className="overviewGrid"><Metric label="Total PnL" value={sol(data.overview.totalPnlSol)} tone={data.overview.totalPnlSol>=0?"positive":"negative"} chart={<LineChart values={combined} tone="green"/>}/><Metric label="Win rate" value={pct(overviewWinRate)} sub={`${data.overview.wins}W / ${data.overview.losses}L`} chart={<LineChart values={combined} tone="violet"/>}/><Metric label="Total trades" value={String(data.overview.completedTrades)} sub="Completed" chart={<LineChart values={data.bots.map((bot)=>bot.completedTrades)} tone="blue"/>}/><Metric label="Open positions" value={String(data.overview.openPositions)} sub={data.overview.openPositions?"Active trades":"No active trades"} chart={<LineChart values={[0,0,data.overview.openPositions]} tone="amber"/>}/></section><section id="bots" className="terminalSection"><div className="terminalSectionHead"><h2>Trading bots</h2><span>Live scan status</span></div><div className="botStack">{data.bots.map((bot)=><BotCard key={bot.id} bot={bot} onOpen={()=>setSelectedBot(bot.id)} onResume={()=>controlBot(bot,"resume")} busy={busyBot===bot.id} now={now}/>)}</div></section><section id="activity" className="terminalSection activityPanel"><div className="terminalSectionHead"><h2>Recent activity</h2><span>Auto-refresh 10s</span></div>{data.recentActivity.length?data.recentActivity.slice(0,6).map((trade,index)=><ActivityRow key={`${trade.botId}-${trade.id??trade.position_id??index}`} trade={trade} now={now}/>):<div className="emptyState">Waiting for completed trades.</div>}</section></div></div></main>;
}

function Health({name,detail,ok}:{name:string;detail:string;ok:boolean}){return <div className="healthItem"><span><i className={ok?"ok":"bad"}/>{name}</span><small>{detail}</small></div>}
function Metric({label,value,sub,tone,chart}:{label:string;value:string;sub?:string;tone?:"positive"|"negative";chart?:ReactNode}){return <div className="metricCard"><span>{label}</span><strong className={tone}>{value}</strong>{sub&&<small>{sub}</small>}{chart}</div>}
function BotCard({bot,onOpen,onResume,busy,now}:{bot:Bot;onOpen:()=>void;onResume:()=>void;busy:boolean;now:number}){const botStatus=status(bot),needsResume=botStatus.className!=="active",tone=bot.id==="legion"?"green":bot.id==="scalper"?"red":"violet",scanFresh=ageSeconds(bot.lastScanAt,now)<180;return <div className={`botCard ${bot.id}`}><button className="botCardMain" onClick={onOpen}><div className="botIdentity"><BotMark id={bot.id}/><div><span className={`statusPill ${botStatus.className}`}>{botStatus.text}</span><h3>{bot.name}</h3><p>{bot.subtitle}</p><div className="scanStamp"><i className={scanFresh?"fresh":"stale"}/>Scan {ageText(bot.lastScanAt,now)}</div></div></div><div className="botNumbers"><div><span>PnL</span><strong className={bot.totalPnlSol>=0?"positive":"negative"}>{sol(bot.totalPnlSol)}</strong></div><div><span>Win rate</span><strong>{pct(bot.winRate)}</strong><small>{bot.wins}W / {bot.losses}L</small></div><div><span>Trades</span><strong>{bot.completedTrades}</strong><small>Completed</small></div></div><LineChart values={seriesFromTrades(bot.recentTrades,bot.totalPnlSol)} tone={tone}/><div className="openArrow">→</div></button>{needsResume&&<button className="quickResume" disabled={busy} onClick={onResume}>{busy?"Updating…":"Resume"}</button>}</div>}
function ActivityRow({trade,now}:{trade:any;now:number}){const pnl=Number(trade.pnl??trade.pnl_sol??0),symbol=trade.token_symbol??trade.symbol??"UNKNOWN";return <div className="activityRow"><time>{ageText(trade.happenedAt,now)}</time><BotMark id={trade.botId}/><div><strong>{symbol}</strong><span>{trade.botName}</span></div><span className={`resultTag ${pnl>=0?"win":"loss"}`}>{pnl>=0?"WIN":"LOSS"}</span><b className={pnl>=0?"positive":"negative"}>{sol(pnl)}</b><span className="multiple">{Number(trade.multiple??trade.net_multiple??0)>0?`${Number(trade.multiple??trade.net_multiple).toFixed(2)}x`:"—"}</span></div>}
