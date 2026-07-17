"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
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
  scalper: {
    state: any;
    positions: any[];
    trades: any[];
    lastScan: any;
    summary: {
      cashSol: number;
      openPositionValueSol: number;
      equitySol: number;
      totalPnlSol: number;
      completedTrades: number;
      wins: number;
      losses: number;
      winRate: number;
      profitFactor: number | null;
    };
  };
};

const short = (value: string) => `${value.slice(0, 4)}…${value.slice(-4)}`;
const sol = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(3)} SOL`;
const usd = (value: number | null) => {
  if (value == null) return "—";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
};
const price = (value: number | null) => value == null || !Number.isFinite(value) ? "—" : `$${value.toPrecision(7)}`;
const time = (value: string | null) => value ? new Date(value).toLocaleString() : "—";

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [password, setPassword] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [selectedMint, setSelectedMint] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch("/api/dashboard", { cache: "no-store" });
      if (response.status === 401) {
        setNeedsLogin(true);
        setData(null);
        setError(null);
        return;
      }
      if (!response.ok) throw new Error("Could not load live data");
      setData(await response.json());
      setNeedsLogin(false);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not load live data");
    } finally {
      setRefreshing(false);
    }
  }, []);

  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoggingIn(true);
    setLoginError(null);
    try {
      const response = await fetch("/api/viewer-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? "Could not sign in");
      setPassword("");
      await refresh();
    } catch (requestError) {
      setLoginError(requestError instanceof Error ? requestError.message : "Could not sign in");
    } finally {
      setLoggingIn(false);
    }
  };

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  if (!data) {
    if (needsLogin) {
      return <main className="shell"><div className="loading" style={{ maxWidth: 460, margin: "12vh auto", textAlign: "left" }}><div className="eyebrow">PRIVATE • VIEW ONLY</div><h1 style={{ marginBottom: 8 }}>Smart Wallet Command Center</h1><p style={{ marginBottom: 24 }}>Enter your dashboard key to view the live paper-trading dashboard.</p><form onSubmit={login} style={{ display: "grid", gap: 12 }}><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Dashboard key" autoComplete="current-password" autoFocus required style={{ width: "100%", padding: "14px 16px", borderRadius: 10, border: "1px solid rgba(255,255,255,.18)", background: "rgba(0,0,0,.25)", color: "inherit", fontSize: 16 }} /><button type="submit" disabled={loggingIn} style={{ padding: "14px 16px", borderRadius: 10, border: 0, fontWeight: 800, cursor: "pointer" }}>{loggingIn ? "Unlocking…" : "Open view-only dashboard"}</button>{loginError && <div className="errorBanner">{loginError}</div>}</form></div></main>;
    }
    return <main className="shell"><div className="loading">{error ?? "Connecting to live bot data…"}</div></main>;
  }

  const state = data.state;
  const halted = Boolean(state?.halted);
  const selectedPosition = selectedMint ? data.positions.find((position) => position.mint === selectedMint) : null;

  if (selectedPosition) {
    return <TradeDetail position={selectedPosition} generatedAt={data.generatedAt} refreshing={refreshing} onBack={() => setSelectedMint(null)} />;
  }

  return (
    <main className="shell">
      <header className="topbar"><div><div className="eyebrow">PAPER TRADING • VIEW ONLY</div><h1>Smart Wallet Command Center</h1><p>Live Solana wallet consensus, simulated positions and performance.</p></div><div className="liveBlock"><span className={`status ${halted ? "halted" : "live"}`}><i />{halted ? "TRADING HALTED" : "MONITORING LIVE"}</span><span className="updated">Updated {new Date(data.generatedAt).toLocaleTimeString()} {refreshing ? "• syncing" : ""}</span></div></header>
      {error && <div className="errorBanner">{error}. Showing the last successful snapshot.</div>}
      {halted && <div className="haltBanner">Paper entries are paused: {state?.halt_reason ?? "risk limit reached"}. Use <code>/resume</code> in the authorized Telegram chat.</div>}
      <section className="metrics"><Metric label="Cash balance" value={`${data.summary.cashSol.toFixed(3)} SOL`} sub="Available simulated cash" /><Metric label="Open position value" value={`${data.summary.openPositionValueSol.toFixed(3)} SOL`} sub={data.summary.livePricesUnavailable > 0 ? `${data.summary.livePricesUnavailable} live price${data.summary.livePricesUnavailable === 1 ? "" : "s"} unavailable • estimated` : `Unrealized ${sol(data.summary.unrealizedPnlSol)}`} /><Metric label="Live equity" value={`${data.summary.liveEquitySol.toFixed(3)} SOL`} sub="Cash + open position value" tone="cyan" /><Metric label="Realized PnL" value={sol(data.summary.totalPnlSol)} tone={data.summary.totalPnlSol >= 0 ? "green" : "red"} /><Metric label="Win rate" value={`${(data.summary.winRate * 100).toFixed(1)}%`} sub={`${data.summary.wins}W / ${data.summary.losses}L`} /><Metric label="Profit factor" value={data.summary.profitFactor == null ? "—" : data.summary.profitFactor.toFixed(2)} /><Metric label="Positions" value={`${data.summary.openPositions} open`} sub={`${data.summary.completedPositions} completed`} /><Metric label="Wallets online" value={`${data.summary.activeWallets}`} sub={`${data.summary.configuredWallets} configured`} /></section>
      <ScalperPanel scalper={data.scalper} />
      <WalletManager onChanged={refresh} />
      <section className="grid two"><Panel title="Open paper positions" badge={`${data.positions.length} LIVE`}>{data.positions.length === 0 ? <Empty text="Waiting for the next qualified consensus alert." /> : <div className="stack">{data.positions.map((position) => <button type="button" className="position" key={position.mint} onClick={() => setSelectedMint(position.mint)} style={{ width: "100%", color: "inherit", textAlign: "left", cursor: "pointer", font: "inherit" }}><div><strong>{position.token_symbol}</strong><span>{short(position.mint)}</span></div><div><span>Size</span><b>{Number(position.size_sol).toFixed(3)} SOL</b></div><div><span>Current</span><b>{position.current_multiple == null ? "—" : `${Number(position.current_multiple).toFixed(2)}x`}</b></div><div><span>PnL</span><b className={Number(position.unrealized_pnl_sol ?? 0) >= 0 ? "green" : "red"}>{position.unrealized_pnl_sol == null ? "—" : sol(Number(position.unrealized_pnl_sol))}</b></div><div><span>Open details</span><b>View →</b></div></button>)}</div>}</Panel><Panel title="Wallet leaderboard" badge="TRUST SCORE">{data.performance.length === 0 ? <Empty text="Wallet scores appear after matched paper positions close." /> : <div className="leaderboard">{data.performance.slice(0, 8).map((wallet, index) => <div className="leader" key={wallet.wallet_address}><span className="rank">{index + 1}</span><code>{wallet.wallet_address}</code><div className="bar"><i style={{ width: `${Math.max(2, Number(wallet.trust_score))}%` }} /></div><strong>{Number(wallet.trust_score).toFixed(0)}</strong><small>{(Number(wallet.win_rate) * 100).toFixed(0)}% win</small></div>)}</div>}</Panel></section>
      <Panel title="Consensus radar" badge="LATEST TOKENS"><div className="tableWrap"><table><thead><tr><th>Token</th><th>Wallets</th><th>Total buy</th><th>Score</th><th>Market cap</th><th>Liquidity</th><th>Last signal</th><th>Flags</th></tr></thead><tbody>{data.tokens.slice(0, 15).map((token) => <tr key={token.token_mint}><td><a href={`https://dexscreener.com/solana/${token.token_mint}`} target="_blank" rel="noreferrer"><strong>{token.token_symbol ?? "UNKNOWN"}</strong><small>{short(token.token_mint)}</small></a></td><td>{token.wallets_count}</td><td>{Number(token.total_sol_bought).toFixed(2)} SOL</td><td><span className={`score score${Math.floor(Number(token.score) / 20)}`}>{token.score}</span></td><td>{usd(token.market_cap == null ? null : Number(token.market_cap))}</td><td>{usd(token.liquidity_usd == null ? null : Number(token.liquidity_usd))}</td><td>{time(token.last_buy_time)}</td><td>{token.dump_flag ? <em className="flag red">DUMP</em> : null}{token.scalp_flag ? <em className="flag amber">SCALP</em> : null}{!token.dump_flag && !token.scalp_flag ? "—" : null}</td></tr>)}</tbody></table>{data.tokens.length === 0 && <Empty text="No token consensus has been recorded yet." />}</div></Panel>
      <section className="grid two"><Panel title="Recent paper exits" badge="REALIZED"><Feed rows={data.trades.slice(0, 10)} type="trade" /></Panel><Panel title="Smart-wallet activity" badge="ON CHAIN"><Feed rows={data.transactions.slice(0, 10)} type="transaction" /></Panel></section>
      <footer>This dashboard can observe and simulate trades only. It cannot access a wallet or execute real transactions.</footer>
    </main>
  );
}


