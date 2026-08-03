"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type Trade = {
  id: number;
  symbol?: string | null;
  status?: string | null;
  exit_reason?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  size_usdc?: number | string | null;
  pnl_usdc?: number | string | null;
  pnl_pct?: number | string | null;
};

type DashboardData = {
  generatedAt: string;
  state: Record<string, any>;
  openPosition: Record<string, any> | null;
  trades: Trade[];
  stats: {
    completed: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnlUsdc: number;
    cashUsdc: number;
    startingCashUsdc: number;
    returnPct?: number;
    grossProfit?: number;
    grossLoss?: number;
    profitFactor?: number | null;
    averageWinUsdc?: number;
    averageLossUsdc?: number;
    expectancyUsdc?: number;
    bestTrade?: { symbol: string; pnlUsdc: number; pnlPct: number } | null;
    worstTrade?: { symbol: string; pnlUsdc: number; pnlPct: number } | null;
  };
};

const palette = {
  bg: "#070b12",
  panel: "#101925",
  panel2: "#0a111c",
  border: "#223044",
  text: "#f7f9fc",
  muted: "#8f9db2",
  green: "#63eead",
  red: "#ff7d8f",
};

const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const signedMoney = (value: number) => `${value >= 0 ? "+" : "−"}$${Math.abs(value).toFixed(3)}`;
const money = (value: number) => `$${Math.abs(value).toFixed(3)}`;
const percentage = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
const israelTime = (value?: string | null) => {
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
      setData((await response.json()) as DashboardData);
      setNeedsLogin(false);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load dashboard");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const login = async (event: FormEvent<HTMLFormElement>) => {
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

  const trades = useMemo(() => {
    if (!data) return [];
    return data.trades.filter((trade) => {
      const pnl = num(trade.pnl_usdc);
      if (filter === "wins") return pnl > 0;
      if (filter === "losses") return pnl < 0;
      return true;
    });
  }, [data, filter]);

  if (!data) {
    return (
      <main style={styles.center}>
        {needsLogin ? (
          <form onSubmit={login} style={styles.loginCard}>
            <h1 style={styles.loginTitle}>Solana Market Bot</h1>
            <p style={styles.muted}>Private performance dashboard</p>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Dashboard password"
              autoFocus
              style={styles.input}
            />
            <button type="submit" style={styles.primaryButton}>Open dashboard</button>
            {error && <strong style={styles.negative}>{error}</strong>}
          </form>
        ) : (
          <div style={styles.loginCard}>
            <h2>Loading bot data…</h2>
            {error && <p style={styles.negative}>{error}</p>}
          </div>
        )}
      </main>
    );
  }

  const { stats, state } = data;
  const open = data.openPosition;
  const live = Date.now() - Date.parse(data.generatedAt) < 15000;
  const returnPct = num(stats.returnPct ?? (stats.startingCashUsdc ? (stats.totalPnlUsdc / stats.startingCashUsdc) * 100 : 0));
  const profitFactor = stats.profitFactor == null ? "∞" : num(stats.profitFactor).toFixed(2);

  return (
    <main style={styles.page}>
      <div style={styles.shell}>
        <header style={styles.header}>
          <div>
            <div style={styles.eyebrow}>SOLANA MARKET BOT</div>
            <h1 style={styles.title}>Performance Dashboard</h1>
            <p style={styles.muted}>Refreshes every 5 seconds · Israel time</p>
          </div>
          <div style={{ ...styles.status, ...(live ? styles.statusLive : styles.statusStale) }}>
            {live ? "● LIVE" : "● STALE"} · {String(state?.mode ?? "paper").toUpperCase()}
          </div>
        </header>

        {error && <div style={styles.errorBox}>{error}</div>}

        <section style={styles.heroGrid}>
          <div style={styles.heroCard}>
            <div style={styles.eyebrow}>TOTAL PERFORMANCE</div>
            <div style={{ ...styles.heroValue, color: stats.totalPnlUsdc >= 0 ? palette.green : palette.red }}>
              {signedMoney(stats.totalPnlUsdc)}
            </div>
            <strong style={{ color: returnPct >= 0 ? palette.green : palette.red }}>{percentage(returnPct)} return</strong>
            <div style={styles.miniGrid}>
              <Mini label="Cash" value={`$${stats.cashUsdc.toFixed(3)}`} />
              <Mini label="Starting" value={`$${stats.startingCashUsdc.toFixed(2)}`} />
              <Mini label="Completed" value={String(stats.completed)} />
            </div>
          </div>

          <div style={styles.heroCard}>
            <div style={styles.eyebrow}>WIN RATE</div>
            <div style={styles.heroValue}>{(stats.winRate * 100).toFixed(1)}%</div>
            <div style={styles.miniGrid}>
              <Mini label="Wins" value={String(stats.wins)} tone="positive" />
              <Mini label="Losses" value={String(stats.losses)} tone="negative" />
              <Mini label="Profit factor" value={profitFactor} />
            </div>
          </div>
        </section>

        <section style={styles.metricsGrid}>
          <Metric label="Average win" value={money(num(stats.averageWinUsdc))} tone="positive" />
          <Metric label="Average loss" value={money(num(stats.averageLossUsdc))} tone="negative" />
          <Metric label="Expectancy" value={signedMoney(num(stats.expectancyUsdc))} tone={num(stats.expectancyUsdc) >= 0 ? "positive" : "negative"} />
          <Metric label="Entries today" value={String(state?.entries_today ?? 0)} note={state?.halted ? `Halted: ${state?.halt_reason ?? "unknown"}` : "Scanner active"} />
          <Metric label="Gross profit" value={money(num(stats.grossProfit))} tone="positive" />
          <Metric label="Gross loss" value={money(num(stats.grossLoss))} tone="negative" />
          <Metric label="Best trade" value={stats.bestTrade ? `${stats.bestTrade.symbol} ${signedMoney(stats.bestTrade.pnlUsdc)}` : "—"} />
          <Metric label="Worst trade" value={stats.worstTrade ? `${stats.worstTrade.symbol} ${signedMoney(stats.worstTrade.pnlUsdc)}` : "—"} />
        </section>

        <section style={{ ...styles.card, borderColor: open ? "rgba(99,238,173,.45)" : palette.border }}>
          <div style={styles.cardHeader}>
            <div>
              <div style={styles.eyebrow}>{open ? "● OPEN POSITION" : "SCANNER STATUS"}</div>
              <h2 style={styles.cardTitle}>{open ? String(open.symbol ?? "Unknown token") : "Waiting for the next setup"}</h2>
            </div>
            <strong style={{ color: open ? palette.green : palette.muted }}>{open ? "ACTIVE NOW" : "SCANNING"}</strong>
          </div>
          {open ? (
            <div style={styles.positionGrid}>
              <Position label="Size" value={`$${num(open.sizeUsdc ?? open.size_usdc).toFixed(2)}`} />
              <Position label="Score" value={String(open.score ?? "—")} />
              <Position label="Entry price" value={`$${num(open.entryPriceUsd ?? open.entry_price_usd).toPrecision(6)}`} />
              <Position label="High-water" value={`$${num(open.highWaterPriceUsd ?? open.high_water_price_usd).toPrecision(6)}`} />
              <Position label="Opened" value={israelTime(open.openedAt ?? open.opened_at ?? open.created_at)} />
              <Position label="Token" value={String(open.name ?? open.symbol ?? "—")} />
              <Position label="Mint" value={String(open.mint ?? "—")} />
              <Position label="Trade ID" value={String(open.tradeId ?? open.trade_id ?? "—")} />
            </div>
          ) : (
            <p style={styles.muted}>The worker is alive and checking the market.</p>
          )}
        </section>

        <section style={styles.card}>
          <div style={styles.cardHeader}>
            <div>
              <div style={styles.eyebrow}>RECENT ACTIVITY</div>
              <h2 style={styles.cardTitle}>Trade history</h2>
            </div>
            <div style={styles.filters}>
              {(["all", "wins", "losses"] as const).map((item) => (
                <button key={item} onClick={() => setFilter(item)} style={{ ...styles.filterButton, ...(filter === item ? styles.filterActive : {}) }}>
                  {item.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <div style={styles.tradeList}>
            {trades.map((trade) => {
              const pnl = num(trade.pnl_usdc);
              const win = pnl > 0;
              const loss = pnl < 0;
              return (
                <article key={trade.id} style={{ ...styles.tradeRow, borderLeftColor: win ? palette.green : loss ? palette.red : palette.border }}>
                  <div>
                    <strong style={{ color: win ? palette.green : loss ? palette.red : palette.text }}>{win ? "WIN" : loss ? "LOSS" : "FLAT"}</strong>
                    <small style={styles.smallMuted}>#{trade.id}</small>
                  </div>
                  <div style={styles.tradeMain}>
                    <strong>{trade.symbol ?? "UNKNOWN"}</strong>
                    <small style={styles.smallMuted}>{String(trade.exit_reason ?? trade.status ?? "—").replaceAll("_", " ")} · {israelTime(trade.updated_at ?? trade.created_at)}</small>
                  </div>
                  <div style={styles.tradeCell}><small style={styles.smallMuted}>Return</small><strong>{percentage(num(trade.pnl_pct))}</strong></div>
                  <strong style={{ color: win ? palette.green : loss ? palette.red : palette.text, textAlign: "right" }}>{signedMoney(pnl)}</strong>
                </article>
              );
            })}
            {trades.length === 0 && <p style={styles.muted}>No trades match this filter.</p>}
          </div>
        </section>

        <footer style={styles.footer}>Updated {israelTime(data.generatedAt)} · Last scan {israelTime(state?.last_scan_at)}</footer>
      </div>
    </main>
  );
}

function Metric({ label, value, tone, note }: { label: string; value: string; tone?: "positive" | "negative"; note?: string }) {
  return (
    <div style={styles.metric}>
      <span style={styles.metricLabel}>{label}</span>
      <strong style={{ ...styles.metricValue, color: tone === "positive" ? palette.green : tone === "negative" ? palette.red : palette.text }}>{value}</strong>
      {note && <small style={styles.smallMuted}>{note}</small>}
    </div>
  );
}

function Mini({ label, value, tone }: { label: string; value: string; tone?: "positive" | "negative" }) {
  return <div><span style={styles.smallMuted}>{label}</span><strong style={{ display: "block", marginTop: 4, color: tone === "positive" ? palette.green : tone === "negative" ? palette.red : palette.text }}>{value}</strong></div>;
}

function Position({ label, value }: { label: string; value: string }) {
  return <div style={styles.positionItem}><small style={styles.smallMuted}>{label}</small><strong style={{ overflowWrap: "anywhere" }}>{value}</strong></div>;
}

const styles: Record<string, React.CSSProperties> = {
  page: { minHeight: "100vh", background: palette.bg, color: palette.text, padding: "24px 14px 50px", fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" },
  shell: { maxWidth: 1180, margin: "0 auto" },
  center: { minHeight: "100vh", display: "grid", placeItems: "center", background: palette.bg, color: palette.text, padding: 20, fontFamily: "Inter, sans-serif" },
  loginCard: { width: "min(420px, 100%)", background: palette.panel, border: `1px solid ${palette.border}`, borderRadius: 20, padding: 26, display: "grid", gap: 14 },
  loginTitle: { margin: 0 },
  input: { padding: 14, borderRadius: 12, border: `1px solid ${palette.border}`, background: palette.panel2, color: palette.text },
  primaryButton: { padding: 14, border: 0, borderRadius: 12, background: palette.green, color: "#06100b", fontWeight: 900 },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap", marginBottom: 20 },
  title: { margin: "5px 0 4px", fontSize: "clamp(30px, 6vw, 46px)", letterSpacing: "-0.04em" },
  eyebrow: { fontSize: 12, fontWeight: 900, letterSpacing: "0.14em", color: palette.muted },
  muted: { color: palette.muted, margin: 0 },
  smallMuted: { display: "block", color: palette.muted, fontSize: 12, marginTop: 4 },
  status: { borderRadius: 999, padding: "10px 14px", fontWeight: 900, whiteSpace: "nowrap" },
  statusLive: { color: palette.green, border: "1px solid rgba(99,238,173,.35)", background: "rgba(99,238,173,.09)" },
  statusStale: { color: palette.red, border: "1px solid rgba(255,125,143,.35)", background: "rgba(255,125,143,.09)" },
  errorBox: { marginBottom: 16, padding: 13, borderRadius: 14, border: "1px solid rgba(255,125,143,.35)", color: palette.red },
  heroGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14, marginBottom: 14 },
  heroCard: { background: palette.panel, border: `1px solid ${palette.border}`, borderRadius: 22, padding: 22 },
  heroValue: { fontSize: "clamp(42px, 9vw, 68px)", fontWeight: 950, letterSpacing: "-0.05em", margin: "12px 0 6px" },
  miniGrid: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12, marginTop: 22 },
  metricsGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 14 },
  metric: { background: palette.panel, border: `1px solid ${palette.border}`, borderRadius: 16, padding: 16, minHeight: 100 },
  metricLabel: { color: palette.muted, fontSize: 13 },
  metricValue: { display: "block", fontSize: 23, marginTop: 9, overflowWrap: "anywhere" },
  card: { background: palette.panel, border: `1px solid ${palette.border}`, borderRadius: 20, padding: 20, marginBottom: 14 },
  cardHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, flexWrap: "wrap", marginBottom: 16 },
  cardTitle: { margin: "5px 0 0", fontSize: 24 },
  positionGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 },
  positionItem: { display: "grid", gap: 6, background: palette.panel2, border: `1px solid ${palette.border}`, borderRadius: 14, padding: 14 },
  filters: { display: "flex", gap: 7, flexWrap: "wrap" },
  filterButton: { border: `1px solid ${palette.border}`, background: palette.panel2, color: palette.muted, borderRadius: 999, padding: "8px 12px", fontWeight: 800 },
  filterActive: { background: palette.text, color: palette.bg },
  tradeList: { display: "grid", gap: 9 },
  tradeRow: { display: "grid", gridTemplateColumns: "65px minmax(120px, 1fr) 80px 95px", alignItems: "center", gap: 10, background: palette.panel2, border: `1px solid ${palette.border}`, borderLeftWidth: 4, borderRadius: 14, padding: 13 },
  tradeMain: { minWidth: 0, overflowWrap: "anywhere" },
  tradeCell: { textAlign: "left" },
  footer: { color: palette.muted, textAlign: "center", fontSize: 12, paddingTop: 8 },
  positive: { color: palette.green },
  negative: { color: palette.red },
};
