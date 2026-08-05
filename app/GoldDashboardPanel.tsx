"use client";

import { CSSProperties, useCallback, useEffect, useMemo, useState } from "react";

type GoldDashboardData = {
  configured: boolean;
  generatedAt: string;
  status: "running" | "paused" | "stale" | "setup_required";
  message?: string;
  state?: any;
  openPosition?: any | null;
  recentTrades?: any[];
  equityCurve?: Array<{ time: string; equityUsd: number }>;
  stats?: {
    balanceUsd: number;
    startingBalanceUsd: number;
    totalPnlUsd: number;
    todayPnlUsd: number;
    returnPct: number;
    completed: number;
    wins: number;
    losses: number;
    winRate: number;
    profitFactor: number | null;
    expectancyUsd: number;
    maxDrawdownUsd: number;
    maxDrawdownPct: number;
  };
};

const n = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const signedMoney = (value: number) => `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`;
const money = (value: number) => `$${Math.abs(value).toFixed(2)}`;
const percent = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
const goldPrice = (value: unknown) => (n(value) > 0 ? `$${n(value).toFixed(2)}` : "—");
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

export default function GoldDashboardPanel() {
  const [data, setData] = useState<GoldDashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/gold-dashboard", { cache: "no-store" });
      if (response.status === 401) return;
      if (!response.ok) throw new Error("Could not load Gold dashboard");
      setData(await response.json());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load Gold dashboard");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  if (!data) {
    return (
      <section style={styles.section}>
        <div style={styles.card}>
          <small style={styles.eyebrow}>XAUUSD GOLD TRADER</small>
          <h2 style={styles.heading}>Loading Gold dashboard…</h2>
          {error && <p style={styles.loss}>{error}</p>}
        </div>
      </section>
    );
  }

  if (!data.configured || !data.stats) {
    return (
      <section style={styles.section}>
        <div style={{ ...styles.card, ...styles.setupCard }}>
          <Header status="setup_required" />
          <div style={styles.setupMessage}>
            <strong>Dashboard code is ready.</strong>
            <span>{data.message ?? "Apply the Gold migration and start the paper service."}</span>
          </div>
          {error && <p style={styles.loss}>{error}</p>}
        </div>
      </section>
    );
  }

  const stats = data.stats;
  const state = data.state ?? {};
  const open = data.openPosition;
  const trades = data.recentTrades ?? [];

  return (
    <section style={styles.section}>
      <Header status={data.status} />

      {error && <div style={styles.error}>{error}</div>}
      {state.paused && (
        <div style={styles.pauseBanner}>
          <strong>Trading paused</strong>
          <span>{String(state.pause_reason ?? "Risk lock active").replaceAll("_", " ")}</span>
        </div>
      )}

      <div style={styles.grid}>
        <Stat label="Balance" value={money(stats.balanceUsd)} />
        <Stat label="Total PnL" value={signedMoney(stats.totalPnlUsd)} tone={stats.totalPnlUsd >= 0 ? "win" : "loss"} />
        <Stat label="Today" value={signedMoney(stats.todayPnlUsd)} tone={stats.todayPnlUsd >= 0 ? "win" : "loss"} />
        <Stat label="Return" value={percent(stats.returnPct)} tone={stats.returnPct >= 0 ? "win" : "loss"} />
        <Stat label="Win rate" value={`${(stats.winRate * 100).toFixed(1)}%`} />
        <Stat label="Profit factor" value={stats.profitFactor == null ? "∞" : stats.profitFactor.toFixed(2)} />
        <Stat label="Max drawdown" value={`${money(stats.maxDrawdownUsd)} · ${stats.maxDrawdownPct.toFixed(2)}%`} tone="loss" />
        <Stat label="Closed trades" value={String(stats.completed)} />
      </div>

      <div style={styles.twoColumn}>
        <div style={styles.card}>
          <div style={styles.cardHeader}>
            <div>
              <small style={styles.eyebrow}>{open ? "OPEN GOLD POSITION" : "GOLD SCANNER"}</small>
              <h3 style={styles.heading}>{open ? `${String(open.side).toUpperCase()} ${open.instrument}` : "Waiting for the next setup"}</h3>
            </div>
            <strong style={{ color: open ? "#f2c968" : "#8997aa" }}>{open ? "ACTIVE" : "SCANNING"}</strong>
          </div>

          {open ? (
            <div style={styles.positionGrid}>
              <Item label="Units" value={n(open.units).toFixed(2)} />
              <Item label="Entry" value={goldPrice(open.entry_price)} />
              <Item label="Stop loss" value={goldPrice(open.stop_loss)} />
              <Item label="Take profit" value={goldPrice(open.take_profit)} />
              <Item label="Entry spread" value={goldPrice(open.entry_spread)} />
              <Item label="Opened" value={israelTime(open.opened_at)} />
              <Item label="Strategy" value={String(open.strategy_version ?? "—")} />
              <Item label="Position ID" value={String(open.id ?? "—")} />
            </div>
          ) : (
            <div style={styles.emptyState}>
              Watching completed 15-minute candles for an EMA trend pullback and confirmation. No trade is forced.
            </div>
          )}
        </div>

        <div style={styles.card}>
          <div style={styles.cardHeader}>
            <div>
              <small style={styles.eyebrow}>EQUITY</small>
              <h3 style={styles.heading}>Realized balance curve</h3>
            </div>
            <small style={styles.muted}>Last candle {israelTime(state.last_processed_candle_time)}</small>
          </div>
          <EquityChart startingBalance={stats.startingBalanceUsd} balance={stats.balanceUsd} points={data.equityCurve ?? []} />
        </div>
      </div>

      <div style={styles.card}>
        <div style={styles.cardHeader}>
          <div>
            <small style={styles.eyebrow}>GOLD TRADE HISTORY</small>
            <h3 style={styles.heading}>Recent XAUUSD trades</h3>
          </div>
          <small style={styles.muted}>Israel time</small>
        </div>

        <div style={styles.tradeList}>
          {trades.length === 0 ? (
            <div style={styles.emptyState}>No closed Gold trades yet.</div>
          ) : (
            trades.slice(0, 15).map((trade) => {
              const tradePnl = n(trade.realized_pnl_usd);
              const won = tradePnl > 0;
              const lost = tradePnl < 0;
              return (
                <article key={trade.id} style={{ ...styles.trade, borderLeftColor: won ? "#61e6a7" : lost ? "#ff7b8d" : "#596579" }}>
                  <div style={styles.tradeResult}>
                    <strong style={{ color: won ? "#61e6a7" : lost ? "#ff7b8d" : "#f4f7fb" }}>
                      {won ? "WIN" : lost ? "LOSS" : "FLAT"}
                    </strong>
                    <small style={styles.small}>{String(trade.side ?? "—").toUpperCase()}</small>
                  </div>
                  <div style={styles.tradeDetails}>
                    <strong>{trade.instrument ?? "XAU_USD"}</strong>
                    <small style={styles.small}>
                      {goldPrice(trade.entry_price)} → {goldPrice(trade.exit_price)} · {n(trade.units).toFixed(2)} units
                    </small>
                    <small style={styles.small}>
                      {String(trade.close_reason ?? "closed").replaceAll("_", " ")} · {israelTime(trade.closed_at)}
                    </small>
                  </div>
                  <strong style={{ color: won ? "#61e6a7" : lost ? "#ff7b8d" : "#f4f7fb", marginLeft: "auto" }}>
                    {signedMoney(tradePnl)}
                  </strong>
                </article>
              );
            })
          )}
        </div>
      </div>

      <div style={styles.footerLine}>
        <span>Risk: 0.25% default</span>
        <span>Daily lock: 1% default</span>
        <span>One position maximum</span>
        <span>Synced {israelTime(data.generatedAt)}</span>
      </div>
    </section>
  );
}

