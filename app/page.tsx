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
  };
};

const money = (value: number) => `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(3)}`;
const pct = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
const time = (value?: string | null) => {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat("en-IL", {
    timeZone: "Asia/Jerusalem",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
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
    if (!response.ok) {
      setError("Wrong password");
      return;
    }
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
    return (
      <main style={styles.center}>
        {needsLogin ? (
          <form onSubmit={login} style={styles.loginCard}>
            <h1 style={{ margin: 0 }}>Solana Tracker</h1>
            <p style={styles.muted}>Private live trading dashboard</p>
            <input style={styles.input} type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Dashboard password" autoFocus />
            <button style={styles.primaryButton}>Open dashboard</button>
            {error && <strong style={styles.lossText}>{error}</strong>}
          </form>
        ) : (
          <div style={styles.loginCard}><h2>Loading live bot data…</h2>{error && <p style={styles.lossText}>{error}</p>}</div>
        )}
      </main>
    );
  }

  const open = data.openPosition;
  const live = Date.now() - Date.parse(data.generatedAt) < 15_000;
  const mode = String(data.state?.mode ?? "paper").toUpperCase();

  return (
    <main style={styles.page}>
      <header style={styles.header}>
        <div>
          <small style={styles.eyebrow}>SINGLE MARKET BOT</small>
          <h1 style={styles.title}>Live Trading Dashboard</h1>
          <p style={styles.muted}>Refreshes every 5 seconds · Israel time</p>
        </div>
        <div style={{ ...styles.status, ...(live ? styles.statusLive : styles.statusStale) }}>
          <span style={styles.dot} /> {live ? "LIVE" : "STALE"} · {mode}
        </div>
      </header>

      {error && <div style={styles.errorBox}>{error}</div>}

      <section style={styles.statsGrid}>
        <Stat label="Cash" value={`$${data.stats.cashUsdc.toFixed(3)}`} />
        <Stat label="Total PnL" value={money(data.stats.totalPnlUsdc)} tone={data.stats.totalPnlUsdc >= 0 ? "win" : "loss"} />
        <Stat label="Wins" value={String(data.stats.wins)} tone="win" />
        <Stat label="Losses" value={String(data.stats.losses)} tone="loss" />
        <Stat label="Win rate" value={`${(data.stats.winRate * 100).toFixed(1)}%`} />
        <Stat label="Completed" value={String(data.stats.completed)} />
      </section>

      <section style={{ ...styles.card, ...(open ? styles.openCard : styles.closedCard) }}>
        <div style={styles.cardHeader}>
          <div>
            <small style={styles.eyebrow}>{open ? "● OPEN POSITION" : "NO OPEN POSITION"}</small>
            <h2 style={{ margin: "6px 0 0", fontSize: 30 }}>{open ? String(open.symbol ?? open.token_symbol ?? "UNKNOWN") : "Waiting for next entry"}</h2>
          </div>
          <strong style={{ fontSize: 18 }}>{open ? "ACTIVE NOW" : "SCANNING"}</strong>
        </div>
        {open ? (
          <div style={styles.positionGrid}>
            <PositionItem label="Size" value={`$${Number(open.size_usdc ?? 0).toFixed(3)}`} />
            <PositionItem label="Entry price" value={`$${Number(open.entry_price_usd ?? 0).toFixed(8)}`} />
            <PositionItem label="Current / last price" value={`$${Number(open.current_price_usd ?? open.last_price_usd ?? open.entry_price_usd ?? 0).toFixed(8)}`} />
            <PositionItem label="High-water price" value={`$${Number(open.high_water_price_usd ?? open.entry_price_usd ?? 0).toFixed(8)}`} />
            <PositionItem label="Entry time" value={time(open.opened_at ?? open.entry_time ?? open.created_at)} />
            <PositionItem label="Score" value={String(open.score ?? "—")} />
          </div>
        ) : (
          <p style={{ ...styles.muted, marginTop: 18 }}>The scanner is active. A position will appear here immediately after entry.</p>
        )}
      </section>

      <section style={styles.card}>
        <div style={styles.cardHeader}>
          <div>
            <small style={styles.eyebrow}>TRADE HISTORY</small>
            <h2 style={{ margin: "6px 0 0" }}>Wins and losses</h2>
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
          {visibleTrades.map((trade) => {
            const pnl = Number(trade.pnl_usdc ?? 0);
            const isWin = pnl > 0;
            const isLoss = pnl < 0;
            const result = isWin ? "WIN" : isLoss ? "LOSS" : "FLAT";
            return (
              <article key={trade.id} style={{ ...styles.tradeRow, ...(isWin ? styles.winRow : isLoss ? styles.lossRow : {}) }}>
                <div style={styles.resultBlock}>
                  <strong style={{ fontSize: 20, color: isWin ? "#5df2a1" : isLoss ? "#ff7185" : "#d8deea" }}>{result}</strong>
                  <small style={styles.muted}>#{trade.id}</small>
                </div>
                <div style={styles.tradeMain}>
                  <strong style={{ fontSize: 18 }}>{trade.symbol ?? "UNKNOWN"}</strong>
                  <small style={styles.muted}>{String(trade.exit_reason ?? trade.status ?? "—").replaceAll("_", " ")} · {time(trade.updated_at ?? trade.created_at)}</small>
                </div>
                <div style={styles.tradeMeta}>
                  <small style={styles.muted}>Size</small>
                  <strong>${Number(trade.size_usdc ?? 0).toFixed(2)}</strong>
                </div>
                <div style={styles.tradeMeta}>
                  <small style={styles.muted}>Return</small>
                  <strong style={{ color: isWin ? "#5df2a1" : isLoss ? "#ff7185" : "#d8deea" }}>{pct(Number(trade.pnl_pct ?? 0))}</strong>
                </div>
                <div style={styles.pnlBlock}>
                  <strong style={{ fontSize: 21, color: isWin ? "#5df2a1" : isLoss ? "#ff7185" : "#d8deea" }}>{money(pnl)}</strong>
                </div>
              </article>
            );
          })}
          {visibleTrades.length === 0 && <p style={styles.muted}>No trades match this filter.</p>}
        </div>
      </section>

      <footer style={styles.footer}>Last dashboard update: {time(data.generatedAt)} · Last scanner activity: {time(data.state?.last_scan_at)}</footer>
    </main>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "win" | "loss" }) {
  return <div style={styles.stat}><small style={styles.muted}>{label}</small><strong style={{ fontSize: 27, color: tone === "win" ? "#5df2a1" : tone === "loss" ? "#ff7185" : "#f5f7fb" }}>{value}</strong></div>;
}

function PositionItem({ label, value }: { label: string; value: string }) {
  return <div style={styles.positionItem}><small style={styles.muted}>{label}</small><strong>{value}</strong></div>;
}

const styles: Record<string, any> = {
  page: { minHeight: "100vh", background: "#080b12", color: "#f5f7fb", padding: "28px", fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif" },
  center: { minHeight: "100vh", display: "grid", placeItems: "center", background: "#080b12", color: "#f5f7fb", padding: 24, fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" },
  loginCard: { width: "min(420px, 100%)", background: "#101521", border: "1px solid #20293a", borderRadius: 20, padding: 28, display: "grid", gap: 16 },
  input: { borderRadius: 12, border: "1px solid #313b50", background: "#0a0e17", color: "white", padding: "14px 16px", fontSize: 16 },
  primaryButton: { border: 0, borderRadius: 12, background: "#5df2a1", color: "#07100b", padding: "14px 16px", fontWeight: 800, cursor: "pointer" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 20, maxWidth: 1180, margin: "0 auto 24px" },
  title: { margin: "5px 0 4px", fontSize: "clamp(30px, 5vw, 48px)", letterSpacing: "-0.04em" },
  eyebrow: { color: "#8c98ad", fontWeight: 800, letterSpacing: "0.13em" },
  muted: { color: "#8c98ad" },
  status: { borderRadius: 999, padding: "10px 14px", fontWeight: 900, whiteSpace: "nowrap" },
  statusLive: { background: "rgba(93,242,161,.12)", color: "#5df2a1", border: "1px solid rgba(93,242,161,.35)" },
  statusStale: { background: "rgba(255,113,133,.12)", color: "#ff7185", border: "1px solid rgba(255,113,133,.35)" },
  dot: { display: "inline-block", width: 8, height: 8, borderRadius: 999, background: "currentColor", marginRight: 5 },
  errorBox: { maxWidth: 1180, margin: "0 auto 18px", padding: 14, background: "rgba(255,113,133,.12)", color: "#ff7185", borderRadius: 12 },
  statsGrid: { maxWidth: 1180, margin: "0 auto 20px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 },
  stat: { background: "#101521", border: "1px solid #20293a", borderRadius: 16, padding: 18, display: "grid", gap: 8 },
  card: { maxWidth: 1180, margin: "0 auto 20px", background: "#101521", border: "1px solid #20293a", borderRadius: 20, padding: 22 },
  openCard: { border: "1px solid rgba(93,242,161,.55)", boxShadow: "0 0 35px rgba(93,242,161,.08)" },
  closedCard: { border: "1px solid #20293a" },
  cardHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 18, flexWrap: "wrap" },
  positionGrid: { marginTop: 20, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 },
  positionItem: { background: "#0a0e17", border: "1px solid #20293a", borderRadius: 14, padding: 15, display: "grid", gap: 7 },
  filters: { display: "flex", gap: 8 },
  filterButton: { border: "1px solid #303a4d", background: "transparent", color: "#9aa6ba", borderRadius: 999, padding: "8px 12px", fontWeight: 800, cursor: "pointer" },
  filterActive: { background: "#edf2f7", color: "#080b12", borderColor: "#edf2f7" },
  tradeList: { marginTop: 18, display: "grid", gap: 10 },
  tradeRow: { display: "grid", gridTemplateColumns: "90px minmax(180px, 1fr) 90px 100px 110px", alignItems: "center", gap: 14, padding: 15, background: "#0b1019", border: "1px solid #20293a", borderRadius: 14 },
  winRow: { borderLeft: "5px solid #5df2a1" },
  lossRow: { borderLeft: "5px solid #ff7185" },
  resultBlock: { display: "grid", gap: 3 },
  tradeMain: { display: "grid", gap: 5 },
  tradeMeta: { display: "grid", gap: 5 },
  pnlBlock: { textAlign: "right" },
  lossText: { color: "#ff7185" },
  footer: { maxWidth: 1180, margin: "0 auto", color: "#6f7c91", fontSize: 13, paddingBottom: 30 },
};
