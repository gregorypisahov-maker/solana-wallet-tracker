type ReadinessState = {
  strategy_version: string;
  started_at: string;
  ready: boolean;
  completed_trades: number | string;
  active_days: number | string;
  wins: number | string;
  losses: number | string;
  win_rate: number | string;
  realized_pnl_sol: number | string;
  profit_factor: number | string | null;
  max_drawdown_pct: number | string;
  largest_winner_share: number | string;
  blockers: string[];
  last_evaluated_at: string;
} | null;

type DiscoveryRun = {
  status: string;
  fetched_count: number;
  eligible_count: number;
  added_count: number;
  added_addresses: string[];
  error_message: string | null;
  ran_at: string;
} | null;

type VerifiedTrader = {
  walletAddress: string;
  label: string | null;
  managementStatus: string;
  discoveredAt: string | null;
  observedSwaps: number;
  closedTrades: number;
  distinctClosedTokens: number;
  winRate: number;
  realizedPnlSol: number;
  profitFactor: number | null;
  maxDrawdownSol: number;
  profiledAt: string | null;
};

type StrategyLane = {
  signalSource: "wallet_consensus" | "proven_trader_copy";
  completedTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  realizedPnlSol: number;
  profitFactor: number | null;
};

type StrategyAssumptions = {
  normalPositionSizePct: number;
  provenTraderSizeMultiplier: number;
  entryFrictionPct: number;
  exitFrictionPct: number;
  roundTripFrictionPct: number;
  readinessRules: {
    minimumCompletedTrades: number;
    minimumActiveDays: number;
    minimumProfitFactor: number;
    maximumDrawdownPct: number;
    maximumSingleWinnerShare: number;
  };
};

type StrategyStatusProps = {
  readiness: ReadinessState;
  discovery: DiscoveryRun;
  verifiedTraders: VerifiedTrader[];
  strategyPerformance: {
    strategyVersion: string;
    lanes: StrategyLane[];
  };
  assumptions: StrategyAssumptions;
};

const clampPercent = (value: number) =>
  Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));

const signedSol = (value: number) =>
  `${value >= 0 ? "+" : ""}${value.toFixed(3)} SOL`;

const blockerText: Record<string, string> = {
  minimum_100_forward_trades_not_reached: "100 forward trades not reached",
  minimum_45_forward_days_not_reached: "45 forward days not reached",
  forward_pnl_not_positive: "Forward PnL is not positive",
  profit_factor_below_1_4: "Profit factor is below 1.40",
  maximum_drawdown_above_10_percent: "Maximum drawdown exceeds 10%",
  results_too_concentrated_in_one_winner: "Results rely too heavily on one winner",
};

const laneLabel = (source: StrategyLane["signalSource"]) =>
  source === "proven_trader_copy" ? "Verified trader copy" : "Wallet consensus";