function ScalperPanel({ scalper }: { scalper: DashboardData["scalper"] }) {
  const state = scalper.state;
  const summary = scalper.summary;
  const position = scalper.positions[0];
  const scan = scalper.lastScan;
  const active = Boolean(state?.enabled) && !state?.halted;
  const latestTrades = scalper.trades.slice(0, 5);

  return <Panel title="Parallel momentum scalper" badge="PAPER • WALLET-FREE">
    <div className="scalpIntro">
      <div><span className={`scalpDot ${active ? "active" : "paused"}`} /> <strong>{active ? "Scanning every minute" : `Paused: ${state?.halt_reason ?? "disabled"}`}</strong><small>GeckoTerminal discovery + DexScreener prices • zero Helius credits</small></div>
      <code>/scalpstats</code>
    </div>
    <div className="scalpMetrics">
      <div><span>Equity</span><b>{summary.equitySol.toFixed(4)} SOL</b><small>Started with 1.0000</small></div>
      <div><span>Net PnL</span><b className={summary.totalPnlSol >= 0 ? "green" : "red"}>{sol(summary.totalPnlSol)}</b><small>After simulated costs</small></div>
      <div><span>Win rate</span><b>{(summary.winRate * 100).toFixed(1)}%</b><small>{summary.wins}W / {summary.losses}L</small></div>
      <div><span>Scalps</span><b>{summary.completedTrades}</b><small>{state?.entries_today ?? 0}/12 today</small></div>
      <div><span>Profit factor</span><b>{summary.profitFactor == null ? "—" : summary.profitFactor.toFixed(2)}</b><small>Closed paper trades</small></div>
    </div>
    <div className="scalpBody">
      <div>
        <h3>Open scalp</h3>
        {position ? <a className="scalpPosition" href={`https://dexscreener.com/solana/${position.mint}`} target="_blank" rel="noreferrer">
          <div><strong>{position.token_symbol}</strong><small>{short(position.mint)}</small></div>
          <div><span>Size</span><b>{Number(position.size_sol).toFixed(3)} SOL</b></div>
          <div><span>Net now</span><b className={Number(position.current_net_return_pct) >= 0 ? "green" : "red"}>{signedPct(Number(position.current_net_return_pct))}</b></div>
          <div><span>Age</span><b>{Math.max(0, (Date.now() - Date.parse(position.entry_time)) / 60_000).toFixed(1)} min</b></div>
        </a> : <Empty text="Waiting for liquid, confirmed momentum. No forced trade." />}
        <div className="scanLine"><span>Last market scan</span><b>{scan ? time(scan.finished_at) : "Starting…"}</b><small>{scan?.message?.replaceAll("_", " ") ?? "waiting for first run"}{scan ? ` • ${scan.scanned_count} checked • ${scan.qualified_count} qualified` : ""}</small></div>
      </div>
      <div>
        <h3>Recent scalp exits</h3>
        {latestTrades.length ? <div className="miniTrades">{latestTrades.map((trade) => <div key={trade.id}><span><strong>{trade.token_symbol}</strong><small>{String(trade.exit_reason).replaceAll("_", " ")}</small></span><b className={Number(trade.pnl_sol) >= 0 ? "green" : "red"}>{sol(Number(trade.pnl_sol))}</b><time>{time(trade.closed_at)}</time></div>)}</div> : <Empty text="No completed scalps yet." />}
      </div>
    </div>
    <div className="scalpRules">0.05 SOL size • one open position • +2.5% net target • −3.0% net stop • 7-minute maximum • 1.2% simulated round-trip friction</div>
  </Panel>;
}

