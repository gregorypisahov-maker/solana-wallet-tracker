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
    returnPct?: number;
    profitFactor?: number | null;
    averageWinUsdc?: number;
    averageLossUsdc?: number;
  };
};

const n = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const signed = (value: number) => `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(3)}`;
const percent = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
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
      setData(await response.json());
      setNeedsLogin(false);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load dashboard");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
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
      const pnl = n(trade.pnl_usdc);
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
            <h1 style={{ margin: 0 }}>Solana Market Bot</h1>
            <p style={styles.muted}>Private dashboard</p>
            <input style={styles.input} type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Dashboard password" autoFocus />
            <button style={styles.button}>Open dashboard</button>
            {error && <strong style={styles.loss}>{error}</strong>}
          </form>
        ) : (
          <div style={styles.loginCard}><h2>Loading…</h2>{error && <p style={styles.loss}>{error}</p>}</div>
        )}
      </main>
    );
  }

  const { stats, state } = data;
  const open = data.openPosition;
  const live = Date.now() - Date.parse(data.generatedAt) < 15000;
  const returnPct = stats.returnPct ?? (stats.startingCashUsdc ? (stats.totalPnlUsdc / stats.startingCashUsdc) * 100 : 0);

  return (
    <main style={styles.page}>
      <div style={styles.shell}>
        <header style={styles.header}>
          <div>
            <small style={styles.eyebrow}>SOLANA MARKET BOT</small>
            <h1 style={styles.title}>Trading Dashboard</h1>
            <p style={styles.muted}>Refreshes every 5 seconds · Israel time</p>
          </div>
          <div style={{ ...styles.badge, color: live ? "#61e6a7" : "#ff7b8d" }}>
            {live ? "● LIVE" : "● STALE"} · {String(state?.mode ?? "paper").toUpperCase()}
          </div>
        </header>

        {error && <div style={styles.error}>{error}</div>}

        <section style={styles.grid}>
          <Stat label="Cash" value={`$${stats.cashUsdc.toFixed(3)}`} />
          <Stat label="PnL" value={signed(stats.totalPnlUsdc)} tone={stats.totalPnlUsdc >= 0 ? "win" : "loss"} />
          <Stat label="Return" value={percent(returnPct)} tone={returnPct >= 0 ? "win" : "loss"} />
          <Stat label="Win rate" value={`${(stats.winRate * 100).toFixed(1)}%`} />
          <Stat label="Wins" value={String(stats.wins)} tone="win" />
          <Stat label="Losses" value={String(stats.losses)} tone="loss" />
          <Stat label="Completed" value={String(stats.completed)} />
          <Stat label="Profit factor" value={stats.profitFactor == null ? "—" : stats.profitFactor.toFixed(2)} />
        </section>

        <section style={styles.card}>
          <div style={styles.cardHeader}>
            <div>
              <small style={styles.eyebrow}>{open ? "OPEN POSITION" : "SCANNER"}</small>
              <h2 style={{ margin: "6px 0 0" }}>{open ? String(open.symbol ?? "UNKNOWN") : "Waiting for the next setup"}</h2>
            </div>
            <strong style={{ color: open ? "#61e6a7" : "#8997aa" }}>{open ? "ACTIVE" : "SCANNING"}</strong>
          </div>
          {open && (
            <div style={styles.positionGrid}>
              <Item label="Size" value={`$${n(open.sizeUsdc ?? open.size_usdc).toFixed(2)}`} />
              <Item label="Score" value={String(open.score ?? "—")} />
              <Item label="Entry" value={`$${n(open.entryPriceUsd ?? open.entry_price_usd).toPrecision(6)}`} />
              <Item label="High water" value={`$${n(open.highWaterPriceUsd ?? open.high_water_price_usd).toPrecision(6)}`} />
              <Item label="Opened" value={israelTime(open.openedAt ?? open.opened_at ?? open.created_at)} />
              <Item label="Trade ID" value={String(open.tradeId ?? open.trade_id ?? "—")} />
            </div>
          )}
        </section>

        <section style={styles.card}>
          <div style={styles.cardHeader}>
            <div><small style={styles.eyebrow}>RECENT TRADES</small><h2 style={{ margin: "6px 0 0" }}>History</h2></div>
            <div style={styles.filters}>
              {(["all", "wins", "losses"] as const).map((item) => (
                <button key={item} onClick={() => setFilter(item)} style={{ ...styles.filter, ...(filter === item ? styles.filterActive : {}) }}>{item.toUpperCase()}</button>
              ))}
            </div>
          </div>
          <div style={styles.list}>
            {visibleTrades.map((trade) => {
              const pnl = n(trade.pnl_usdc);
              const win = pnl > 0;
              const loss = pnl < 0;
              return (
                <article key={trade.id} style={{ ...styles.trade, borderLeftColor: win ? "#61e6a7" : loss ? "#ff7b8d" : "#344054" }}>
                  <div><strong style={{ color: win ? "#61e6a7" : loss ? "#ff7b8d" : "#f4f7fb" }}>{win ? "WIN" : loss ? "LOSS" : "FLAT"}</strong><small style={styles.small}>#{trade.id}</small></div>
                  <div><strong>{trade.symbol ?? "UNKNOWN"}</strong><small style={styles.small}>{String(trade.exit_reason ?? trade.status ?? "—").replaceAll("_", " ")} · {israelTime(trade.updated_at ?? trade.created_at)}</small></div>
                  <strong style={{ color: win ? "#61e6a7" : loss ? "#ff7b8d" : "#f4f7fb", textAlign: "right" }}>{signed(pnl)}</strong>
                </article>
              );
            })}
          </div>
        </section>
      </div>
    </main>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "win" | "loss" }) {
  return <div style={styles.stat}><small style={styles.muted}>{label}</small><strong style={{ fontSize: 26, color: tone === "win" ? "#61e6a7" : tone === "loss" ? "#ff7b8d" : "#f4f7fb" }}>{value}</strong></div>;
}

