"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import "./platform-v2.css";

type BotId = "legion" | "scalper" | "shadow" | "scalper-shadow";
type View = "overview" | "bots" | "trades" | "analytics" | "lab";
type Bot = {
  id: BotId; name: string; subtitle: string; version: string; state: any; config?: any;
  lastScanAt: string | null; openPositions: number; positions: any[]; completedTrades: number;
  wins: number; losses: number; winRate: number; profitFactor: number | null; totalPnlSol: number;
  bankrollSol: number; startingBankrollSol: number; maxDrawdownSol: number; recentTrades: any[];
  recent24h: any; recent48h: any; previous48h: any;
};
type Data = { generatedAt: string; bots: Bot[]; overview: any; recentActivity: any[]; strategyLab: any };

const sol = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(3)} SOL`;
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const short = (v: string) => v ? `${v.slice(0, 5)}…${v.slice(-4)}` : "—";
const age = (v: string | null, now: number) => {
  if (!v) return "No data";
  const s = Math.max(0, Math.floor((now - Date.parse(v)) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
};
function botStatus(bot: Bot) {
  if (bot.state?.enabled === false) return { label: "Offline", tone: "offline" };
  if (bot.state?.halted) return { label: "Paused", tone: "paused" };
  return { label: "Active", tone: "active" };
}
function series(trades: any[], fallback = 0) {
  let running = 0;
  const values = [...trades].reverse().map((trade) => running += Number(trade.pnl ?? trade.pnl_sol ?? 0));
  return values.length > 1 ? [0, ...values] : [0, fallback];
}
function Chart({ values, tone = "green", large = false }: { values: number[]; tone?: string; large?: boolean }) {
  const width = 600, height = large ? 170 : 62;
  const min = Math.min(...values), max = Math.max(...values), range = max - min || 1;
  const points = values.map((v, i) => `${i / Math.max(1, values.length - 1) * width},${height - ((v - min) / range) * (height - 16) - 8}`).join(" ");
  return <svg className={`v2Chart ${tone} ${large ? "large" : ""}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none"><polyline points={points} /></svg>;
}
function Icon({ id }: { id: BotId }) {
  return <div className={`v2Icon ${id}`}>{id === "legion" ? "L" : id === "scalper" ? "ϟ" : id === "shadow" ? "◆" : "Sϟ"}</div>;
}
function Kpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: string }) {
  return <div className="v2Kpi"><small>{label}</small><strong className={tone}>{value}</strong><span>{sub}</span></div>;
}
function Title({ title, sub }: { title: string; sub: string }) {
  return <div className="v2Title"><h2>{title}</h2><p>{sub}</p></div>;
}

