"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

type ShadowData = {
  generatedAt: string;
  state: any;
  positions: any[];
  trades: any[];
  summary: {
    enabled: boolean;
    cashSol: number;
    startingBankrollSol: number;
    openPositionValueSol: number;
    equitySol: number;
    totalPnlSol: number;
    returnPct: number;
    completedTrades: number;
    openPositions: number;
    wins: number;
    losses: number;
    winRate: number;
    profitFactor: number | null;
  };
};

const sol = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(3)} SOL`;
const time = (value: string | null) => (value ? new Date(value).toLocaleString() : "—");

export default function ShadowDashboardPanel() {
  const pathname = usePathname();
  const [data, setData] = useState<ShadowData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (pathname !== "/") return;

    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch("/api/shadow-dashboard", { cache: "no-store" });
        if (response.status === 401) return;
        if (!response.ok) throw new Error("Could not load shadow strategy");
        const payload = await response.json();
        if (active) {
          setData(payload);
          setError(null);
        }
      } catch (requestError) {
        if (active) {
          setError(
            requestError instanceof Error
              ? requestError.message
              : "Could not load shadow strategy"
          );
        }
      }
    };

    refresh();
    const timer = window.setInterval(refresh, 10_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [pathname]);

  if (pathname !== "/" || (!data && !error)) return null;

  return (
    <div className="shell" style={{ paddingTop: 0 }}>
      <section className="panel">
        <div className="panelHead">
          <h2>Shadow strategy</h2>
          <span>PAPER TEST • {data?.summary.enabled ? "ACTIVE" : "PAUSED"}</span>
        </div>

        {error && !data ? (
          <div className="empty">{error}</div>
        ) : data ? (
          <>
            <div className="scalpIntro">
              <div>
                <span className={`scalpDot ${data.summary.enabled ? "active" : "paused"}`} />{" "}
                <strong>
                  {data.summary.enabled
                    ? "Testing stricter wallet-consensus rules"
                    : "Shadow testing is paused"}
                </strong>
                <small>
                  Fake SOL only • separate from the regular bot • refreshes every 10 seconds
                </small>
              </div>
              <code>{data.summary.completedTrades} trades</code>
            </div>

            <div className="scalpMetrics">
              <div>
                <span>Equity</span>
                <b>{data.summary.equitySol.toFixed(3)} SOL</b>
                <small>Started with {data.summary.startingBankrollSol.toFixed(3)}</small>
              </div>
              <div>
                <span>Total PnL</span>
                <b className={data.summary.totalPnlSol >= 0 ? "green" : "red"}>
                  {sol(data.summary.totalPnlSol)}
                </b>
                <small>{data.summary.returnPct >= 0 ? "+" : ""}{data.summary.returnPct.toFixed(1)}%</small>
              </div>
              <div>
                <span>Profit factor</span>
                <b>{data.summary.profitFactor == null ? "—" : data.summary.profitFactor.toFixed(2)}</b>
                <small>Gross wins ÷ gross losses</small>
              </div>
              <div>
                <span>Win rate</span>
                <b>{(data.summary.winRate * 100).toFixed(1)}%</b>
                <small>{data.summary.wins}W / {data.summary.losses}L</small>
              </div>
              <div>
                <span>Positions</span>
                <b>{data.summary.openPositions} open</b>
                <small>{data.summary.completedTrades} completed</small>
              </div>
            </div>

            <div className="scalpBody">
              <div>
                <h3>Open shadow positions</h3>
                {data.positions.length ? (
                  <div className="miniTrades">
                    {data.positions.map((position) => (
                      <div key={position.position_id ?? position.mint}>
                        <span>
                          <strong>{position.token_symbol}</strong>
                          <small>{Number(position.size_sol).toFixed(3)} SOL</small>
                        </span>
                        <b>{Number(position.peak_multiple ?? 1).toFixed(2)}x peak</b>
                        <time>{time(position.entry_time)}</time>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="empty">No shadow position is open right now.</div>
                )}
              </div>

              <div>
                <h3>Recent shadow exits</h3>
                {data.trades.length ? (
                  <div className="miniTrades">
                    {data.trades.slice(0, 5).map((trade) => (
                      <div key={trade.id ?? `${trade.position_id}:${trade.happened_at}`}>
                        <span>
                          <strong>{trade.token_symbol}</strong>
                          <small>{String(trade.reason).replaceAll("_", " ")}</small>
                        </span>
                        <b className={Number(trade.pnl_sol) >= 0 ? "green" : "red"}>
                          {sol(Number(trade.pnl_sol))}
                        </b>
                        <time>{time(trade.happened_at)}</time>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="empty">No completed shadow trades yet.</div>
                )}
              </div>
            </div>

            <div className="scalpRules">
              Experimental strategy only • results do not affect the regular bot or real funds
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}