function Header({ status }: { status: GoldDashboardData["status"] }) {
  return (
    <div style={styles.goldHeader}>
      <div>
        <small style={styles.eyebrow}>XAUUSD GOLD TRADER</small>
        <h2 style={styles.goldTitle}>Gold Paper Dashboard</h2>
        <p style={styles.muted}>EMA20/EMA50 pullback · M15 · Refreshes every 5 seconds</p>
      </div>
      <div style={styles.headerBadges}>
        <span style={styles.readOnlyBadge}>PAPER ONLY · READ ONLY</span>
        <StatusBadge status={status} />
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: GoldDashboardData["status"] }) {
  const config = {
    running: { label: "● RUNNING", color: "#61e6a7" },
    paused: { label: "● PAUSED", color: "#ff7b8d" },
    stale: { label: "● STALE", color: "#f2c968" },
    setup_required: { label: "● SETUP REQUIRED", color: "#aab4c3" },
  }[status];
  return <span style={{ ...styles.statusBadge, color: config.color }}>{config.label}</span>;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "win" | "loss" }) {
  return (
    <div style={styles.stat}>
      <small style={styles.muted}>{label}</small>
      <strong style={{ fontSize: 23, color: tone === "win" ? "#61e6a7" : tone === "loss" ? "#ff7b8d" : "#f4f7fb" }}>{value}</strong>
    </div>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.item}>
      <small style={styles.muted}>{label}</small>
      <strong style={{ overflowWrap: "anywhere" }}>{value}</strong>
    </div>
  );
}