export default function Dashboard() {
  const [data, setData] = useState<Data | null>(null);
  const [view, setView] = useState<View>("overview");
  const [selected, setSelected] = useState<BotId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [password, setPassword] = useState("");
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/compact-dashboard", { cache: "no-store" });
      if (response.status === 401) { setNeedsLogin(true); setData(null); return; }
      if (!response.ok) throw new Error("Could not load dashboard");
      setData(await response.json()); setNeedsLogin(false); setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load dashboard"); }
  }, []);

  useEffect(() => {
    void refresh();
    const refreshTimer = setInterval(() => void refresh(), 10_000);
    const clockTimer = setInterval(() => setNow(Date.now()), 1_000);
    return () => { clearInterval(refreshTimer); clearInterval(clockTimer); };
  }, [refresh]);

  const login = async (event: FormEvent) => {
    event.preventDefault();
    const response = await fetch("/api/viewer-login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
    if (!response.ok) { setError("Wrong password"); return; }
    setPassword(""); await refresh();
  };

  const control = async (bot: Bot, action: "resume" | "pause") => {
    const ownerPassword = prompt(`Password required to ${action} ${bot.name}`);
    if (!ownerPassword || bot.id === "scalper-shadow") return;
    const response = await fetch("/api/bot-control", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Basic ${btoa(`owner:${ownerPassword}`)}` }, body: JSON.stringify({ bot: bot.id, action }) });
    const result = await response.json().catch(() => ({}));
    setNotice(response.ok ? `${bot.name} ${action === "resume" ? "resumed" : "paused"}.` : result.error ?? "Control failed");
    await refresh();
  };

  const selectedBot = data?.bots.find((bot) => bot.id === selected);
  if (!data) {
    if (needsLogin) return <main className="v2Login"><form onSubmit={login}><div className="v2Mark">S</div><h1>Solana Tracker</h1><p>Private trading intelligence platform</p><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Dashboard password" autoFocus /><button>Open platform</button>{error && <small>{error}</small>}</form></main>;
    return <main className="v2Login"><div className="v2Loader"><span /><div><strong>Solana Tracker</strong><p>{error ?? "Synchronizing live strategy data"}</p></div></div></main>;
  }
  if (selectedBot) return <BotDetail bot={selectedBot} now={now} back={() => setSelected(null)} control={control} />;

  const live = Date.now() - Date.parse(data.generatedAt) < 25_000;
  const views: View[] = ["overview", "bots", "trades", "analytics", "lab"];
  return <main className="v2App">
    <aside>
      <div className="v2Brand"><div className="v2Mark">S</div><div><strong>Solana Tracker</strong><small>Trading Intelligence</small></div></div>
      <nav>{views.map((item) => <button key={item} className={view === item ? "active" : ""} onClick={() => setView(item)}><i>{item === "overview" ? "⌂" : item === "bots" ? "◈" : item === "trades" ? "⇄" : item === "analytics" ? "⌁" : "⚙"}</i>{item === "lab" ? "Strategy Lab" : item[0].toUpperCase() + item.slice(1)}</button>)}</nav>
      <div className="v2System"><span className={live ? "" : "stale"} /><div><strong>{live ? "All systems live" : "Connection stale"}</strong><small>Updated {age(data.generatedAt, now)}</small></div></div>
    </aside>
    <section className="v2Main">
      <header><div><small>Workspace</small><h1>{view === "lab" ? "Strategy Lab" : view[0].toUpperCase() + view.slice(1)}</h1></div><div className="v2Live"><span className={live ? "" : "stale"} />{live ? "Live" : "Stale"}</div></header>
      {error && <div className="v2Toast">{error}</div>}{notice && <div className="v2Toast ok">{notice}</div>}
      {view === "overview" && <Overview data={data} now={now} open={setSelected} />}
      {view === "bots" && <Bots bots={data.bots} now={now} open={setSelected} />}
      {view === "trades" && <Trades trades={data.recentActivity} />}
      {view === "analytics" && <Analytics data={data} />}
      {view === "lab" && <StrategyLab data={data} refresh={refresh} />}
    </section>
    <nav className="v2Mobile">{views.map((item) => <button key={item} className={view === item ? "active" : ""} onClick={() => setView(item)}>{item === "overview" ? "⌂" : item === "bots" ? "◈" : item === "trades" ? "⇄" : item === "analytics" ? "⌁" : "⚙"}<small>{item === "lab" ? "Lab" : item}</small></button>)}</nav>
  </main>;
}

function Overview({ data, now, open }: { data: Data; now: number; open: (id: BotId) => void }) {
  const winRate = data.overview.completedTrades ? data.overview.wins / data.overview.completedTrades : 0;
  return <div className="v2Stack">
    <section className="v2Kpis"><Kpi label="Total equity" value={`${data.overview.totalEquitySol.toFixed(3)} SOL`} sub="Across four paper strategies" /><Kpi label="Total PnL" value={sol(data.overview.totalPnlSol)} tone={data.overview.totalPnlSol >= 0 ? "positive" : "negative"} sub={`${data.overview.completedTrades} trades`} /><Kpi label="Win rate" value={pct(winRate)} sub={`${data.overview.wins} wins · ${data.overview.losses} losses`} /><Kpi label="Profit factor" value={data.overview.profitFactor?.toFixed(2) ?? "—"} sub={`${data.overview.openPositions} open positions`} /></section>
    <section className="v2Panel v2Hero"><div><Title title="Portfolio performance" sub="Combined realized PnL" /><Chart values={series(data.recentActivity, data.overview.totalPnlSol)} large /></div><div className="v2Trend"><small>Last 24 hours</small><strong className={data.overview.recent24hPnlSol >= 0 ? "positive" : "negative"}>{sol(data.overview.recent24hPnlSol)}</strong><small>Last 48 hours</small><strong className={data.overview.recent48hPnlSol >= 0 ? "positive" : "negative"}>{sol(data.overview.recent48hPnlSol)}</strong></div></section>
    <Title title="Strategy modules" sub="Production and forward-test bots" />
    <section className="v2Bots">{data.bots.map((bot) => <BotCard key={bot.id} bot={bot} now={now} open={() => open(bot.id)} />)}</section>
    <section className="v2Panel"><Title title="Recent trades" sub="Newest completed positions" /><TradeRows trades={data.recentActivity.slice(0, 8)} /></section>
  </div>;
}
function Bots({ bots, now, open }: { bots: Bot[]; now: number; open: (id: BotId) => void }) {
  return <div className="v2Stack"><div className="v2Intro"><h2>Strategy modules</h2><p>Every live and forward-test strategy in one place.</p></div><section className="v2Bots full">{bots.map((bot) => <BotCard key={bot.id} bot={bot} now={now} open={() => open(bot.id)} />)}</section></div>;
}
function BotCard({ bot, now, open }: { bot: Bot; now: number; open: () => void }) {
  const state = botStatus(bot);
  return <article className="v2Panel v2Bot"><div className="v2BotHead"><Icon id={bot.id} /><div><h3>{bot.name}</h3><p>{bot.subtitle}</p><small>{bot.version}</small></div><span className={`v2Badge ${state.tone}`}>{state.label}</span></div><div className="v2BotStats"><div><small>PnL</small><strong className={bot.totalPnlSol >= 0 ? "positive" : "negative"}>{sol(bot.totalPnlSol)}</strong></div><div><small>Win rate</small><strong>{pct(bot.winRate)}</strong></div><div><small>PF</small><strong>{bot.profitFactor?.toFixed(2) ?? "—"}</strong></div></div><Chart values={series(bot.recentTrades, bot.totalPnlSol)} tone={bot.id} /><footer><span>Scan {age(bot.lastScanAt, now)}</span><button onClick={open}>Open</button></footer></article>;
}

function Trades({ trades }: { trades: any[] }) {
  const [query, setQuery] = useState("");
  const filtered = trades.filter((trade) => `${trade.token_symbol ?? ""} ${trade.botName ?? ""} ${trade.exit_reason ?? trade.reason ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="v2Stack"><div className="v2Intro split"><div><h2>Trade history</h2><p>Completed positions across every strategy.</p></div><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search token, bot or exit" /></div><section className="v2Panel"><TradeRows trades={filtered} /></section></div>;
}
function TradeRows({ trades }: { trades: any[] }) {
  return <div className="v2Trades"><div className="head"><span>Token</span><span>Bot</span><span>Exit</span><span>PnL</span></div>{trades.map((trade, index) => {
    const pnl = Number(trade.pnl ?? trade.pnl_sol ?? 0);
    return <div className="row" key={`${trade.botId}-${trade.id ?? index}`}><span><b>{trade.token_symbol ?? trade.symbol ?? "UNKNOWN"}</b><small>{short(trade.mint ?? "")}</small></span><span>{trade.botName ?? trade.botId}</span><span>{String(trade.exit_reason ?? trade.reason ?? "—").replaceAll("_", " ")}</span><strong className={pnl >= 0 ? "positive" : "negative"}>{sol(pnl)}</strong></div>;
  })}</div>;
}

function Analytics({ data }: { data: Data }) {
  const ranked = [...data.bots].sort((a, b) => (b.profitFactor ?? 0) - (a.profitFactor ?? 0));
  const recent = data.overview.recent48hPnlSol, previous = data.overview.previous48hPnlSol;
  let label = "Stable", tone = "";
  if (recent < 0) { label = "Weakening"; tone = "negative"; }
  else if (recent - previous > 0.05) { label = "Improving"; tone = "positive"; }
  else if (previous - recent > 0.05) { label = "Positive, but slowing"; tone = "amber"; }
  return <div className="v2Stack"><div className="v2Intro"><h2>Analytics</h2><p>Automatic explanation of current performance.</p></div><section className="v2Panel v2Summary"><div><small>Live performance summary</small><h2 className={tone}>{label}</h2><p>{label === "Improving" ? "Recent results are stronger than the previous period." : label === "Weakening" ? "The latest 48-hour result is negative and needs attention." : label === "Positive, but slowing" ? "Recent results remain profitable, but the pace is slower than the previous period." : "Performance is broadly unchanged."}</p></div><div className="v2SummaryGrid"><Kpi label="Last 24h" value={sol(data.overview.recent24hPnlSol)} tone={data.overview.recent24hPnlSol >= 0 ? "positive" : "negative"} sub="Combined" /><Kpi label="Last 48h" value={sol(recent)} tone={recent >= 0 ? "positive" : "negative"} sub="Combined" /><Kpi label="Strongest" value={ranked[0].name} sub={`PF ${ranked[0].profitFactor?.toFixed(2) ?? "—"}`} /><Kpi label="Needs work" value={ranked[ranked.length - 1].name} sub={`PF ${ranked[ranked.length - 1].profitFactor?.toFixed(2) ?? "—"}`} /></div></section><section className="v2Compare">{data.bots.map((bot) => <article className="v2Panel" key={bot.id}><div className="v2BotHead"><Icon id={bot.id} /><div><h3>{bot.name}</h3><p>{bot.completedTrades} trades</p></div></div><Chart values={series(bot.recentTrades, bot.totalPnlSol)} tone={bot.id} /><dl><div><dt>PnL</dt><dd className={bot.totalPnlSol >= 0 ? "positive" : "negative"}>{sol(bot.totalPnlSol)}</dd></div><div><dt>Profit factor</dt><dd>{bot.profitFactor?.toFixed(2) ?? "—"}</dd></div><div><dt>48h</dt><dd className={bot.recent48h.pnlSol >= 0 ? "positive" : "negative"}>{sol(bot.recent48h.pnlSol)}</dd></div><div><dt>Drawdown</dt><dd>{bot.maxDrawdownSol.toFixed(3)} SOL</dd></div></dl></article>)}</section></div>;
}

const labFields = [
  ["min_liquidity_usd", "Minimum liquidity", "USD"], ["min_market_cap_usd", "Minimum market cap", "USD"], ["max_market_cap_usd", "Maximum market cap", "USD"], ["min_liquidity_to_mcap", "Liquidity / market cap", "ratio"], ["min_five_minute_change_pct", "Minimum 5m move", "%"], ["max_five_minute_change_pct", "Maximum 5m move", "%"], ["min_fifteen_minute_change_pct", "Minimum 15m move", "%"], ["max_fifteen_minute_change_pct", "Maximum 15m move", "%"], ["min_volume_usd", "Minimum 5m volume", "USD"], ["min_buyers", "Minimum buyers", ""], ["min_buy_sell_ratio", "Buy / sell ratio", "ratio"], ["min_pool_age_minutes", "Minimum pool age", "min"], ["max_pool_age_minutes", "Maximum pool age", "min"], ["hard_stop_loss_pct", "Hard stop", "%"], ["target_profit_pct", "Take profit", "%"], ["trailing_activation_pct", "Trail activation", "%"], ["trailing_giveback_pct", "Trail giveback", "%"], ["max_hold_seconds", "Maximum hold", "sec"]
] as const;
function StrategyLab({ data, refresh }: { data: Data; refresh: () => Promise<void> }) {
  const current = data.strategyLab?.scalperShadowConfig ?? {};
  const [form, setForm] = useState<any>(current);
  const [message, setMessage] = useState("");
  useEffect(() => setForm(current), [data.generatedAt]);
  const scalper = data.bots.find((bot) => bot.id === "scalper")!;
  const matching = useMemo(() => scalper.recentTrades.filter((trade) => {
    const c = trade.entry_snapshot?.candidate ?? trade.entry_snapshot?.discovery ?? {};
    const marketCap = Number(c.marketCapUsd ?? c.market_cap_usd), liquidity = Number(c.liquidityUsd ?? c.liquidity_usd);
    const move5 = Number(c.fiveMinuteChangePct ?? c.five_minute_change_pct), move15 = Number(c.fifteenMinuteChangePct ?? c.fifteen_minute_change_pct);
    if (![marketCap, liquidity, move5, move15].every(Number.isFinite)) return true;
    return liquidity >= Number(form.min_liquidity_usd) && marketCap >= Number(form.min_market_cap_usd) && marketCap <= Number(form.max_market_cap_usd) && liquidity / Math.max(1, marketCap) >= Number(form.min_liquidity_to_mcap) && move5 >= Number(form.min_five_minute_change_pct) && move5 <= Number(form.max_five_minute_change_pct) && move15 >= Number(form.min_fifteen_minute_change_pct) && move15 <= Number(form.max_fifteen_minute_change_pct);
  }), [form, scalper.recentTrades]);
  const pnl = matching.reduce((sum, trade) => sum + Number(trade.pnl ?? trade.pnl_sol ?? 0), 0);
  const grossProfit = matching.filter((t) => Number(t.pnl ?? t.pnl_sol) > 0).reduce((s, t) => s + Number(t.pnl ?? t.pnl_sol), 0);
  const grossLoss = Math.abs(matching.filter((t) => Number(t.pnl ?? t.pnl_sol) < 0).reduce((s, t) => s + Number(t.pnl ?? t.pnl_sol), 0));
  const pf = grossLoss ? grossProfit / grossLoss : null;
  const winRate = matching.length ? matching.filter((t) => Number(t.pnl ?? t.pnl_sol) > 0).length / matching.length : 0;
  const retention = scalper.completedTrades ? matching.length / scalper.completedTrades : 0;
  const quality = Math.max(0, Math.min(100, Math.round((Math.min(2, pf ?? 0) / 2) * 40 + (pnl > 0 ? 20 : 0) + Math.min(1, matching.length / 50) * 25 + Math.min(1, retention) * 15)));
  const verdict = matching.length < 15 ? "Promising only if more trades confirm it" : pf && pf > 1.2 && pnl > 0 ? "Better historical risk-adjusted result" : retention < 0.2 ? "Too restrictive — very few opportunities" : "No reliable improvement yet";
  const save = async () => {
    const ownerPassword = prompt("Owner password required to start this Scalper Shadow experiment"); if (!ownerPassword) return;
    const response = await fetch("/api/strategy-lab", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Basic ${btoa(`owner:${ownerPassword}`)}` }, body: JSON.stringify({ strategy: "scalper-shadow", config: form, savePreset: true, presetName: `Scalper Shadow ${new Date().toLocaleDateString()}` }) });
    const result = await response.json().catch(() => ({}));
    setMessage(response.ok ? "Scalper Shadow settings saved. The next scan will use them." : result.error ?? "Could not save");
    if (response.ok) await refresh();
  };
  return <div className="v2Stack"><div className="v2Intro"><h2>Strategy Lab</h2><p>Adjust experimental filters without touching the regular Scalper.</p></div><section className="v2Lab"><div className="v2Panel v2Controls"><div className="v2LabHead"><div><h3>Scalper Shadow filters</h3><p>Changes apply only to the independent forward test.</p></div><span>Protected experiment</span></div><div className="v2FieldGrid">{labFields.map(([key, label, unit]) => <label key={key}><span>{label}</span><div><input type="number" step="any" value={form[key] ?? 0} onChange={(e) => setForm({ ...form, [key]: Number(e.target.value) })} /><small>{unit}</small></div></label>)}</div><button className="v2Save" onClick={save}>Save & start forward test</button>{message && <p className="v2Message">{message}</p>}</div><div className="v2Panel v2Preview"><small>Historical preview</small><div className={`v2Score ${quality >= 65 ? "good" : quality >= 40 ? "mid" : "bad"}`}>{quality}<span>/100</span></div><h3>{verdict}</h3><p>This preview filters stored Scalper entry snapshots. The real decision must come from new Scalper Shadow trades.</p><dl><div><dt>Matching trades</dt><dd>{matching.length}</dd></div><div><dt>Opportunity retained</dt><dd>{(retention * 100).toFixed(0)}%</dd></div><div><dt>Historical PnL</dt><dd className={pnl >= 0 ? "positive" : "negative"}>{sol(pnl)}</dd></div><div><dt>Profit factor</dt><dd>{pf?.toFixed(2) ?? "—"}</dd></div><div><dt>Win rate</dt><dd>{pct(winRate)}</dd></div></dl><div className="v2Warning">Historical previews can overfit. Promote settings only after 50–100 independent Scalper Shadow trades.</div></div></section></div>;
}

function BotDetail({ bot, now, back, control }: { bot: Bot; now: number; back: () => void; control: (bot: Bot, action: "resume" | "pause") => void }) {
  const state = botStatus(bot);
  return <main className="v2Detail"><button onClick={back}>← Back to platform</button><section className="v2Panel v2DetailHead"><Icon id={bot.id} /><div><h1>{bot.name}</h1><p>{bot.subtitle}</p><small>{bot.version}</small></div><span className={`v2Badge ${state.tone}`}>{state.label}</span></section><section className="v2Kpis"><Kpi label="Bankroll" value={`${bot.bankrollSol.toFixed(3)} SOL`} sub={`Started ${bot.startingBankrollSol.toFixed(3)}`} /><Kpi label="PnL" value={sol(bot.totalPnlSol)} tone={bot.totalPnlSol >= 0 ? "positive" : "negative"} sub={`${bot.completedTrades} trades`} /><Kpi label="Win rate" value={pct(bot.winRate)} sub={`${bot.wins}W · ${bot.losses}L`} /><Kpi label="Profit factor" value={bot.profitFactor?.toFixed(2) ?? "—"} sub={`Drawdown ${bot.maxDrawdownSol.toFixed(3)}`} /></section><section className="v2Panel"><Title title="Equity curve" sub={`Last scan ${age(bot.lastScanAt, now)}`} /><Chart values={series(bot.recentTrades, bot.totalPnlSol)} tone={bot.id} large /></section>{bot.id !== "scalper-shadow" && <div className="v2Actions"><button onClick={() => control(bot, "resume")}>Resume</button><button className="danger" onClick={() => control(bot, "pause")}>Pause</button></div>}<section className="v2Panel"><Title title="Recent trades" sub="Latest completed positions" /><TradeRows trades={bot.recentTrades} /></section></main>;
}