const signedPct = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;

function TradeDetail({ position, generatedAt, refreshing, onBack }: { position: any; generatedAt: string; refreshing: boolean; onBack: () => void }) {
  const entryPrice = Number(position.entry_price);
  const currentPrice = position.current_price_usd == null ? null : Number(position.current_price_usd);
  const currentMultiple = position.current_multiple == null ? null : Number(position.current_multiple);
  const peakMultiple = Number(position.peak_multiple ?? 1);
  const remainingPct = Number(position.remaining_pct ?? 1);
  const sizeSol = Number(position.size_sol);
  const hardStopPrice = entryPrice * 0.85;
  const tp1Price = entryPrice * 1.3;
  const tp2Price = entryPrice * 1.6;
  const trailingFloorMultiple = peakMultiple > 1 ? peakMultiple * 0.85 : null;
  const trailingFloorPrice = trailingFloorMultiple == null ? null : entryPrice * trailingFloorMultiple;
  const openedAt = new Date(position.entry_time);
  const maxExitAt = new Date(openedAt.getTime() + 45 * 60_000);
  const alert = position.entry_alert ?? {};
  const nextTarget = remainingPct > 0.5 ? "1.30x — sell 50%" : "1.60x — sell 50% of what remains";

  return <main className="shell"><header className="topbar"><div><button type="button" onClick={onBack} style={{ marginBottom: 18, padding: "10px 14px", borderRadius: 9, cursor: "pointer", fontWeight: 800 }}>← Back to dashboard</button><div className="eyebrow">OPEN PAPER POSITION • LIVE DETAIL</div><h1>{position.token_symbol}</h1><p>{position.mint}</p></div><div className="liveBlock"><span className="status live"><i />POSITION OPEN</span><span className="updated">Updated {new Date(generatedAt).toLocaleTimeString()} {refreshing ? "• syncing" : ""}</span></div></header><section className="metrics"><Metric label="Entry price" value={price(entryPrice)} sub={time(position.entry_time)} /><Metric label="Current price" value={price(currentPrice)} sub={position.price_status === "live" ? "Live DexScreener price" : "Live price unavailable"} tone={currentMultiple != null && currentMultiple >= 1 ? "green" : "red"} /><Metric label="Current multiple" value={currentMultiple == null ? "—" : `${currentMultiple.toFixed(3)}x`} sub={`Peak ${peakMultiple.toFixed(3)}x`} /><Metric label="Unrealized PnL" value={position.unrealized_pnl_sol == null ? "—" : sol(Number(position.unrealized_pnl_sol))} sub={`Current value ${Number(position.current_value_sol ?? sizeSol * remainingPct).toFixed(3)} SOL`} tone={Number(position.unrealized_pnl_sol ?? 0) >= 0 ? "green" : "red"} /><Metric label="Original size" value={`${sizeSol.toFixed(3)} SOL`} sub={`${(remainingPct * 100).toFixed(1)}% still open`} /><Metric label="Next planned sell" value={nextTarget} sub="Automatic paper-trader rule" tone="cyan" /></section><section className="grid two"><Panel title="Where the bot will sell" badge="EXIT PLAN"><div className="stack"><DetailRow label="Hard stop" value={`${price(hardStopPrice)} • 0.85x`} note="Closes all remaining tokens if price falls 15% below entry." /><DetailRow label="Take profit 1" value={`${price(tp1Price)} • 1.30x`} note="Sells 50% of the position when reached." /><DetailRow label="Take profit 2" value={`${price(tp2Price)} • 1.60x`} note="Sells 50% of the remaining position when reached." /><DetailRow label="Trailing stop" value={trailingFloorPrice == null ? "Activates after a new peak above entry" : `${price(trailingFloorPrice)} • ${trailingFloorMultiple?.toFixed(3)}x`} note="Closes all remaining tokens after a 15% drop from the highest recorded price." /><DetailRow label="Maximum hold" value={maxExitAt.toLocaleString()} note="Closes all remaining tokens after 45 minutes, regardless of profit or loss." /></div></Panel><Panel title="Why the bot bought" badge="ENTRY SIGNAL"><div className="stack"><DetailRow label="Score" value={`${alert.score ?? "—"}`} /><DetailRow label="Wallets" value={`${alert.walletCount ?? "—"}`} /><DetailRow label="Total bought" value={alert.totalBoughtSol == null ? "—" : `${Number(alert.totalBoughtSol).toFixed(2)} SOL`} /><DetailRow label="Average wallet trust" value={alert.averageTrustScore == null ? "—" : Number(alert.averageTrustScore).toFixed(1)} /><DetailRow label="Market cap at signal" value={alert.marketCapUsd == null ? "—" : usd(Number(alert.marketCapUsd))} /><DetailRow label="Liquidity at signal" value={alert.liquidityUsd == null ? "—" : usd(Number(alert.liquidityUsd))} /></div></Panel></section><Panel title="Live token chart and market" badge="DEXSCREENER"><div style={{ padding: 20, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}><a href={`https://dexscreener.com/solana/${position.mint}`} target="_blank" rel="noreferrer" style={{ padding: "13px 18px", border: "1px solid rgba(255,255,255,.18)", borderRadius: 10, fontWeight: 800 }}>Open live DexScreener chart ↗</a><span style={{ opacity: .7 }}>This opens the real token chart. The trade shown here is simulated and does not move real SOL.</span></div></Panel></main>;
}

function DetailRow({ label, value, note }: { label: string; value: string; note?: string }) { return <div className="position" style={{ gridTemplateColumns: "minmax(130px,.7fr) minmax(180px,1fr)" }}><div><span>{label}</span>{note && <small style={{ display: "block", marginTop: 5, opacity: .65 }}>{note}</small>}</div><div><b>{value}</b></div></div>; }
function Metric({ label, value, sub, tone = "" }: { label: string; value: string; sub?: string; tone?: string }) { return <div className="metric"><span>{label}</span><strong className={tone}>{value}</strong>{sub && <small>{sub}</small>}</div>; }
function Panel({ title, badge, children }: { title: string; badge: string; children: React.ReactNode }) { return <section className="panel"><div className="panelHead"><h2>{title}</h2><span>{badge}</span></div>{children}</section>; }
function Empty({ text }: { text: string }) { return <div className="empty">{text}</div>; }
function Feed({ rows, type }: { rows: any[]; type: "trade" | "transaction" }) { if (!rows.length) return <Empty text="No activity recorded yet." />; return <div className="feed">{rows.map((row, index) => { const positive = type === "trade" ? Number(row.pnl_sol) >= 0 : row.side === "buy"; return <div className="feedRow" key={`${row.id ?? row.token_mint}:${index}`}><i className={positive ? "up" : "down"}>{positive ? "↗" : "↘"}</i><div><strong>{type === "trade" ? row.token_symbol : short(row.token_mint)}</strong><small>{type === "trade" ? row.reason.replaceAll("_", " ") : `${row.wallet_address} • ${row.side}`}</small></div><div className="feedValue"><b className={positive ? "green" : "red"}>{type === "trade" ? sol(Number(row.pnl_sol)) : `${Number(row.sol_amount).toFixed(3)} SOL`}</b><small>{time(type === "trade" ? row.happened_at : row.tx_time)}</small></div></div>; })}</div>; }
