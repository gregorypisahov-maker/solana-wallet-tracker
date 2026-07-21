"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import "./platform-v2.css";

type BotId = "legion" | "scalper" | "shadow";
type View = "overview" | "bots" | "trades" | "analytics";
type Bot = {
  id: BotId;
  name: string;
  subtitle: string;
  version: string;
  state: any;
  lastScanAt: string | null;
  openPositions: number;
  positions: any[];
  completedTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number | null;
  totalPnlSol: number;
  bankrollSol: number;
  startingBankrollSol: number;
  maxDrawdownSol: number;
  recentTrades: any[];
  recent24h: any;
  recent48h: any;
  previous48h: any;
};
type Data = {
  generatedAt: string;
  bots: Bot[];
  overview: any;
  recentActivity: any[];
  readiness?: any;
};

const sol = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(3)} SOL`;
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const short = (v: string) => (v ? `${v.slice(0, 5)}…${v.slice(-4)}` : "—");
const age = (v: string | null, now: number) => {
  if (!v) return "No data";
  const s = Math.max(0, Math.floor((now - Date.parse(v)) / 1000));
  return s < 60
    ? `${s}s ago`
    : s < 3600
      ? `${Math.floor(s / 60)}m ago`
      : `${Math.floor(s / 3600)}h ago`;
};
const exactIsraelTime = (value: string | null | undefined) => {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat("en-IL", {
    timeZone: "Asia/Jerusalem",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(new Date(value));
};
const positionSymbol = (position: any) => position.token_symbol ?? position.symbol ?? "UNKNOWN";
const positionSize = (position: any) => Number(position.size_sol ?? position.initial_size_sol ?? 0);
const positionEntry = (position: any) => Number(position.entry_price_usd ?? position.entry_price ?? 0);
const positionTime = (position: any) => position.entry_time ?? position.opened_at ?? null;
const tradeTime = (trade: any) =>
  trade.happenedAt ?? trade.closed_at ?? trade.happened_at ?? trade.opened_at ?? null;
const chartAddress = (item: any) =>
  item.pair_address ??
  item.pairAddress ??
  item.entry_snapshot?.pair_address ??
  item.entry_snapshot?.pairAddress ??
  item.entry_alert?.pair_address ??
  item.entry_alert?.pairAddress ??
  item.mint ??
  null;
const chartUrl = (item: any) => {
  const address = chartAddress(item);
  return address ? `https://dexscreener.com/solana/${encodeURIComponent(address)}` : null;
};

function botStatus(bot: Bot) {
  if (bot.state?.enabled === false) return { label: "Offline", tone: "offline" };
  if (bot.state?.halted) return { label: "Paused", tone: "paused" };
  return { label: "Active", tone: "active" };
}

function series(trades: any[], fallback = 0) {
  let running = 0;
  const values = [...trades].reverse().map((trade) =>
    (running += Number(trade.pnl ?? trade.pnl_sol ?? 0))
  );
  return values.length > 1 ? [0, ...values] : [0, fallback];
}

function Chart({ values, tone = "green", large = false }: { values: number[]; tone?: string; large?: boolean }) {
  const width = 600;
  const height = large ? 170 : 62;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values
    .map(
      (v, i) =>
        `${(i / Math.max(1, values.length - 1)) * width},${height - ((v - min) / range) * (height - 16) - 8}`
    )
    .join(" ");
  return (
    <svg
      className={`v2Chart ${tone} ${large ? "large" : ""}`}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
    >
      <polyline points={points} />
    </svg>
  );
}

function Icon({ id }: { id: BotId }) {
  return <div className={`v2Icon ${id}`}>{id === "legion" ? "L" : id === "scalper" ? "ϟ" : "◆"}</div>;
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: string }) {
  return (
    <div className="v2Kpi">
      <small>{label}</small>
      <strong className={tone}>{value}</strong>
      <span>{sub}</span>
    </div>
  );
}

