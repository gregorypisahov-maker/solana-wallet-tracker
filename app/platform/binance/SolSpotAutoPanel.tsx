"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "./sol-spot-auto-panel.module.css";

type AutoData = {
  generatedAt: string;
  state: {
    enabled: boolean;
    armed: boolean;
    status: string;
    halt_reason: string | null;
    wallet_public_key: string | null;
    max_position_usdt: number | string;
    bootstrap_sol_amount: number | string;
    bootstrap_pending: boolean;
    slippage_bps: number;
    sol_balance: number | string | null;
    usdt_balance: number | string | null;
    realized_pnl_usdt: number | string;
    daily_realized_pnl_usdt: number | string;
    daily_entries: number;
    consecutive_losses: number;
    last_market_price: number | string | null;
    last_heartbeat_at: string | null;
    last_error: string | null;
  };
  position: any | null;
  paperPosition: any | null;
  trades: any[];
  orders: any[];
  derived: {
    runtimeOnline: boolean;
    heartbeatAgeSeconds: number | null;
    automatic: boolean;
    perTradeApprovalRequired: boolean;
    venue: string;
    settlementAsset: string;
    realizedPnlUsdt: number;
  };
};

const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const short = (value: string | null | undefined) =>
  value ? `${value.slice(0, 5)}…${value.slice(-5)}` : "Not available";