export default function StrategyStatus({
  readiness,
  discovery,
  verifiedTraders,
  strategyPerformance,
  assumptions,
}: StrategyStatusProps) {
  const minimumTrades = assumptions.readinessRules.minimumCompletedTrades;
  const minimumDays = assumptions.readinessRules.minimumActiveDays;
  const completedTrades = Number(readiness?.completed_trades ?? 0);
  const activeDays = Number(readiness?.active_days ?? 0);
  const blockers = readiness?.blockers ?? ["Readiness state unavailable"];

  return (
    <>
      <section className={`panel readinessPanel ${readiness?.ready ? "ready" : "blocked"}`}>
        <div className="panelHead">
          <h2>Real-money readiness gate</h2>
          <span>{readiness?.ready ? "READY" : "NOT READY"}</span>
        </div>
        <div className="gateHero">
          <div>
            <strong>{readiness?.ready ? "Forward evidence passed" : "Savings remain protected"}</strong>
            <small>
              {readiness?.ready
                ? "Every automatic evidence threshold is currently satisfied."
                : "Paper trading continues until every forward-performance threshold passes."}
            </small>
          </div>
          <code>{strategyPerformance.strategyVersion}</code>
        </div>
        <div className="readinessGrid">
          <div>
            <span>Forward trades</span>
            <b>{completedTrades}/{minimumTrades}</b>
            <div className="progressTrack" role="progressbar" aria-label="Forward trade evidence progress" aria-valuemin={0} aria-valuemax={minimumTrades} aria-valuenow={completedTrades}><i style={{ width: `${clampPercent((completedTrades / minimumTrades) * 100)}%` }} /></div>
          </div>
          <div>
            <span>Forward days</span>
            <b>{activeDays.toFixed(1)}/{minimumDays}</b>
            <div className="progressTrack" role="progressbar" aria-label="Forward day evidence progress" aria-valuemin={0} aria-valuemax={minimumDays} aria-valuenow={activeDays}><i style={{ width: `${clampPercent((activeDays / minimumDays) * 100)}%` }} /></div>
          </div>
          <div><span>Forward PnL</span><b className={Number(readiness?.realized_pnl_sol ?? 0) >= 0 ? "green" : "red"}>{signedSol(Number(readiness?.realized_pnl_sol ?? 0))}</b></div>
          <div><span>Profit factor</span><b>{readiness?.profit_factor == null ? "—" : Number(readiness.profit_factor).toFixed(2)}</b><small>Minimum {assumptions.readinessRules.minimumProfitFactor.toFixed(2)}</small></div>
          <div><span>Max drawdown</span><b>{(Number(readiness?.max_drawdown_pct ?? 0) * 100).toFixed(1)}%</b><small>Maximum {(assumptions.readinessRules.maximumDrawdownPct * 100).toFixed(0)}%</small></div>
          <div><span>Largest winner share</span><b>{(Number(readiness?.largest_winner_share ?? 0) * 100).toFixed(1)}%</b><small>Maximum {(assumptions.readinessRules.maximumSingleWinnerShare * 100).toFixed(0)}%</small></div>
        </div>
        <div className="blockerList">
          {blockers.length === 0 ? <span className="gateClear">✓ No active blockers</span> : blockers.map((blocker) => <span key={blocker}>• {blockerText[blocker] ?? blocker.replaceAll("_", " ")}</span>)}
        </div>
      </section>

      <section className="grid two strategyGrid">
        <section className="panel">
          <div className="panelHead"><h2>Verified profitable traders</h2><span>{verifiedTraders.length} ACTIVE</span></div>
          {verifiedTraders.length === 0 ? <div className="empty">No independently verified trader currently qualifies.</div> : <div className="stack">
            {verifiedTraders.map((trader) => <div className="copyProfile" key={trader.walletAddress}>
              <div className="copyProfileTitle"><div><strong>{trader.label ?? trader.walletAddress}</strong><small>{trader.walletAddress} • {trader.managementStatus}</small></div><b className="green">QUALIFIED</b></div>
              <div className="copyProfileMetrics">
                <div><span>Closed</span><b>{trader.closedTrades}</b></div>
                <div><span>Tokens</span><b>{trader.distinctClosedTokens}</b></div>
                <div><span>Win rate</span><b>{(trader.winRate * 100).toFixed(1)}%</b></div>
                <div><span>Profit factor</span><b>{trader.profitFactor == null ? "—" : trader.profitFactor.toFixed(2)}</b></div>
                <div><span>Realized</span><b className={trader.realizedPnlSol >= 0 ? "green" : "red"}>{signedSol(trader.realizedPnlSol)}</b></div>
              </div>
            </div>)}
          </div>}
          <div className="discoveryLine">
            <span>Last discovery</span>
            <b>{discovery ? `${discovery.fetched_count} checked • ${discovery.eligible_count} eligible • ${discovery.added_count} added` : "Unavailable"}</b>
            <small>{discovery?.ran_at ? new Date(discovery.ran_at).toLocaleString() : "—"}</small>
          </div>
        </section>

        <section className="panel">
          <div className="panelHead"><h2>Current strategy performance</h2><span>BY SIGNAL SOURCE</span></div>
          <div className="stack">
            {strategyPerformance.lanes.map((lane) => <div className="laneRow" key={lane.signalSource}>
              <div><strong>{laneLabel(lane.signalSource)}</strong><small>{lane.signalSource === "proven_trader_copy" ? `${(assumptions.provenTraderSizeMultiplier * 100).toFixed(0)}% of normal size` : "Normal risk size"}</small></div>
              <div><span>Trades</span><b>{lane.completedTrades}</b></div>
              <div><span>Win</span><b>{(lane.winRate * 100).toFixed(1)}%</b></div>
              <div><span>PnL</span><b className={lane.realizedPnlSol >= 0 ? "green" : "red"}>{signedSol(lane.realizedPnlSol)}</b></div>
              <div><span>PF</span><b>{lane.profitFactor == null ? "—" : lane.profitFactor.toFixed(2)}</b></div>
            </div>)}
          </div>
          <div className="executionModel">
            <strong>Execution model</strong>
            <span>{(assumptions.entryFrictionPct * 100).toFixed(1)}% entry + {(assumptions.exitFrictionPct * 100).toFixed(1)}% exit friction</span>
            <b>{(assumptions.roundTripFrictionPct * 100).toFixed(1)}% round trip</b>
          </div>
        </section>
      </section>
    </>
  );
}