function EquityChart({ startingBalance, balance, points }: { startingBalance: number; balance: number; points: Array<{ time: string; equityUsd: number }> }) {
  const chart = useMemo(() => {
    const series = [{ time: "start", equityUsd: startingBalance }, ...points];
    if (series.length < 2) return null;
    const values = series.map((point) => point.equityUsd);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = Math.max(max - min, Math.max(Math.abs(max), 1) * 0.005);
    const coordinates = series.map((point, index) => {
      const x = 10 + (index / Math.max(series.length - 1, 1)) * 980;
      const y = 170 - ((point.equityUsd - min) / range) * 160;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return { coordinates: coordinates.join(" "), min, max };
  }, [points, startingBalance]);

  if (!chart) return <div style={styles.emptyChart}>The equity curve will appear after the first closed trade.</div>;

  const positive = balance >= startingBalance;
  return (
    <div>
      <svg viewBox="0 0 1000 180" role="img" aria-label="Gold paper balance curve" style={styles.chart} preserveAspectRatio="none">
        <line x1="0" y1="179" x2="1000" y2="179" stroke="#2a374b" strokeWidth="2" />
        <polyline points={chart.coordinates} fill="none" stroke={positive ? "#61e6a7" : "#ff7b8d"} strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <div style={styles.chartLegend}>
        <span>Low {money(chart.min)}</span>
        <strong style={{ color: positive ? "#61e6a7" : "#ff7b8d" }}>{money(balance)}</strong>
        <span>High {money(chart.max)}</span>
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  section: { marginTop: 34, paddingTop: 28, borderTop: "1px solid #2b3545" },
  goldHeader: { display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 16 },
  goldTitle: { margin: "5px 0", fontSize: "clamp(27px, 6vw, 38px)", letterSpacing: "-0.035em", color: "#f2c968" },
  eyebrow: { color: "#c9a64d", fontWeight: 800, letterSpacing: "0.12em" },
  heading: { margin: "6px 0 0", fontSize: 22 },
  muted: { color: "#8997aa" },
  loss: { color: "#ff7b8d" },
  headerBadges: { display: "flex", flexWrap: "wrap", gap: 8 },
  readOnlyBadge: { border: "1px solid #725f2e", background: "#1a170d", color: "#f2c968", borderRadius: 999, padding: "9px 12px", fontSize: 12, fontWeight: 900, whiteSpace: "nowrap" },
  statusBadge: { border: "1px solid #33445d", background: "#101925", borderRadius: 999, padding: "9px 12px", fontSize: 12, fontWeight: 900, whiteSpace: "nowrap" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 14 },
  stat: { minHeight: 101, padding: 16, borderRadius: 17, border: "1px solid #3f3724", background: "linear-gradient(145deg, #151b26, #111720)", display: "grid", gap: 8 },
  twoColumn: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 400px), 1fr))", gap: 14, marginBottom: 14 },
  card: { marginBottom: 14, padding: 19, borderRadius: 20, border: "1px solid #3b3527", background: "#111a27" },
  setupCard: { borderColor: "#5d512e", background: "linear-gradient(145deg, #171a20, #17140c)" },
  setupMessage: { display: "grid", gap: 7, padding: 16, borderRadius: 14, border: "1px solid #5d512e", background: "#0d121a", color: "#d9e0ea" },
  cardHeader: { display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 16 },
  pauseBanner: { display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 8, marginBottom: 14, padding: 13, borderRadius: 12, border: "1px solid #7f3342", background: "#251218", color: "#ff9baa" },
  error: { padding: 13, marginBottom: 14, borderRadius: 12, color: "#ff7b8d", border: "1px solid #6b2b38", background: "#211117" },
  positionGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(135px, 1fr))", gap: 9 },
  item: { padding: 13, borderRadius: 13, border: "1px solid #2f3b4e", background: "#09111c", display: "grid", gap: 6 },
  emptyState: { padding: 16, borderRadius: 14, border: "1px dashed #3a4658", background: "#0b121c", color: "#8997aa", lineHeight: 1.55 },
  emptyChart: { minHeight: 180, display: "grid", placeItems: "center", textAlign: "center", padding: 18, borderRadius: 14, background: "#09111c", color: "#8997aa" },
  chart: { width: "100%", height: 180, display: "block", borderRadius: 14, background: "linear-gradient(180deg, rgba(242,201,104,0.08), rgba(9,17,28,0.15))" },
  chartLegend: { display: "flex", justifyContent: "space-between", gap: 8, marginTop: 9, color: "#78869a", fontSize: 12 },
  tradeList: { display: "grid", gap: 9 },
  trade: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, padding: 13, borderRadius: 13, border: "1px solid #29364a", borderLeftWidth: 4, background: "#09111c" },
  tradeResult: { width: 58 },
  tradeDetails: { flex: "1 1 180px", minWidth: 0 },
  small: { display: "block", color: "#78869a", marginTop: 4, fontSize: 12, overflowWrap: "anywhere" },
  footerLine: { display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 8, color: "#718096", fontSize: 12, padding: "2px 4px 8px" },
};
