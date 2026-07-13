"use client";

import { useCallback, useEffect, useState } from "react";
import WalletManager from "./WalletManager";

type DashboardData = {
  generatedAt: string;
  state: any;
  summary: {
    completedPositions: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnlSol: number;
    profitFactor: number | null;
    liveEquitySol: number;
    cashSol: number;
    openPositionValueSol: number;
    unrealizedPnlSol: number;
    livePricesUnavailable: number;
    openPositions: number;
    activeWallets: number;
    configuredWallets: number;
  };
  positions: any[];
  trades: any[];
  tokens: any[];
  performance: any[];
  transactions: any[];
};

const short = (value: string) => `${value.slice(0, 4)}…${value.slice(-4)}`;
const sol = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(3)} SOL`;
const usd = (value: number | null) => {
  if (value == null) return "—";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
};
const time = (value: string | null) => value ? new Date(value).toLocaleString() : "—";

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch("/api/dashboard", { cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 401 ? "Share link expired" : "Could not load live data");
      setData(await response.json());
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not load live data");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  if (!data) {
    return <main className="shell"><div className="loading">{error ?? "Connecting to live bot data…"}</div></main>;
  }

  const state = data.state;
  const halted = Boolean(state?.halted);

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">PAPER TRADING • VIEW ONLY</div>
          <h1>Smart Wallet Command Center</h1>
          <p>Live Solana wallet consensus, simulated positions and performance.</p>
        </div>
        <div className="liveBlock">
          <span className={`status ${halted ? "halted" : "live"}`}><i />{halted ? "TRADING HALTED" : "MONITORING LIVE"}</span>
          <span className="updated">Updated {new Date(data.generatedAt).toLocaleTimeString()} {refreshing ? "• syncing" : ""}</span>
        </div>
      </header>

      {error && <div className="errorBanner">{error}. Showing the last successful snapshot.</div>}
      {halted && <div className="haltBanner">Paper entries are paused: {state.halt_reason ?? "risk limit reached"}. Use <code>/resume</code> in the authorized Telegram chat.</div>}

      <section className="metrics">
        <Metric
          label="Cash balance"
          value={`${data.summary.cashSol.toFixed(3)} SOL`}
          sub="Available simulated cash"
        />
        <Metric
          label="Open position value"
          value={`${data.summary.openPositionValueSol.toFixed(3)} SOL`}
          sub={
            data.summary.livePricesUnavailable > 0
              ? `${data.summary.livePricesUnavailable} live price${data.summary.livePricesUnavailable === 1 ? "" : "s"} unavailable • estimated`
              : `Unrealized ${sol(data.summary.unrealizedPnlSol)}`
          }
        />
        <Metric
          label="Live equity"
          value={`${data.summary.liveEquitySol.toFixed(3)} SOL`}
          sub="Cash + open position value"
          tone="cyan"
        />
        <Metric label="Realized PnL" value={sol(data.summary.totalPnlSol)} tone={data.summary.totalPnlSol >= 0 ? "green" : "red"} />
        <Metric label="Win rate" value={`${(data.summary.winRate * 100).toFixed(1)}%`} sub={`${data.summary.wins}W / ${data.summary.losses}L`} />
        <Metric label="Profit factor" value={data.summary.profitFactor == null ? "—" : data.summary.profitFactor.toFixed(2)} />
        <Metric label="Positions" value={`${data.summary.openPositions} open`} sub={`${data.summary.completedPositions} completed`} />
        <Metric label="Wallets online" value={`${data.summary.activeWallets}`} sub={`${data.summary.configuredWallets} configured`} />
      </section>

      <WalletManager onChanged={refresh} />

      <section className="grid two">
        <Panel title="Open paper positions" badge={`${data.positions.length} LIVE`}>
          {data.positions.length === 0 ? <Empty text="Waiting for the next qualified consensus alert." /> : (
            <div className="stack">{data.positions.map((position) => (
              <div className="position" key={position.mint}>
                <div><strong>{position.token_symbol}</strong><a href={`https://dexscreener.com/solana/${position.mint}`} target="_blank" rel="noreferrer">{short(position.mint)}</a></div>
                <div><span>Size</span><b>{Number(position.size_sol).toFixed(3)} SOL</b></div>
                <div><span>Remaining</span><b>{(Number(position.remaining_pct) * 100).toFixed(0)}%</b></div>
                <div><span>Peak</span><b>{Number(position.peak_multiple).toFixed(2)}x</b></div>
                <div><span>Opened</span><b>{time(position.entry_time)}</b></div>
              </div>
            ))}</div>
          )}
        </Panel>

        <Panel title="Wallet leaderboard" badge="TRUST SCORE">
          {data.performance.length === 0 ? <Empty text="Wallet scores appear after matched paper positions close." /> : (
            <div className="leaderboard">{data.performance.slice(0, 8).map((wallet, index) => (
              <div className="leader" key={wallet.wallet_address}>
                <span className="rank">{index + 1}</span>
                <code>{wallet.wallet_address}</code>
                <div className="bar"><i style={{ width: `${Math.max(2, Number(wallet.trust_score))}%` }} /></div>
                <strong>{Number(wallet.trust_score).toFixed(0)}</strong>
                <small>{(Number(wallet.win_rate) * 100).toFixed(0)}% win</small>
              </div>
            ))}</div>
          )}
        </Panel>
      </section>

      <Panel title="Consensus radar" badge="LATEST TOKENS">
        <div className="tableWrap"><table>
          <thead><tr><th>Token</th><th>Wallets</th><th>Total buy</th><th>Score</th><th>Market cap</th><th>Liquidity</th><th>Last signal</th><th>Flags</th></tr></thead>
          <tbody>{data.tokens.slice(0, 15).map((token) => (
            <tr key={token.token_mint}>
              <td><a href={`https://dexscreener.com/solana/${token.token_mint}`} target="_blank" rel="noreferrer"><strong>{token.token_symbol ?? "UNKNOWN"}</strong><small>{short(token.token_mint)}</small></a></td>
              <td>{token.wallets_count}</td><td>{Number(token.total_sol_bought).toFixed(2)} SOL</td>
              <td><span className={`score score${Math.floor(Number(token.score) / 20)}`}>{token.score}</span></td>
              <td>{usd(token.market_cap == null ? null : Number(token.market_cap))}</td><td>{usd(token.liquidity_usd == null ? null : Number(token.liquidity_usd))}</td>
              <td>{time(token.last_buy_time)}</td>
              <td>{token.dump_flag ? <em className="flag red">DUMP</em> : null}{token.scalp_flag ? <em className="flag amber">SCALP</em> : null}{!token.dump_flag && !token.scalp_flag ? "—" : null}</td>
            </tr>
          ))}</tbody>
        </table>{data.tokens.length === 0 && <Empty text="No token consensus has been recorded yet." />}</div>
      </Panel>

      <section className="grid two">
        <Panel title="Recent paper exits" badge="REALIZED">
          <Feed rows={data.trades.slice(0, 10)} type="trade" />
        </Panel>
        <Panel title="Smart-wallet activity" badge="ON CHAIN">
          <Feed rows={data.transactions.slice(0, 10)} type="transaction" />
        </Panel>
      </section>

      <footer>This dashboard can observe and simulate trades only. It cannot access a wallet or execute real transactions.</footer>
    </main>
  );
}

