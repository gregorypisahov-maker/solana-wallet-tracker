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
  recentEvents?: any[];
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
    grossProfitUsd: number;
    grossLossUsd: number;
    profitFactor: number | null;
    expectancyUsd: number;
    maxDrawdownUsd: number;
    maxDrawdownPct: number;
  };
};

const n = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const money = (value: number, digits = 2) => `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(digits)}`;
const plainMoney = (value: number, digits = 2) => `$${Math.abs(value).toFixed(digits)}`;
const pct = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
const price = (value: unknown) => {
  const parsed = n(value);
  return parsed > 0 ? parsed.toFixed(2) : "—";
};
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
          <div style={styles.cardHeader}>
            <div>
              <small style={styles.eyebrow}>XAUUSD GOLD TRADER</small>
              <h2 style={styles.heading}>Gold paper trader</h2>
              <p style={styles.muted}>M15 strategy · Paper only · Read only</p>
            </div>
            <StatusBadge status="setup_required" />
          </div>
          <div style={styles.setupMessage}>
            <strong>Dashboard code is ready.</strong>
            <span>{data.message ?? "Apply the Gold migration and start the paper service to begin collecting trades."}</span>
          </div>
          {error && <p style={styles.loss}>{error}</p>}
        </div>
      </section>
    );
  }

  const stats = data.stats;
  const open = data.openPosition;
  const trades = data.recentTrades ?? [];
  const state = data.state ?? {};

  return (
    <section style={styles.section}>
      <div style={styles.goldHeader}>
        <div>
          <small style={styles.eyebrow}>XAUUSD GOLD TRADER</small>
          <h2 style={styles.goldTitle}>Gold Paper Dashboard</h2>
          <p style={styles.muted}>EMA20/EMA50 pullback · M15 · Refreshes every 5 seconds</p>
        </div>
        <div style={styles.headerBadges}>
          <span style={styles.readOnlyBadge}>PAPER ONLY · READ ONLY</span>
          <StatusBadge status={data.status} />
        </div>
      </div>

      {error && <div style={styles.error}>{error}</div>}
      {state.paused && (
        <div style={styles.pauseBanner}>
          <strong>Trading paused</strong>
          <span>{String(state.pause_reason ?? "Risk lock active").replaceAll("_", " ")}</span>
        </div>
      )}

      <div style={styles.grid}>
        <GoldStat label="Balance" value={plainMoney(stats.balanceUsd)} />
        <GoldStat label="Total PnL" value={money(stats.totalPnlUsd)} tone={stats.totalPnlUsd >= 0 ? "win" : "loss"} />
        <GoldStat label="Today" value={money(stats.todayPnlUsd)} tone={stats.todayPnlUsd >= 0 ? "win" : "loss"} />
        <GoldStat label="Return" value={pct(stats.returnPct)} tone={stats.returnPct >= 0 ? "win" : "loss"} />
        <GoldStat label="Win rate" value={`${(stats.winRate * 100).toFixed(1)}%`} />
        <GoldStat label="Profit factor" value={stats.profitFactor == null ? "∞" : stats.profitFactor.toFixed(2)} />
        <GoldStat label="Max drawdown" value={`${plainMoney(stats.maxDrawdownUsd)} · ${stats.maxDrawdownPct.toFixed(2)}%`} tone="loss" />
        <GoldStat label="Closed trades" value={String(stats.completed)} />
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
              <GoldItem label="Units" value={n(open.units).toFixed(2)} />
              <GoldItem label="Entry" value={`$${price(open.entry_price)}`} />
              <GoldItem label="Stop loss" value={`$${price(open.stop_loss)}`} />
              <GoldItem label="Take profit" value={`$${price(open.take_profit)}`} />
              <GoldItem label="Entry spread" value={`$${n(open.entry_spread).toFixed(2)}`} />
              <GoldItem label="Opened" value={israelTime(open.opened_at)} />
              <GoldItem label="Strategy" value={String(open.strategy_version ?? "—")} />
              <GoldItem label="Position ID" value={String(open.id ?? "—")} />
            </div>
          ) : (
            <div style={styles.emptyState}>
              The bot is watching completed 15-minute candles for a trend pullback and confirmation. No trade is forced.
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
          <EquityChart
            startingBalance={stats.startingBalanceUsd}
            balance={stats.balanceUsd}
            points={data.equityCurve ?? []}
          />
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
                <article
                  key={trade.id}
                  style={{
                    ...styles.trade,
                    borderLeftColor: won ? "#61e6a7" : lost ? "#ff7b8d" : "#596579",
                  }}
                >
                  <div>
                    <strong style={{ color: won ? "#61e6a7" : lost ? "#ff7b8d" : "#f4f7fb" }}>
                      {won ? "WIN" : lost ? "LOSS" : "FLAT"}
                    </strong>
                    <small style={styles.small}>{String(trade.side ?? "—").toUpperCase()}</small>
                  </div>
                  <div>
                    <strong>{trade.instrument ?? "XAU_USD"}</strong>
                    <small style={styles.small}>
                      {String(trade.close_reason ?? "closed").replaceAll("_", " ")} · {israelTime(trade.closed_at)}
                    </small>
                  </div>
                  <div style={styles.tradePrice}>
                    <strong>${price(trade.entry_price)} → ${price(trade.exit_price)}</strong>
                    <small style={styles.small}>{n(trade.units).toFixed(2)} units</small>
                  </div>
                  <strong style={{ color: won ? "#61e6a7" : lost ? "#ff7b8d" : "#f4f7fb", textAlign: "right" }}>
                    {money(tradePnl)}
                  </strong>
                </article>
              );
            })
          )}
        </div>
      </div>

      <div style={styles.footerLine}>
        <span>Risk per trade: 0.25% default</span>
        <span>Daily loss lock: 1% default</span>
        <span>One open position maximum</span>
        <span>Last sync: {israelTime(data.generatedAt)}</span>
      </div>
    </section>
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