function Title({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="v2Title">
      <h2>{title}</h2>
      <p>{sub}</p>
    </div>
  );
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
      if (response.status === 401) {
        setNeedsLogin(true);
        setData(null);
        return;
      }
      if (!response.ok) throw new Error("Could not load dashboard");
      setData(await response.json());
      setNeedsLogin(false);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load dashboard");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const a = setInterval(() => void refresh(), 10_000);
    const b = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      clearInterval(a);
      clearInterval(b);
    };
  }, [refresh]);

  const login = async (event: FormEvent) => {
    event.preventDefault();
    const response = await fetch("/api/viewer-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!response.ok) {
      setError("Wrong password");
      return;
    }
    setPassword("");
    await refresh();
  };

  const control = async (bot: Bot, action: "resume" | "pause") => {
    const ownerPassword = prompt(`Password required to ${action} ${bot.name}`);
    if (!ownerPassword) return;
    const response = await fetch("/api/bot-control", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${btoa(`owner:${ownerPassword}`)}`,
      },
      body: JSON.stringify({ bot: bot.id, action }),
    });
    const result = await response.json().catch(() => ({}));
    setNotice(
      response.ok
        ? `${bot.name} ${action === "resume" ? "resumed" : "paused"}.`
        : result.error ?? "Control failed"
    );
    await refresh();
  };

  const selectedBot = data?.bots.find((bot) => bot.id === selected);
  if (!data) {
    if (needsLogin) {
      return (
        <main className="v2Login">
          <form onSubmit={login}>
            <div className="v2Mark">S</div>
            <h1>Solana Tracker</h1>
            <p>Private trading intelligence platform</p>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Dashboard password"
              autoFocus
            />
            <button>Open platform</button>
            {error && <small>{error}</small>}
          </form>
        </main>
      );
    }
    return (
      <main className="v2Login">
        <div className="v2Loader">
          <span />
          <div>
            <strong>Solana Tracker</strong>
            <p>{error ?? "Synchronizing live strategy data"}</p>
          </div>
        </div>
      </main>
    );
  }

  if (selectedBot) {
    return <BotDetail bot={selectedBot} now={now} back={() => setSelected(null)} control={control} />;
  }

  const live = Date.now() - Date.parse(data.generatedAt) < 25_000;
  const views: View[] = ["overview", "bots", "trades", "analytics"];
  return (
    <main className="v2App">
      <aside>
        <div className="v2Brand">
          <div className="v2Mark">S</div>
          <div>
            <strong>Solana Tracker</strong>
            <small>Trading Intelligence</small>
          </div>
        </div>
        <nav>
          {views.map((item) => (
            <button key={item} className={view === item ? "active" : ""} onClick={() => setView(item)}>
              <i>{item === "overview" ? "⌂" : item === "bots" ? "◈" : item === "trades" ? "⇄" : "⌁"}</i>
              {item[0].toUpperCase() + item.slice(1)}
            </button>
          ))}
        </nav>
        <div className="v2System">
          <span className={live ? "" : "stale"} />
          <div>
            <strong>{live ? "All systems live" : "Connection stale"}</strong>
            <small>Updated {age(data.generatedAt, now)}</small>
          </div>
        </div>
      </aside>
      <section className="v2Main">
        <header>
          <div>
            <small>Workspace</small>
            <h1>{view[0].toUpperCase() + view.slice(1)}</h1>
          </div>
          <div className="v2Live">
            <span className={live ? "" : "stale"} />
            {live ? "Live" : "Stale"}
          </div>
        </header>
        {error && <div className="v2Toast">{error}</div>}
        {notice && <div className="v2Toast ok">{notice}</div>}
        {view === "overview" && <Overview data={data} now={now} open={setSelected} />}
        {view === "bots" && <Bots bots={data.bots} now={now} open={setSelected} />}
        {view === "trades" && <Trades trades={data.recentActivity} />}
        {view === "analytics" && <Analytics data={data} />}
      </section>
      <nav className="v2Mobile">
        {views.map((item) => (
          <button key={item} className={view === item ? "active" : ""} onClick={() => setView(item)}>
            {item === "overview" ? "⌂" : item === "bots" ? "◈" : item === "trades" ? "⇄" : "⌁"}
            <small>{item}</small>
          </button>
        ))}
      </nav>
    </main>
  );
}

function Overview({ data, now, open }: { data: Data; now: number; open: (id: BotId) => void }) {
  const winRate = data.overview.completedTrades ? data.overview.wins / data.overview.completedTrades : 0;
  return (
    <div className="v2Stack">
      <section className="v2Kpis">
        <Kpi label="Total equity" value={`${data.overview.totalEquitySol.toFixed(3)} SOL`} sub="Across 3 paper strategies" />
        <Kpi label="Total PnL" value={sol(data.overview.totalPnlSol)} tone={data.overview.totalPnlSol >= 0 ? "positive" : "negative"} sub={`${data.overview.completedTrades} completed trades`} />
        <Kpi label="Win rate" value={pct(winRate)} sub={`${data.overview.wins} wins · ${data.overview.losses} losses`} />
        <Kpi label="Open positions" value={String(data.overview.openPositions)} tone={data.overview.openPositions > 0 ? "positive" : undefined} sub={data.overview.openPositions > 0 ? "Trades currently active" : "No bot is in a trade"} />
      </section>
      <section className="v2Panel v2Hero">
        <div>
          <Title title="Portfolio performance" sub="Combined realized PnL" />
          <Chart values={series(data.recentActivity, data.overview.totalPnlSol)} large />
        </div>
        <div className="v2Trend">
          <small>Last 24 hours</small>
          <strong className={data.overview.recent24hPnlSol >= 0 ? "positive" : "negative"}>{sol(data.overview.recent24hPnlSol)}</strong>
          <small>Last 48 hours</small>
          <strong className={data.overview.recent48hPnlSol >= 0 ? "positive" : "negative"}>{sol(data.overview.recent48hPnlSol)}</strong>
        </div>
      </section>
      <Title title="Strategy modules" sub="The three paper strategies currently measured" />
      <section className="v2Bots">
        {data.bots.map((bot) => <BotCard key={bot.id} bot={bot} now={now} open={() => open(bot.id)} />)}
      </section>
      <section className="v2Panel">
        <Title title="Recent trades" sub="Newest completed positions with bot name and Israel time" />
        <TradeRows trades={data.recentActivity.slice(0, 8)} />
      </section>
    </div>
  );
}

function Bots({ bots, now, open }: { bots: Bot[]; now: number; open: (id: BotId) => void }) {
  return (
    <div className="v2Stack">
      <div className="v2Intro">
        <h2>Strategy modules</h2>
        <p>Performance and live position status for every paper bot.</p>
      </div>
      <section className="v2Bots full">
        {bots.map((bot) => <BotCard key={bot.id} bot={bot} now={now} open={() => open(bot.id)} />)}
      </section>
    </div>
  );
}

function BotCard({ bot, now, open }: { bot: Bot; now: number; open: () => void }) {
  const state = botStatus(bot);
  return (
    <article className="v2Panel v2Bot">
      <div className="v2BotHead">
        <Icon id={bot.id} />
        <div>
          <h3>{bot.name}</h3>
          <p>{bot.subtitle}</p>
          <small>{bot.version}</small>
        </div>
        <span className={`v2Badge ${state.tone}`}>{state.label}</span>
      </div>
      {bot.openPositions > 0 ? (
        <div className="v2Toast ok">
          <strong>● OPEN POSITION</strong>
          <br />
          {bot.positions.map((position, index) => {
            const url = chartUrl(position);
            const label = `${positionSymbol(position)} · ${positionSize(position).toFixed(3)} SOL`;
            return url ? (
              <span key={position.position_id ?? `${position.mint}-${index}`}>
                {index > 0 ? " · " : ""}
                <a href={url} target="_blank" rel="noreferrer" style={{ color: "inherit", textDecoration: "underline" }} title="Open exact DexScreener chart">
                  {label} ↗
                </a>
              </span>
            ) : (
              <span key={position.position_id ?? `${position.mint}-${index}`}>{index > 0 ? " · " : ""}{label}</span>
            );
          })}
        </div>
      ) : (
        <div className="v2Toast">No open trade</div>
      )}
      <div className="v2BotStats">
        <div><small>PnL</small><strong className={bot.totalPnlSol >= 0 ? "positive" : "negative"}>{sol(bot.totalPnlSol)}</strong></div>
        <div><small>Win rate</small><strong>{pct(bot.winRate)}</strong></div>
        <div><small>PF</small><strong>{bot.profitFactor?.toFixed(2) ?? "—"}</strong></div>
      </div>
      <Chart values={series(bot.recentTrades, bot.totalPnlSol)} tone={bot.id} />
      <footer><span>Scan {age(bot.lastScanAt, now)}</span><button onClick={open}>Open</button></footer>
    </article>
  );
}

function Trades({ trades }: { trades: any[] }) {
  const [query, setQuery] = useState("");
  const filtered = trades.filter((trade) =>
    `${trade.token_symbol ?? ""} ${trade.botName ?? ""} ${trade.exit_reason ?? trade.reason ?? ""}`
      .toLowerCase()
      .includes(query.toLowerCase())
  );
  return (
    <div className="v2Stack">
      <div className="v2Intro split">
        <div><h2>Trade history</h2><p>Completed positions across all three strategies, with bot and trade time.</p></div>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search token, bot or exit" />
      </div>
      <section className="v2Panel"><TradeRows trades={filtered} /></section>
    </div>
  );
}

function TradeRows({ trades }: { trades: any[] }) {
  return (
    <div className="v2Trades">
      <div className="head"><span>Token</span><span>Bot / time</span><span>Exit</span><span>PnL</span></div>
      {trades.map((trade, index) => {
        const pnl = Number(trade.pnl ?? trade.pnl_sol ?? 0);
        const url = chartUrl(trade);
        const token = <><b>{trade.token_symbol ?? trade.symbol ?? "UNKNOWN"}{url ? " ↗" : ""}</b><small>{short(trade.mint ?? "")}</small></>;
        return (
          <div className="row" key={`${trade.botId}-${trade.id ?? index}`}>
            <span>{url ? <a href={url} target="_blank" rel="noreferrer" style={{ color: "inherit", textDecoration: "none" }} title="Open DexScreener chart">{token}</a> : token}</span>
            <span><b>{trade.botName ?? trade.botId ?? "Unknown bot"}</b><small>{exactIsraelTime(tradeTime(trade))}</small></span>
            <span>{String(trade.exit_reason ?? trade.reason ?? "—").replaceAll("_", " ")}</span>
            <strong className={pnl >= 0 ? "positive" : "negative"}>{sol(pnl)}</strong>
          </div>
        );
      })}
    </div>
  );
}

function Analytics({ data }: { data: Data }) {
  const ranked = [...data.bots].sort((a, b) => (b.profitFactor ?? 0) - (a.profitFactor ?? 0));
  const recent = data.overview.recent48hPnlSol;
  const previous = data.overview.previous48hPnlSol;
  const combinedStart = data.bots.reduce((sum, bot) => sum + bot.startingBankrollSol, 0);
  const combinedDrawdown = data.bots.reduce((sum, bot) => sum + bot.maxDrawdownSol, 0);
  const drawdownPct = combinedStart > 0 ? combinedDrawdown / combinedStart : 1;
  const goals = [
    { label: "300 completed trades", current: data.overview.completedTrades, target: 300, passed: data.overview.completedTrades >= 300 },
    { label: "Profit factor 1.30+", current: data.overview.profitFactor ?? 0, target: 1.3, passed: (data.overview.profitFactor ?? 0) >= 1.3 },
    { label: "Positive total PnL", current: data.overview.totalPnlSol, target: .001, passed: data.overview.totalPnlSol > 0 },
    { label: "Positive latest 48h", current: recent, target: .001, passed: recent > 0 },
    { label: "Drawdown below 10%", current: Math.max(0, .1 - drawdownPct), target: .1, passed: drawdownPct <= .1 },
  ];
  const progress = Math.round(goals.reduce((sum, goal) => sum + Math.min(1, Math.max(0, goal.current / goal.target)), 0) / goals.length * 100);
  let label = "Stable";
  let tone = "";
  if (recent < 0) { label = "Weakening"; tone = "negative"; }
  else if (recent - previous > .05) { label = "Improving"; tone = "positive"; }
  else if (previous - recent > .05) { label = "Positive, but slowing"; tone = "amber"; }

  return (
    <div className="v2Stack">
      <div className="v2Intro"><h2>Performance analytics</h2><p>How every bot is doing and how close the system is to a cautious real-money pilot.</p></div>
      <section className="v2Panel v2Summary">
        <div>
          <small>Current direction</small>
          <h2 className={tone}>{label}</h2>
          <p>{label === "Improving" ? "Recent results are stronger than the previous period." : label === "Weakening" ? "The latest 48-hour result is negative and needs attention." : label === "Positive, but slowing" ? "Recent results remain profitable, but the pace has slowed." : "Performance is broadly unchanged."}</p>
        </div>
        <div className="v2SummaryGrid">
          <Kpi label="Last 24h" value={sol(data.overview.recent24hPnlSol)} tone={data.overview.recent24hPnlSol >= 0 ? "positive" : "negative"} sub="Combined" />
          <Kpi label="Last 48h" value={sol(recent)} tone={recent >= 0 ? "positive" : "negative"} sub="Combined" />
          <Kpi label="Strongest" value={ranked[0]?.name ?? "—"} sub={`PF ${ranked[0]?.profitFactor?.toFixed(2) ?? "—"}`} />
          <Kpi label="Goal progress" value={`${progress}%`} tone={progress >= 80 ? "positive" : progress < 50 ? "negative" : "amber"} sub={`${goals.filter((goal) => goal.passed).length}/${goals.length} checks passed`} />
        </div>
      </section>
      <section className="v2Panel">
        <Title title="Distance from our goal" sub="Minimum evidence before considering a small real-money pilot" />
        <div className="v2Trades">
          <div className="head"><span>Requirement</span><span>Status</span><span>Current</span><span>Target</span></div>
          {goals.map((goal) => (
            <div className="row" key={goal.label}>
              <span><b>{goal.label}</b></span>
              <span className={goal.passed ? "positive" : "amber"}>{goal.passed ? "Passed" : "Not yet"}</span>
              <span>{goal.label.includes("trades") ? data.overview.completedTrades : goal.label.includes("Profit") ? data.overview.profitFactor?.toFixed(2) ?? "—" : goal.label.includes("Drawdown") ? pct(drawdownPct) : goal.label.includes("latest") ? sol(recent) : sol(data.overview.totalPnlSol)}</span>
              <strong>{goal.label.includes("trades") ? "300" : goal.label.includes("Profit") ? "1.30" : goal.label.includes("Drawdown") ? "≤10%" : ">0"}</strong>
            </div>
          ))}
        </div>
      </section>
      <section className="v2Compare">
        {data.bots.map((bot) => (
          <article className="v2Panel" key={bot.id}>
            <div className="v2BotHead"><Icon id={bot.id} /><div><h3>{bot.name}</h3><p>{bot.completedTrades} completed · {bot.openPositions} open</p></div></div>
            {bot.openPositions > 0 && <div className="v2Toast ok">Open: {bot.positions.map(positionSymbol).join(", ")}</div>}
            <Chart values={series(bot.recentTrades, bot.totalPnlSol)} tone={bot.id} />
            <dl>
              <div><dt>PnL</dt><dd className={bot.totalPnlSol >= 0 ? "positive" : "negative"}>{sol(bot.totalPnlSol)}</dd></div>
              <div><dt>Profit factor</dt><dd>{bot.profitFactor?.toFixed(2) ?? "—"}</dd></div>
              <div><dt>Win rate</dt><dd>{pct(bot.winRate)}</dd></div>
              <div><dt>48h</dt><dd className={bot.recent48h.pnlSol >= 0 ? "positive" : "negative"}>{sol(bot.recent48h.pnlSol)}</dd></div>
              <div><dt>Drawdown</dt><dd>{bot.maxDrawdownSol.toFixed(3)} SOL</dd></div>
            </dl>
          </article>
        ))}
      </section>
    </div>
  );
}

function OpenPositions({ bot, now }: { bot: Bot; now: number }) {
  return (
    <section className="v2Panel">
      <Title title="Open positions" sub={bot.openPositions ? `${bot.openPositions} active trade${bot.openPositions === 1 ? "" : "s"} · click a row for the exact chart` : "No active trade"} />
      {bot.positions.length === 0 ? (
        <div className="v2Toast">This bot currently has no open position.</div>
      ) : (
        <div className="v2Trades">
          <div className="head"><span>Token / bot</span><span>Size</span><span>Entry price</span><span>Opened</span></div>
          {bot.positions.map((position, index) => {
            const openedAt = positionTime(position);
            const url = chartUrl(position);
            const content = (
              <>
                <span><b>{positionSymbol(position)}{url ? " ↗" : ""}</b><small>{bot.name} · {short(position.mint ?? "")}</small></span>
                <span>{positionSize(position).toFixed(3)} SOL</span>
                <span>{positionEntry(position) > 0 ? `$${positionEntry(position).toPrecision(5)}` : "—"}</span>
                <span><b>{openedAt ? age(openedAt, now) : "—"}</b><small>{exactIsraelTime(openedAt)}</small></span>
              </>
            );
            return url ? (
              <a
                className="row"
                key={position.position_id ?? `${position.mint}-${index}`}
                href={url}
                target="_blank"
                rel="noreferrer"
                style={{ color: "inherit", textDecoration: "none" }}
                title="Open exact DexScreener chart"
              >
                {content}
              </a>
            ) : (
              <div className="row" key={position.position_id ?? `${position.mint}-${index}`}>{content}</div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function BotDetail({ bot, now, back, control }: { bot: Bot; now: number; back: () => void; control: (bot: Bot, action: "resume" | "pause") => void }) {
  const state = botStatus(bot);
  const namedTrades = bot.recentTrades.map((trade) => ({ ...trade, botId: bot.id, botName: bot.name }));
  return (
    <main className="v2Detail">
      <button onClick={back}>← Back to platform</button>
      <section className="v2Panel v2DetailHead">
        <Icon id={bot.id} />
        <div><h1>{bot.name}</h1><p>{bot.subtitle}</p><small>{bot.version}</small></div>
        <span className={`v2Badge ${state.tone}`}>{state.label}</span>
      </section>
      <section className="v2Kpis">
        <Kpi label="Bankroll" value={`${bot.bankrollSol.toFixed(3)} SOL`} sub={`Started ${bot.startingBankrollSol.toFixed(3)}`} />
        <Kpi label="PnL" value={sol(bot.totalPnlSol)} tone={bot.totalPnlSol >= 0 ? "positive" : "negative"} sub={`${bot.completedTrades} trades`} />
        <Kpi label="Open positions" value={String(bot.openPositions)} tone={bot.openPositions > 0 ? "positive" : undefined} sub={bot.openPositions > 0 ? "Currently in market" : "No active trade"} />
        <Kpi label="Profit factor" value={bot.profitFactor?.toFixed(2) ?? "—"} sub={`Drawdown ${bot.maxDrawdownSol.toFixed(3)}`} />
      </section>
      <OpenPositions bot={bot} now={now} />
      <section className="v2Panel"><Title title="Equity curve" sub={`Last scan ${age(bot.lastScanAt, now)}`} /><Chart values={series(bot.recentTrades, bot.totalPnlSol)} tone={bot.id} large /></section>
      <div className="v2Actions"><button onClick={() => control(bot, "resume")}>Resume</button><button className="danger" onClick={() => control(bot, "pause")}>Pause</button></div>
      <section className="v2Panel"><Title title="Recent trades" sub="Latest completed positions with bot name and Israel time" /><TradeRows trades={namedTrades} /></section>
    </main>
  );
}