function Metric({ label, value, sub, tone = "" }: { label: string; value: string; sub?: string; tone?: string }) {
  return <div className="metric"><span>{label}</span><strong className={tone}>{value}</strong>{sub && <small>{sub}</small>}</div>;
}
function Panel({ title, badge, children }: { title: string; badge: string; children: React.ReactNode }) {
  return <section className="panel"><div className="panelHead"><h2>{title}</h2><span>{badge}</span></div>{children}</section>;
}
function Empty({ text }: { text: string }) { return <div className="empty">{text}</div>; }
function Feed({ rows, type }: { rows: any[]; type: "trade" | "transaction" }) {
  if (!rows.length) return <Empty text="No activity recorded yet." />;
  return <div className="feed">{rows.map((row, index) => {
    const positive = type === "trade" ? Number(row.pnl_sol) >= 0 : row.side === "buy";
    return <div className="feedRow" key={`${row.id ?? row.token_mint}:${index}`}>
      <i className={positive ? "up" : "down"}>{positive ? "↗" : "↘"}</i>
      <div><strong>{type === "trade" ? row.token_symbol : short(row.token_mint)}</strong><small>{type === "trade" ? row.reason.replaceAll("_", " ") : `${row.wallet_address} • ${row.side}`}</small></div>
      <div className="feedValue"><b className={positive ? "green" : "red"}>{type === "trade" ? sol(Number(row.pnl_sol)) : `${Number(row.sol_amount).toFixed(3)} SOL`}</b><small>{time(type === "trade" ? row.happened_at : row.tx_time)}</small></div>
    </div>;
  })}</div>;
}