function GoldStat({ label, value, tone }: { label: string; value: string; tone?: "win" | "loss" }) {
  return (
    <div style={styles.stat}>
      <small style={styles.muted}>{label}</small>
      <strong style={{ fontSize: 23, color: tone === "win" ? "#61e6a7" : tone === "loss" ? "#ff7b8d" : "#f4f7fb" }}>
        {value}
      </strong>
    </div>
  );
}

function GoldItem({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.item}>
      <small style={styles.muted}>{label}</small>
      <strong style={{ overflowWrap: "anywhere" }}>{value}</strong>
    </div>
  );
}

function EquityChart({
  startingBalance,
  balance,
  points,
}: {
  startingBalance: number;
  balance: number;
  points: Array<{ time: string; equityUsd: number }>;
}) {
  const chart = useMemo(() => {
    const series = [{ time: "start", equityUsd: startingBalance }, ...points];
    if (series.length < 2) return null;
    const values = series.map((point) => point.equityUsd);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = Math.max(max - min, Math.max(Math.abs(max), 1) * 0.005);
    const width = 1000;
    const height = 180;
    const padding = 10;
    const coordinates = series.map((point, index) => {
      const x = padding + (index / Math.max(series.length - 1, 1)) * (width - padding * 2);
      const y = height - padding - ((point.equityUsd - min) / range) * (height - padding * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return { coordinates: coordinates.join(" "), min, max };
  }, [points, startingBalance]);

  if (!chart) {
    return <div style={styles.emptyChart}>The equity curve will appear after the first closed trade.</div>;
  }

  const positive = balance >= startingBalance;
  return (
    <div>
      <svg viewBox="0 0 1000 180" role="img" aria-label="Gold paper balance curve" style={styles.chart} preserveAspectRatio="none">
        <line x1="0" y1="179" x2="1000" y2="179" stroke="#2a374b" strokeWidth="2" />
        <polyline
          points={chart.coordinates}
          fill="none"
          stroke={positive ? "#61e6a7" : "#ff7b8d"}
          strokeWidth="6"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div style={styles.chartLegend}>
        <span>Low {plainMoney(chart.min)}</span>
        <strong style={{ color: positive ? "#61e6a7" : "#ff7b8d" }}>{plainMoney(balance)}</strong>
        <span>High {plainMoney(chart.max)}</span>
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  section: { marginTop: 34, paddingTop: 28, borderTop: "1px solid #2b3545" },
  goldHeader: { display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 16 },
  goldTitle: { margin: "5px 0", fontSize: "clamp(27px, 6vw, 38px)", letterSpacing: "-0.035em", color: "#f2c968" },
  eyebrow: { color: "#c9a64d", fontWeight: 800, letterSpacing: "0.12em" },
  muted: { color: "#8997aa" },
  loss: { color: "#ff7b8d" },
  headerBadges: { display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 8 },
  readOnlyBadge: { border: "1px solid #725f2e", background: "#1a170d", color: "#f2c968", borderRadius: 999, padding: "9px 12px", fontSize: 12, fontWeight: 900, whiteSpace: "nowrap" },
  statusBadge: { border: "1px solid #33445d", background: "#101925", borderRadius: 999, padding: "9px 12px", fontSize: 12, fontWeight: 900, whiteSpace: "nowrap" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(145px, 1fr))", gap: 10, marginBottom: 14 },
  stat: { minHeight: 101, padding: 16, borderRadius: 17, border: "1px solid #3f3724", background: "linear-gradient(145deg, #151b26, #111720)", display: "grid", gap: 8 },
  twoColumn: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 14, marginBottom: 14 },
  card: { marginBottom: 14, padding: 19, borderRadius: 20, border: "1px solid #3b3527", background: "#111a27" },
  setupCard: { borderColor: "#5d512e", background: "linear-gradient(145deg, #171a20, #17140c)" },
  cardHeader: { display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 16 },
  heading: { margin: "6px 0 0", fontSize: 22 },
  setupMessage: { display: "grid", gap: 7, padding: 16, borderRadius: 14, border: "1px solid #5d512e", background: "#0d121a", color: "#d9e0ea" },
  pauseBanner: { display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 8, marginBottom: 14, padding: 13, borderRadius: 12, border: "1px solid #7f3342", background: "#251218", color: "#ff9baa" },
  error: { padding: 13, marginBottom: 14, borderRadius: 12, color: "#ff7b8d", border: "1px solid #6b2b38", background: "#211117" },
  positionGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(145px, 1fr))", gap: 9 },
  item: { padding: 13, borderRadius: 13, border: "1px solid #2f3b4e", background: "#09111c", display: "grid", gap: 6 },
  emptyState: { padding: 16, borderRadius: 14, border: "1px dashed #3a4658", background: "#0b121c", color: "#8997aa", lineHeight: 1.55 },
  emptyChart: { minHeight: 180, display: "grid", placeItems: "center", textAlign: "center", padding: 18, borderRadius: 14, background: "#09111c", color: "#8997aa" },
  chart: { width: "100%", height: 180, display: "block", borderRadius: 14, background: "linear-gradient(180deg, rgba(242,201,104,0.08), rgba(9,17,28,0.15))" },
  chartLegend: { display: "flex", justifyContent: "space-between", gap: 10, marginTop: 9, color: "#78869a", fontSize: 12 },
  tradeList: { display: "grid", gap: 9 },
  trade: { display: "grid", gridTemplateColumns: "65px minmax(120px, 1fr) minmax(135px, auto) 90px", alignItems: "center", gap: 10, padding: 13, borderRadius: 13, border: "1px solid #29364a", borderLeftWidth: 4, background: "#09111c" },
  tradePrice: { textAlign: "right" },
  small: { display: "block", color: "#78869a", marginTop: 4, fontSize: 12 },
  footerLine: { display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 8, color: "#718096", fontSize: 12, padding: "2px 4px 8px" },
};