function Item({ label, value }: { label: string; value: string }) {
  return <div style={styles.item}><small style={styles.muted}>{label}</small><strong style={{ overflowWrap: "anywhere" }}>{value}</strong></div>;
}

const styles: Record<string, React.CSSProperties> = {
  page: { minHeight: "100vh", background: "#080d15", color: "#f4f7fb", padding: "24px 14px 60px", fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" },
  shell: { width: "100%", maxWidth: 1100, margin: "0 auto" },
  center: { minHeight: "100vh", display: "grid", placeItems: "center", background: "#080d15", color: "#f4f7fb", padding: 20, fontFamily: "Inter, sans-serif" },
  loginCard: { width: "100%", maxWidth: 420, background: "#111a27", border: "1px solid #263449", borderRadius: 20, padding: 24, display: "grid", gap: 14 },
  input: { padding: 14, borderRadius: 12, border: "1px solid #33445d", background: "#09111c", color: "white" },
  button: { padding: 14, border: 0, borderRadius: 12, background: "#61e6a7", color: "#06100b", fontWeight: 800 },
  header: { display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 20 },
  title: { margin: "5px 0", fontSize: "clamp(30px, 7vw, 46px)", letterSpacing: "-0.04em" },
  eyebrow: { color: "#8290a5", fontWeight: 800, letterSpacing: "0.12em" },
  muted: { color: "#8997aa" },
  loss: { color: "#ff7b8d" },
  badge: { border: "1px solid #2b3a4f", background: "#101925", borderRadius: 999, padding: "10px 14px", fontWeight: 800, whiteSpace: "nowrap" },
  error: { padding: 13, marginBottom: 14, borderRadius: 12, color: "#ff7b8d", border: "1px solid #6b2b38", background: "#211117" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(145px, 1fr))", gap: 10, marginBottom: 14 },
  stat: { minHeight: 105, padding: 17, borderRadius: 17, border: "1px solid #223149", background: "#111a27", display: "grid", gap: 8 },
  card: { marginBottom: 14, padding: 19, borderRadius: 20, border: "1px solid #223149", background: "#111a27" },
  cardHeader: { display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 16 },
  positionGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 9 },
  item: { padding: 13, borderRadius: 13, border: "1px solid #223149", background: "#09111c", display: "grid", gap: 6 },
  filters: { display: "flex", gap: 7 },
  filter: { padding: "8px 10px", borderRadius: 999, border: "1px solid #33445d", background: "transparent", color: "#8997aa", fontWeight: 800 },
  filterActive: { background: "#f4f7fb", color: "#080d15" },
  list: { display: "grid", gap: 9 },
  trade: { display: "grid", gridTemplateColumns: "65px minmax(120px, 1fr) 90px", alignItems: "center", gap: 10, padding: 13, borderRadius: 13, border: "1px solid #223149", borderLeftWidth: 4, background: "#09111c" },
  small: { display: "block", color: "#78869a", marginTop: 4, fontSize: 12 },
};
