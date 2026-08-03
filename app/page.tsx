"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type DashboardData = {
  generatedAt: string;
  state: any;
  openPosition: any | null;
  trades: any[];
  stats: {
    completed: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnlUsdc: number;
    cashUsdc: number;
    startingCashUsdc: number;
    returnPct: number;
    grossProfit: number;
    grossLoss: number;
    profitFactor: number | null;
    averageWinUsdc: number;
    averageLossUsdc: number;
    expectancyUsdc: number;
    bestTrade: { symbol: string; pnlUsdc: number; pnlPct: number } | null;
    worstTrade: { symbol: string; pnlUsdc: number; pnlPct: number } | null;
  };
};

const signedMoney = (value: number) => `${value >= 0 ? "+" : "−"}$${Math.abs(value).toFixed(3)}`;
const money = (value: number) => `$${Math.abs(value).toFixed(3)}`;
const pct = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
const time = (value?: string | null) => {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat("en-IL", {
    timeZone: "Asia/Jerusalem",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
};

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [password, setPassword] = useState("");
  const [filter, setFilter] = useState<"all" | "wins" | "losses">("all");

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/single-market-dashboard", { cache: "no-store" });
      if (response.status === 401) {
        setNeedsLogin(true);
        setData(null);
        return;
      }
      if (!response.ok) throw new Error("Could not load dashboard");
      setData(await response.json());
      setNeedsLogin(false);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load dashboard");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const login = async (event: FormEvent) => {
    event.preventDefault();
    const response = await fetch("/api/viewer-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!response.ok) return setError("Wrong password");
    setPassword("");
    await refresh();
  };

  const visibleTrades = useMemo(() => {
    if (!data) return [];
    return data.trades.filter((trade) => {
      const pnl = Number(trade.pnl_usdc ?? 0);
      if (filter === "wins") return pnl > 0;
      if (filter === "losses") return pnl < 0;
      return true;
    });
  }, [data, filter]);

  if (!data) {
    return <main className="center">{needsLogin ? (
      <form onSubmit={login} className="login-card">
        <div className="logo">S</div><h1>Solana Market Bot</h1><p className="muted">Private performance dashboard</p>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Dashboard password" autoFocus />
        <button className="primary">Open dashboard</button>{error && <strong className="negative">{error}</strong>}
      </form>
    ) : <div className="login-card"><h2>Loading bot data…</h2>{error && <p className="negative">{error}</p>}</div>}</main>;
  }

  const { stats, state } = data;
  const open = data.openPosition;
  const live = Date.now() - Date.parse(data.generatedAt) < 15_000;
  const mode = String(state?.mode ?? "paper").toUpperCase();
  const pnlTone = stats.totalPnlUsdc >= 0 ? "positive" : "negative";

  return (
    <main className="page">
      <style jsx global>{`
        *{box-sizing:border-box} body{margin:0;background:#070b12;color:#f7f9fc;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif} button,input{font:inherit}
        .page{min-height:100vh;padding:28px 18px 60px;background:radial-gradient(circle at 8% -10%,rgba(89,243,177,.14),transparent 30%),radial-gradient(circle at 95% 5%,rgba(97,129,255,.10),transparent 26%),#070b12}.shell{max-width:1180px;margin:auto}.topbar{display:flex;justify-content:space-between;align-items:center;gap:18px;margin-bottom:24px}.brand{display:flex;align-items:center;gap:14px}.logo{width:46px;height:46px;border-radius:14px;display:grid;place-items:center;font-size:23px;font-weight:950;color:#07130d;background:linear-gradient(135deg,#59f3b1,#83e8ff);box-shadow:0 10px 34px rgba(89,243,177,.2)}h1,h2,p{margin:0}.title{font-size:clamp(28px,5vw,44px);letter-spacing:-.045em}.subtitle,.muted{color:#8f9db2}.subtitle{margin-top:4px}.badge{display:inline-flex;align-items:center;gap:8px;padding:10px 14px;border-radius:999px;font-size:13px;font-weight:900;letter-spacing:.05em;border:1px solid rgba(89,243,177,.32);background:rgba(89,243,177,.09);color:#65f0ae;white-space:nowrap}.badge.stale{color:#ff8090;border-color:rgba(255,128,144,.35);background:rgba(255,128,144,.09)}.dot{width:8px;height:8px;border-radius:50%;background:currentColor;box-shadow:0 0 12px currentColor}.hero{display:grid;grid-template-columns:1.15fr .85fr;gap:16px;margin-bottom:16px}.hero-card,.card,.metric{border:1px solid #1f2b3b;background:linear-gradient(145deg,rgba(19,29,43,.96),rgba(12,19,30,.96));box-shadow:0 18px 60px rgba(0,0,0,.18)}.hero-card{border-radius:24px;padding:25px;min-height:190px;position:relative;overflow:hidden}.hero-card:after{content:"";position:absolute;width:170px;height:170px;border-radius:50%;right:-60px;bottom:-80px;background:rgba(89,243,177,.08);filter:blur(2px)}.eyebrow{font-size:12px;font-weight:900;letter-spacing:.15em;color:#7f8da3}.hero-value{font-size:clamp(42px,8vw,70px);font-weight:950;letter-spacing:-.055em;margin:14px 0 8px}.hero-row{display:flex;gap:20px;flex-wrap:wrap;margin-top:22px}.mini strong{display:block;font-size:18px;margin-top:3px}.positive{color:#63eead}.negative{color:#ff7d8f}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px}.metric{border-radius:18px;padding:17px;min-height:108px}.metric-label{color:#8f9db2;font-size:13px}.metric-value{display:block;font-size:25px;font-weight:900;margin-top:9px;letter-spacing:-.03em}.metric-note{display:block;color:#637188;font-size:12px;margin-top:5px}.card{border-radius:22px;padding:22px;margin-bottom:16px}.card-head{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:18px}.card-title{font-size:24px;letter-spacing:-.03em;margin-top:5px}.position{border-color:rgba(89,243,177,.38);box-shadow:0 18px 65px rgba(39,221,146,.06)}.position-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.position-item{border:1px solid #1e2b3c;background:#0a111c;border-radius:15px;padding:14px}.position-item span{display:block;color:#8290a5;font-size:12px}.position-item strong{display:block;margin-top:7px;font-size:17px;overflow-wrap:anywhere}.filters{display:flex;gap:7px}.filter{border:1px solid #2c3b50;background:#0b121e;color:#8897ad;border-radius:999px;padding:8px 12px;font-weight:850;font-size:12px}.filter.active{background:#eef4fa;color:#07101a;border-color:#eef4fa}.trade-list{display:grid;gap:9px}.trade{display:grid;grid-template-columns:76px minmax(170px,1fr) 100px 100px 110px;align-items:center;gap:12px;border:1px solid #1c2939;background:#0a111c;border-radius:15px;padding:14px}.trade.win{border-left:4px solid #59f3b1}.trade.loss{border-left:4px solid #ff7387}.result{font-size:13px;font-weight:950;letter-spacing:.08em}.trade-main strong{display:block;font-size:17px}.trade-main small,.trade-cell small{color:#75849a}.trade-cell strong{display:block;margin-top:4px}.trade-pnl{text-align:right;font-size:18px;font-weight:950}.footer{color:#66758a;font-size:12px;text-align:center;padding-top:8px}.error{border:1px solid rgba(255,115,135,.35);background:rgba(255,115,135,.08);color:#ff8090;padding:13px;border-radius:14px;margin-bottom:15px}.center{min-height:100vh;display:grid;place-items:center;padding:20px;background:#070b12}.login-card{width:min(420px,100%);border:1px solid #1f2b3b;background:#101925;border-radius:22px;padding:26px;display:grid;gap:14px}.login-card input{padding:14px;border-radius:12px;border:1px solid #2c3b50;background:#080e17;color:white}.primary{padding:14px;border:0;border-radius:12px;font-weight:900;background:#59f3b1;color:#06100b}
        @media(max-width:850px){.hero{grid-template-columns:1fr}.metrics{grid-template-columns:repeat(2,1fr)}.position-grid{grid-template-columns:repeat(2,1fr)}.trade{grid-template-columns:58px minmax(130px,1fr) 82px}.trade-cell.size,.trade-cell.return{display:none}.topbar{align-items:flex-start}.badge{margin-top:4px}}
        @media(max-width:520px){.page{padding:18px 12px 44px}.topbar{display:block}.badge{margin-top:14px}.hero-card{padding:20px;min-height:165px}.metrics{gap:8px}.metric{padding:14px;min-height:98px}.metric-value{font-size:22px}.card{padding:17px}.position-grid{grid-template-columns:1fr 1fr}.trade{grid-template-columns:50px minmax(100px,1fr) 88px;padding:12px;gap:8px}.trade-pnl{font-size:15px}.filters{width:100%}.filter{flex:1}.card-head{align-items:flex-start}}
      `}</style>
      <div className="shell">
        <header className="topbar">
          <div className="brand"><div className="logo">S</div><div><h1 className="title">Solana Market Bot</h1><p className="subtitle">Market-wide scanner · executable paper results</p></div></div>
          <div className={`badge ${live ? "" : "stale"}`}><span className="dot" />{live ? "LIVE" : "STALE"} · {mode}</div>
        </header>
        {error && <div className="error">{error}</div>}

        <section className="hero">
          <div className="hero-card"><span className="eyebrow">TOTAL PERFORMANCE</span><div className={`hero-value ${pnlTone}`}>{signedMoney(stats.totalPnlUsdc)}</div><span className={pnlTone}>{pct(stats.returnPct)} return</span><div className="hero-row"><div className="mini"><span className="muted">Cash</span><strong>${stats.cashUsdc.toFixed(3)}</strong></div><div className="mini"><span className="muted">Starting cash</span><strong>${stats.startingCashUsdc.toFixed(2)}</strong></div><div className="mini"><span className="muted">Trades</span><strong>{stats.completed}</strong></div></div></div>
          <div className="hero-card"><span className="eyebrow">WIN RATE</span><div className="hero-value">{(stats.winRate * 100).toFixed(1)}%</div><div className="hero-row"><div className="mini"><span className="muted">Wins</span><strong className="positive">{stats.wins}</strong></div><div className="mini"><span className="muted">Losses</span><strong className="negative">{stats.losses}</strong></div><div className="mini"><span className="muted">Profit factor</span><strong>{stats.profitFactor == null ? "∞" : stats.profitFactor.toFixed(2)}</strong></div></div></div>
        </section>

        <section className="metrics">
          <Metric label="Average win" value={money(stats.averageWinUsdc)} tone="positive" note="per winning trade" />
          <Metric label="Average loss" value={money(stats.averageLossUsdc)} tone="negative" note="per losing trade" />
          <Metric label="Expectancy" value={signedMoney(stats.expectancyUsdc)} tone={stats.expectancyUsdc >= 0 ? "positive" : "negative"} note="average per trade" />
          <Metric label="Entries today" value={String(state?.entries_today ?? 0)} note={state?.halted ? `Halted: ${state.halt_reason}` : "Scanner active"} />
          <Metric label="Gross profit" value={money(stats.grossProfit)} tone="positive" />
          <Metric label="Gross loss" value={money(stats.grossLoss)} tone="negative" />
          <Metric label="Best trade" value={stats.bestTrade ? `${stats.bestTrade.symbol} ${signedMoney(stats.bestTrade.pnlUsdc)}` : "—"} tone="positive" note={stats.bestTrade ? pct(stats.bestTrade.pnlPct) : undefined} />
          <Metric label="Worst trade" value={stats.worstTrade ? `${stats.worstTrade.symbol} ${signedMoney(stats.worstTrade.pnlUsdc)}` : "—"} tone="negative" note={stats.worstTrade ? pct(stats.worstTrade.pnlPct) : undefined} />
        </section>

        <section className="card position"><div className="card-head"><div><span className="eyebrow">{open ? "● OPEN POSITION" : "SCANNER STATUS"}</span><h2 className="card-title">{open ? String(open.symbol ?? "Unknown token") : "Waiting for the next setup"}</h2></div><strong className={open ? "positive" : "muted"}>{open ? "ACTIVE NOW" : "SCANNING"}</strong></div>{open ? <div className="position-grid"><Position label="Size" value={`$${Number(open.sizeUsdc ?? open.size_usdc ?? 0).toFixed(2)}`} /><Position label="Score" value={String(open.score ?? "—")} /><Position label="Entry price" value={`$${Number(open.entryPriceUsd ?? open.entry_price_usd ?? 0).toPrecision(6)}`} /><Position label="High-water" value={`$${Number(open.highWaterPriceUsd ?? open.high_water_price_usd ?? 0).toPrecision(6)}`} /><Position label="Opened" value={time(open.openedAt ?? open.opened_at ?? open.created_at)} /><Position label="Token" value={String(open.name ?? open.symbol ?? "—")} /><Position label="Mint" value={String(open.mint ?? "—")} /><Position label="Trade ID" value={String(open.tradeId ?? open.trade_id ?? "—")} /></div> : <p className="muted">The worker is alive and checking the market. A new position will appear here as soon as all entry conditions pass.</p>}</section>

        <section className="card"><div className="card-head"><div><span className="eyebrow">RECENT ACTIVITY</span><h2 className="card-title">Trade history</h2></div><div className="filters">{(["all","wins","losses"] as const).map(item => <button key={item} onClick={() => setFilter(item)} className={`filter ${filter === item ? "active" : ""}`}>{item.toUpperCase()}</button>)}</div></div><div className="trade-list">{visibleTrades.map(trade => { const pnl = Number(trade.pnl_usdc ?? 0); const win = pnl > 0; const loss = pnl < 0; return <article key={trade.id} className={`trade ${win ? "win" : loss ? "loss" : ""}`}><div><div className={`result ${win ? "positive" : loss ? "negative" : ""}`}>{win ? "WIN" : loss ? "LOSS" : "FLAT"}</div><small className="muted">#{trade.id}</small></div><div className="trade-main"><strong>{trade.symbol ?? "UNKNOWN"}</strong><small>{String(trade.exit_reason ?? trade.status ?? "—").replaceAll("_"," ")} · {time(trade.updated_at ?? trade.created_at)}</small></div><div className="trade-cell size"><small>Size</small><strong>${Number(trade.size_usdc ?? 0).toFixed(2)}</strong></div><div className="trade-cell return"><small>Return</small><strong className={win ? "positive" : loss ? "negative" : ""}>{pct(Number(trade.pnl_pct ?? 0))}</strong></div><div className={`trade-pnl ${win ? "positive" : loss ? "negative" : ""}`}>{signedMoney(pnl)}</div></article>})}{visibleTrades.length === 0 && <p className="muted">No trades match this filter.</p>}</div></section>
        <footer className="footer">Updated {time(data.generatedAt)} · Last scan {time(state?.last_scan_at)} · Strategy {state?.scanner_snapshot?.strategyVersion ?? "market timing v2"}</footer>
      </div>
    </main>
  );
}

function Metric({ label, value, tone, note }: { label: string; value: string; tone?: string; note?: string }) { return <div className="metric"><span className="metric-label">{label}</span><strong className={`metric-value ${tone ?? ""}`}>{value}</strong>{note && <small className="metric-note">{note}</small>}</div>; }
function Position({ label, value }: { label: string; value: string }) { return <div className="position-item"><span>{label}</span><strong>{value}</strong></div>; }