const signed = (value: unknown, digits = 2) => {
  const number = num(value);
  return `${number >= 0 ? "+" : ""}${number.toFixed(digits)}`;
};
const israelTime = (value: string | null | undefined) => {
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

export default function SolSpotAutoPanel() {
  const [data, setData] = useState<AutoData | null>(null);
  const [ownerPassword, setOwnerPassword] = useState("");
  const [size, setSize] = useState("25");
  const [startingSol, setStartingSol] = useState("0");
  const [slippage, setSlippage] = useState("50");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/sol-spot-auto", { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not load the automatic SOL bot");
      const next = body as AutoData;
      setData(next);
      setSize(String(num(next.state.max_position_usdt) || 25));
      setStartingSol(String(num(next.state.bootstrap_sol_amount)));
      setSlippage(String(num(next.state.slippage_bps) || 50));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load the automatic SOL bot");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const adminPost = async (action: string, extra: Record<string, unknown> = {}) => {
    const password = ownerPassword.trim();
    if (!password) throw new Error("Enter the dashboard owner password");
    const response = await fetch("/api/sol-spot-auto", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${btoa(`owner:${password}`)}`,
      },
      body: JSON.stringify({ action, ...extra }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? "Automatic bot action failed");
    return body;
  };

  const runAction = async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      await adminPost(action, extra);
      setNotice(
        action === "enable"
          ? "Automatic mode requested. The executor will verify the dedicated wallet and begin without per-trade approvals."
          : action === "configure"
            ? "Settings saved. Automatic trading remains disarmed until you start it."
            : "Automatic trading stopped."
      );
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Automatic bot action failed");
    } finally {
      setBusy(null);
    }
  };

  const statusText = useMemo(() => {
    if (!data) return "LOADING";
    if (!data.derived.runtimeOnline) return "EXECUTOR OFFLINE";
    return data.state.status.replaceAll("_", " ").toUpperCase();
  }, [data]);

  const state = data?.state;
  const position = data?.position;
  const pnlPositive = num(state?.realized_pnl_usdt) >= 0;

  return (
    <article className={styles.panel}>
      <div className={styles.head}>
        <div>
          <span className={styles.eyebrow}>AUTOMATIC REAL EXECUTION · SOLANA MAINNET</span>
          <h3>SOL market bot · automatic SOL ↔ USDT</h3>
          <p>
            The market model opens SOL positions and closes them back into USDT automatically. There are no BUY or SELL approval buttons, and realized funds remain in USDT.
          </p>
        </div>
        <span className={`${styles.status} ${state?.armed ? styles.active : ""}`}>{statusText}</span>
      </div>

      <div className={styles.safety}>
        <b>Dedicated server wallet only.</b> Do not use your main personal wallet. The executor keeps a SOL fee reserve, allows one position, and stops on its daily-loss or consecutive-loss limits. Profit is not guaranteed.
      </div>

      {error && <div className={styles.error}>{error}</div>}
      {notice && <div className={styles.notice}>{notice}</div>}
      {state?.last_error && <div className={styles.error}>Executor: {state.last_error}</div>}

      <div className={styles.grid}>
        <div className={styles.metric}><span>Runtime</span><strong>{data?.derived.runtimeOnline ? "Online" : "Offline"}</strong><small>{data?.derived.heartbeatAgeSeconds == null ? "No heartbeat" : `${data.derived.heartbeatAgeSeconds}s heartbeat age`}</small></div>
        <div className={styles.metric}><span>Trading wallet</span><strong>{short(state?.wallet_public_key)}</strong><small>Private key stays in the live-executor secret</small></div>
        <div className={styles.metric}><span>Wallet SOL</span><strong>{num(state?.sol_balance).toFixed(5)} SOL</strong><small>Includes the network-fee reserve</small></div>
        <div className={styles.metric}><span>Wallet USDT</span><strong>{num(state?.usdt_balance).toFixed(2)} USDT</strong><small>Entries are funded from this balance</small></div>
        <div className={styles.metric}><span>Paper signal</span><strong>{data?.paperPosition ? "LONG OPEN" : "WAITING"}</strong><small>{data?.paperPosition ? `Entry ${num(data.paperPosition.entry_fill_price).toFixed(4)}` : "No qualified entry now"}</small></div>
        <div className={styles.metric}><span>Real position</span><strong>{position ? `${num(position.quantity_sol).toFixed(6)} SOL` : "FLAT"}</strong><small>{position ? `Cost ${num(position.cost_basis_usdt).toFixed(2)} USDT` : "Capital remains in USDT"}</small></div>
        <div className={styles.metric}><span>All-time real P&amp;L</span><strong className={pnlPositive ? styles.positive : styles.negative}>{signed(state?.realized_pnl_usdt)} USDT</strong><small>Today {signed(state?.daily_realized_pnl_usdt)} USDT</small></div>
        <div className={styles.metric}><span>Risk state</span><strong>{state?.consecutive_losses ?? 0} losses</strong><small>{state?.daily_entries ?? 0} entries today</small></div>
      </div>

      <div className={styles.passwordRow}>
        <label htmlFor="sol-auto-owner-password">
          Dashboard owner password
          <input
            id="sol-auto-owner-password"
            type="password"
            value={ownerPassword}
            onChange={(event) => setOwnerPassword(event.target.value)}
            placeholder="Owner password"
            autoComplete="current-password"
          />
        </label>
        <small>This is the dashboard admin password, never a wallet seed phrase or private key.</small>
      </div>

      <div className={styles.config}>
        <label>
          Maximum trade
          <span><input type="number" min="10" max="200" step="5" value={size} onChange={(event) => setSize(event.target.value)} /> USDT</span>
        </label>
        <label>
          Starting SOL to hand the bot
          <span><input type="number" min="0" max="100" step="0.01" value={startingSol} onChange={(event) => setStartingSol(event.target.value)} /> SOL</span>
        </label>
        <label>
          Max slippage
          <span><input type="number" min="10" max="200" step="5" value={slippage} onChange={(event) => setSlippage(event.target.value)} /> bps</span>
        </label>
        <button
          onClick={() => void runAction("configure", {
            maxPositionUsdt: Number(size),
            bootstrapSolAmount: Number(startingSol),
            slippageBps: Number(slippage),
          })}
          disabled={Boolean(busy) || Boolean(position)}
        >
          {busy === "configure" ? "Saving…" : "Save automatic settings"}
        </button>
      </div>

      <div className={styles.bootstrapNote}>
        <b>Starting with SOL:</b> when a valid paper position is already open, the selected SOL is adopted without a buy swap. When the strategy is flat, that selected amount is sold to USDT once so the bot can wait for a properly timed entry. After that, the cycle is automatic: USDT → SOL → USDT.
      </div>

      <div className={styles.controls}>
        <button
          className={styles.start}
          onClick={() => void runAction("enable")}
          disabled={Boolean(busy) || Boolean(state?.armed)}
        >
          {busy === "enable" ? "Starting…" : "Start automatic trading"}
        </button>
        <button
          className={styles.stop}
          onClick={() => void runAction("emergency_stop")}
          disabled={Boolean(busy) || !state?.enabled}
        >
          Emergency stop
        </button>
      </div>

      {position && (
        <div className={styles.position}>
          <div><span>Actual entry</span><strong>{num(position.entry_price_usdt).toFixed(4)} USDT</strong></div>
          <div><span>Cost basis</span><strong>{num(position.cost_basis_usdt).toFixed(2)} USDT</strong></div>
          <div><span>Source</span><strong>{position.bootstrap ? "Existing SOL adopted" : "Automatic USDT buy"}</strong></div>
          <div><span>Opened</span><strong>{israelTime(position.opened_at)}</strong></div>
        </div>
      )}

      <div className={styles.history}>
        <div className={styles.historyHead}><h4>Automatic real trades</h4><span>{data?.trades.length ?? 0} shown</span></div>
        {(data?.trades.length ?? 0) === 0 ? (
          <p>No automatic real trade has completed yet.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table>
              <thead><tr><th>Closed</th><th>Size</th><th>USDT out</th><th>P&amp;L</th><th>Exit</th></tr></thead>
              <tbody>
                {data?.trades.map((trade) => (
                  <tr key={trade.trade_id}>
                    <td>{israelTime(trade.closed_at)}</td>
                    <td>{num(trade.quantity_sol).toFixed(5)} SOL</td>
                    <td>{num(trade.proceeds_usdt).toFixed(2)}</td>
                    <td className={num(trade.pnl_usdt) >= 0 ? styles.positive : styles.negative}>{signed(trade.pnl_usdt)} USDT</td>
                    <td>{String(trade.exit_reason).replaceAll("_", " ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </article>
  );
}
