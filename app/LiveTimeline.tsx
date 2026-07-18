"use client";

import { useEffect, useMemo, useState } from "react";
import { config } from "@/paper-trader/config";

type DashboardSnapshot = {
  positions?: any[];
  trades?: any[];
  tokens?: any[];
  transactions?: any[];
};

type TimelineEvent = {
  id: string;
  at: string;
  kind: "wallet" | "signal" | "entry" | "exit";
  title: string;
  detail: string;
  value?: string;
  positive?: boolean;
};

const short = (value: string) => value ? `${value.slice(0, 4)}…${value.slice(-4)}` : "—";
const formatSol = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(3)} SOL`;

function signalDecision(token: any): { pass: boolean; reason: string } {
  const score = Number(token.score ?? 0);
  const wallets = Number(token.wallets_count ?? 0);
  const totalBuy = Number(token.total_sol_bought ?? 0);
  const liquidity = Number(token.liquidity_usd ?? 0);
  const marketCap = Number(token.market_cap ?? 0);
  const avgBuy = wallets > 0 ? totalBuy / wallets : 0;
  const ratio = marketCap > 0 ? liquidity / marketCap : 0;
  const lane =
    wallets >= config.entry.minWalletCount
      ? "consensus evidence"
      : wallets === 2
        ? "two-wallet trust check required"
        : wallets === 1
          ? "verified-trader check required"
          : "wallet evidence pending";

  if (token.dump_flag) return { pass: false, reason: "dump flag detected" };
  if (score < config.entry.minScore) return { pass: false, reason: `score ${score} below ${config.entry.minScore}` };
  if (score > config.entry.maxScore) return { pass: false, reason: `late entry: score ${score} above ${config.entry.maxScore}` };
  if (avgBuy < config.entry.minAvgBuyPerWallet) return { pass: false, reason: `average buy ${avgBuy.toFixed(2)} SOL below ${config.entry.minAvgBuyPerWallet}` };
  if (liquidity < config.entry.minLiquidityUsd) return { pass: false, reason: `liquidity below $${Math.round(config.entry.minLiquidityUsd / 1_000)}k` };
  if (ratio < config.entry.minLiquidityToMcapRatio) return { pass: false, reason: `liquidity ratio ${(ratio * 100).toFixed(0)}% below ${config.entry.minLiquidityToMcapRatio * 100}%` };
  if (marketCap < config.entry.minMarketCapUsd || marketCap > config.entry.maxMarketCapUsd) return { pass: false, reason: `market cap outside $${Math.round(config.entry.minMarketCapUsd / 1_000)}k–$${Math.round(config.entry.maxMarketCapUsd / 1_000)}k range` };
  return { pass: true, reason: `market pre-check passed; ${lane}` };
}

export default function LiveTimeline() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch("/api/dashboard", { cache: "no-store" });
        if (!response.ok) throw new Error("timeline unavailable");
        const body = await response.json();
        if (active) {
          setSnapshot(body);
          setError(null);
        }
      } catch (requestError) {
        if (active) setError(requestError instanceof Error ? requestError.message : "timeline unavailable");
      }
    };
    void load();
    const timer = window.setInterval(load, 10_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const events = useMemo<TimelineEvent[]>(() => {
    if (!snapshot) return [];
    const rows: TimelineEvent[] = [];

    for (const transaction of snapshot.transactions ?? []) {
      rows.push({
        id: `wallet:${transaction.wallet_address}:${transaction.token_mint}:${transaction.tx_time}`,
        at: transaction.tx_time,
        kind: "wallet",
        title: `${transaction.wallet_address} ${String(transaction.side).toUpperCase()} ${short(transaction.token_mint)}`,
        detail: `${Number(transaction.sol_amount ?? 0).toFixed(3)} SOL smart-wallet activity`,
        positive: transaction.side === "buy",
      });
    }

    for (const token of snapshot.tokens ?? []) {
      const decision = signalDecision(token);
      rows.push({
        id: `signal:${token.token_mint}:${token.updated_at ?? token.last_buy_time}`,
        at: token.updated_at ?? token.last_buy_time,
        kind: "signal",
        title: `${token.token_symbol ?? "UNKNOWN"} market pre-check ${decision.pass ? "PASSED" : "REJECTED"}`,
        detail: `${Number(token.wallets_count ?? 0)} wallets • score ${Number(token.score ?? 0)} • ${decision.reason}`,
        value: decision.pass ? "PRE-CHECK" : "FILTERED",
        positive: decision.pass,
      });
    }

    for (const position of snapshot.positions ?? []) {
      const alert = position.entry_alert ?? {};
      const source =
        alert.signalSource === "proven_trader_copy"
          ? `verified trader ${alert.leaderWallet ?? "copy"}`
          : "wallet consensus";
      rows.push({
        id: `entry:${position.position_id ?? position.mint}:${position.entry_time}`,
        at: position.entry_time,
        kind: "entry",
        title: `Paper BUY ${position.token_symbol ?? short(position.mint)}`,
        detail: `${Number(position.size_sol ?? 0).toFixed(3)} SOL position opened • ${source}`,
        value: position.current_multiple == null ? "OPEN" : `${Number(position.current_multiple).toFixed(2)}x now`,
        positive: Number(position.current_multiple ?? 1) >= 1,
      });
    }

    for (const trade of snapshot.trades ?? []) {
      const pnl = Number(trade.pnl_sol ?? 0);
      const source =
        trade.entry_alert?.signalSource === "proven_trader_copy"
          ? "verified-trader copy"
          : "wallet consensus";
      rows.push({
        id: `exit:${trade.position_id ?? trade.mint}:${trade.happened_at}:${trade.reason}`,
        at: trade.happened_at,
        kind: "exit",
        title: `Paper SELL ${trade.token_symbol ?? short(trade.mint)}`,
        detail: `${String(trade.reason ?? "exit").replaceAll("_", " ")} • ${source}`,
        value: formatSol(pnl),
        positive: pnl >= 0,
      });
    }

    return rows
      .filter((row) => row.at && Number.isFinite(Date.parse(row.at)))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, 30);
  }, [snapshot]);

  const icon = (kind: TimelineEvent["kind"]) => {
    if (kind === "wallet") return "👛";
    if (kind === "signal") return "🧠";
    if (kind === "entry") return "🟦";
    return "🏁";
  };

  return (
    <section className="panel" style={{ marginBottom: 22 }}>
      <div className="panelHead">
        <div>
          <h2>Live bot timeline</h2>
          <small style={{ opacity: .65 }}>Wallet activity → market pre-check → verified entry → exit</small>
        </div>
        <span>WATCH IT THINK</span>
      </div>
      {error && !snapshot ? <div className="empty">{error}</div> : events.length === 0 ? <div className="empty">Waiting for live wallet, signal, entry and exit events.</div> : (
        <div className="feed">
          {events.map((event) => (
            <div className="feedRow" key={event.id}>
              <i className={event.positive ? "up" : "down"}>{icon(event.kind)}</i>
              <div>
                <strong>{event.title}</strong>
                <small>{event.detail}</small>
              </div>
              <div className="feedValue">
                {event.value && <b className={event.positive ? "green" : "red"}>{event.value}</b>}
                <small>{new Date(event.at).toLocaleString()}</small>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
