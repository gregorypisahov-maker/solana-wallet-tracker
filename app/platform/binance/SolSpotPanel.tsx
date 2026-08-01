"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "./sol-spot-panel.module.css";

type SolSpotData = {
  generatedAt: string;
  config: {
    symbol: string;
    mode: string;
    leverage: number;
    entryScoreThreshold: number;
    riskPctPerTrade: number;
    maxPositionPct: number;
    maxPositionUsdt: number;
    rewardRiskMultiple: number;
    maxDailyEntries: number;
    dailyLossLimitUsdt: number;
  };
  state: any;
  position: any | null;
  scans: any[];
  trades: any[];
  derived: {
    status: string;
    currentPrice: number;
    cashUsdt: number;
    openValueUsdt: number;
    equityUsdt: number;
    openPnlUsdt: number;
    openReturnPct: number;
    completedTrades: number;
    wins: number;
    losses: number;
    winRatePct: number;
    profitFactor: number | null;
    realizedPnlUsdt: number;
    dailyRealizedPnlUsdt: number;
    heartbeatAt: string | null;
    heartbeatAgeSeconds: number | null;
    feedHealthy: boolean;
    latestScanAt: string | null;
  };
};

const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const usdt = (value: unknown, digits = 2) => `${num(value).toFixed(digits)} USDT`;
const signed = (value: unknown, digits = 2) => `${num(value) >= 0 ? "+" : ""}${num(value).toFixed(digits)}`;
const israelTime = (value: string | null | undefined) => {
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
const readable = (value: unknown) => String(value ?? "—").replaceAll("_", " ");

function stateLabel(data: SolSpotData): { label: string; tone: string; detail: string } {
  const state = data.state;
  if (state?.enabled === false) return { label: "DISABLED", tone: styles.bad, detail: "Entries are disabled" };
  if (state?.halted) return { label: "RISK HALTED", tone: styles.bad, detail: readable(state.halt_reason) };
  if (state?.connection_status === "error") {
    return { label: "CONNECTION ERROR", tone: styles.bad, detail: String(state.last_error ?? "Market data unavailable") };
  }
  if (!data.derived.feedHealthy) {
    return {
      label: state?.connection_status === "starting" ? "STARTING" : "OFFLINE",
      tone: styles.warn,
      detail: state?.last_error ? String(state.last_error) : "No fresh worker heartbeat",
    };
  }
  if (data.position) return { label: "POSITION OPEN", tone: styles.good, detail: "Monitoring exit every five seconds" };
  return { label: "SCANNING", tone: styles.good, detail: "Waiting for a qualifying SOL trend entry" };
}

export default function SolSpotPanel() {
  const [data, setData] = useState<SolSpotData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/sol-spot-paper", { cache: "no-store" });
      if (response.status === 401) {
        setError("Unlock the Binance dashboard above to view SOL/USDT.");
        return;
      }
      if (!response.ok) throw new Error("Could not load SOL/USDT paper data");
      setData((await response.json()) as SolSpotData);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load SOL/USDT paper data");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const status = useMemo(() => (data ? stateLabel(data) : null), [data]);

  return (
    <section className={styles.section} id="sol-spot-paper">
      <div className={styles.shell}>
        <header className={styles.header}>
          <div>
            <span className={styles.eyebrow}>BINANCE SPOT · PAPER EXECUTION</span>
            <h2>SOL/USDT Spot Paper Trader</h2>
            <p>Long-only, no leverage, realistic fees and adverse slippage.</p>
          </div>
          {status && <span className={`${styles.status} ${status.tone}`}>{status.label}</span>}
        </header>

        {error && <div className={styles.notice}>{error}</div>}
        {!data ? (
          <div className={styles.loading}>Loading SOL/USDT state…</div>
        ) : (
          <>
            <div className={styles.hero}>
              <div>
                <span>Live SOL price</span>
                <strong>{data.derived.currentPrice > 0 ? usdt(data.derived.currentPrice, 4) : "No price yet"}</strong>
                <small>{status?.detail}</small>
              </div>
              <div>
                <span>Paper equity</span>
                <strong>{usdt(data.derived.equityUsdt)}</strong>
                <small>Cash {usdt(data.derived.cashUsdt)}</small>
              </div>
              <div>
                <span>Realized PnL</span>
                <strong className={data.derived.realizedPnlUsdt >= 0 ? styles.positive : styles.negative}>
                  {signed(data.derived.realizedPnlUsdt)} USDT
                </strong>
                <small>Today {signed(data.derived.dailyRealizedPnlUsdt)} USDT</small>
              </div>
              <div>
                <span>Performance</span>
                <strong>{data.derived.winRatePct.toFixed(1)}%</strong>
                <small>{data.derived.wins}W / {data.derived.losses}L · {data.derived.completedTrades} trades</small>
              </div>
            </div>

            <div className={styles.grid}>
              <article className={styles.card}>
                <div className={styles.cardHead}>
                  <div>
                    <span className={styles.eyebrow}>CURRENT POSITION</span>
                    <h3>{data.position ? "SOL position open" : "No position open"}</h3>
                  </div>
                  {data.position && (
                    <strong className={data.derived.openPnlUsdt >= 0 ? styles.positive : styles.negative}>
                      {signed(data.derived.openPnlUsdt)} USDT
                    </strong>
                  )}
                </div>
                {data.position ? (
                  <div className={styles.metrics}>
                    <div><span>Quantity</span><b>{num(data.position.quantity).toFixed(4)} SOL</b></div>
                    <div><span>Entry fill</span><b>{usdt(data.position.entry_fill_price, 4)}</b></div>
                    <div><span>Current mark</span><b>{usdt(data.derived.currentPrice, 4)}</b></div>
                    <div><span>Open return</span><b>{signed(data.derived.openReturnPct)}%</b></div>
                    <div><span>Stop</span><b>{usdt(data.position.stop_loss_price, 4)}</b></div>
                    <div><span>Target</span><b>{usdt(data.position.take_profit_price, 4)}</b></div>
                    <div><span>Highest seen</span><b>{usdt(data.position.highest_price_seen, 4)}</b></div>
                    <div><span>Opened</span><b>{israelTime(data.position.opened_at)}</b></div>
                  </div>
                ) : (
                  <p className={styles.empty}>The bot is waiting for a score of at least {data.config.entryScoreThreshold}. It can hold only one SOL spot position.</p>
                )}
              </article>

              <article className={styles.card}>
                <span className={styles.eyebrow}>RISK SETTINGS</span>
                <h3>Controlled spot execution</h3>
                <div className={styles.metrics}>
                  <div><span>Leverage</span><b>None · 1×</b></div>
                  <div><span>Risk per trade</span><b>{data.config.riskPctPerTrade}%</b></div>
                  <div><span>Position cap</span><b>{data.config.maxPositionPct}% / {usdt(data.config.maxPositionUsdt)}</b></div>
                  <div><span>Reward/risk</span><b>{data.config.rewardRiskMultiple.toFixed(1)}R</b></div>
                  <div><span>Daily entries</span><b>{data.state?.entries_today ?? 0}/{data.config.maxDailyEntries}</b></div>
                  <div><span>Daily loss stop</span><b>{usdt(data.config.dailyLossLimitUsdt)}</b></div>
                  <div><span>Heartbeat</span><b>{israelTime(data.derived.heartbeatAt)}</b></div>
                  <div><span>Latest scan</span><b>{israelTime(data.derived.latestScanAt)}</b></div>
                </div>
              </article>
            </div>

            <div className={styles.grid}>
              <article className={styles.card}>
                <span className={styles.eyebrow}>LATEST DECISIONS</span>
                <h3>Entry scan feed</h3>
                <div className={styles.rows}>
                  {data.scans.length === 0 ? (
                    <p className={styles.empty}>No scan has been recorded yet.</p>
                  ) : data.scans.slice(0, 8).map((scan) => (
                    <div className={styles.row} key={`${scan.symbol}-${scan.candle_close_time}`}>
                      <time>{israelTime(scan.candle_close_time)}</time>
                      <div><b>{readable(scan.action)}</b><small>{Array.isArray(scan.reasons) ? scan.reasons.map(readable).join(", ") : "—"}</small></div>
                      <strong>{scan.score ?? "—"}/{scan.threshold ?? data.config.entryScoreThreshold}</strong>
                    </div>
                  ))}
                </div>
              </article>

              <article className={styles.card}>
                <span className={styles.eyebrow}>RECENT RESULTS</span>
                <h3>Completed SOL/USDT trades</h3>
                <div className={styles.rows}>
                  {data.trades.length === 0 ? (
                    <p className={styles.empty}>No completed SOL/USDT paper trades yet.</p>
                  ) : data.trades.slice(0, 8).map((trade) => (
                    <div className={styles.row} key={trade.position_id}>
                      <time>{israelTime(trade.closed_at)}</time>
                      <div><b>{readable(trade.exit_reason)}</b><small>{num(trade.quantity).toFixed(4)} SOL · {signed(trade.net_return_pct)}%</small></div>
                      <strong className={num(trade.net_pnl_usdt) >= 0 ? styles.positive : styles.negative}>{signed(trade.net_pnl_usdt)} USDT</strong>
                    </div>
                  ))}
                </div>
              </article>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
