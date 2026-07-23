"use client";

import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import styles from "./binance-live.module.css";

type Direction = "LONG" | "SHORT";
type Tick = { at: number; price: number };
type SideData = {
  side: Direction;
  status: string;
  position: any | null;
  moveMagnitudePct: number;
  currentMovePct: number;
  triggerThresholdPct: number;
  triggerProgressPct: number;
  distanceToTriggerPct: number;
  plannedEntryFillPrice: number;
  plannedStopLossPrice: number;
  plannedTakeProfitPrice: number;
  plannedNotionalUsdt: number;
  cooldownUntil: string | null;
  liveGrossPnlUsdt: number;
  liveNetPnlUsdt: number;
  liveMarginReturnPct: number;
  livePriceReturnPct: number;
  targetProgressPct: number;
  stopRiskPct: number;
  stopBufferPct: number | null;
  targetDistancePct: number | null;
  holdMinutes: number;
};

type LiveData = {
  generatedAt: string;
  config: {
    symbol: string;
    leverage: number;
    marginBudgetUsdt: number;
    pumpThresholdPct: number;
    lookbackCandles: number;
    stopLossPct: number;
    takeProfitPct: number;
    takerFeePctPerSide: number;
    slippagePctPerSide: number;
    maxHoldMinutes: number;
    cooldownMinutes: number;
    maxDailyEntries: number;
    maxOpenPositions: number;
  };
  state: any;
  positions: any[];
  scans: any[];
  trades: any[];
  derived: {
    overallStatus: string;
    currentPrice: number;
    pumpMovePct: number;
    dumpMovePct: number;
    triggerThresholdPct: number;
    plannedNotionalUsdt: number;
    openSides: Direction[];
    pendingSides: Direction[];
    sides: Record<Direction, SideData>;
    heartbeatAt: string | null;
    heartbeatAgeSeconds: number | null;
    feedHealthy: boolean;
    latestScanAt: string | null;
  };
};

type ChartLevel = {
  value: number;
  label: string;
  className: string;
};

const SIDES: Direction[] = ["LONG", "SHORT"];
const n = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const usd = (value: unknown, digits = 2) =>
  `$${n(value).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
const signedUsd = (value: unknown) => `${n(value) >= 0 ? "+" : "-"}${usd(Math.abs(n(value)))}`;
const pct = (value: unknown, digits = 2) => `${n(value) >= 0 ? "+" : ""}${n(value).toFixed(digits)}%`;
const israelTime = (value: string | null | undefined) => {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat("en-IL", {
    timeZone: "Asia/Jerusalem",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
};
const age = (value: string | null | undefined, now: number) => {
  if (!value || !Number.isFinite(Date.parse(value))) return "No heartbeat";
  const seconds = Math.max(0, Math.floor((now - Date.parse(value)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s ago`;
};

function overallStatusText(status: string) {
  if (status === "both_positions_open") return "LONG + SHORT POSITIONS OPEN";
  if (status === "one_position_open") return "ONE POSITION OPEN · OTHER SLOT READY";
  if (status === "signal_pending") return "SIGNAL HIT · FILL PENDING";
  if (status === "halted") return "RISK HALTED";
  if (status === "disabled") return "BOT DISABLED";
  return "WAITING FOR LONG OR SHORT SIGNAL";
}

function sideStatusText(side: Direction, status: string) {
  if (status === "position_open") return `${side} OPEN`;
  if (status === "signal_pending") return `${side} FILL PENDING`;
  if (status === "cooldown") return `${side} COOLDOWN`;
  if (status === "halted") return "RISK HALTED";
  if (status === "disabled") return "BOT DISABLED";
  return `${side} SLOT READY`;
}

function statusTone(status: string) {
  if (status === "position_open") return styles.open;
  if (status === "signal_pending") return styles.pending;
  if (status === "halted" || status === "disabled") return styles.halted;
  return styles.waiting;
}

function PriceChart({ ticks, levels }: { ticks: Tick[]; levels: ChartLevel[] }) {
  const width = 1000;
  const height = 360;
  const padX = 18;
  const padY = 24;
  const visible = ticks.filter((tick) => tick.price > 0).slice(-180);
  const levelValues = levels.map((level) => level.value).filter((value) => value > 0);
  const fallback = levelValues[0] ?? 1;
  const points = visible.length
    ? visible
    : [
        { at: Date.now() - 1_000, price: fallback },
        { at: Date.now(), price: fallback },
      ];
  const values = [...points.map((point) => point.price), ...levelValues].filter(
    (value) => Number.isFinite(value) && value > 0
  );
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const rangePad = Math.max((rawMax - rawMin) * 0.18, rawMax * 0.0007);
  const min = rawMin - rangePad;
  const max = rawMax + rangePad;
  const range = max - min || 1;
  const x = (index: number) =>
    padX + (index / Math.max(1, points.length - 1)) * (width - padX * 2);
  const y = (price: number) =>
    padY + ((max - price) / range) * (height - padY * 2);
  const path = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${x(index)},${y(point.price)}`)
    .join(" ");
  const areaPath = `${path} L${x(points.length - 1)},${height - padY} L${x(0)},${height - padY} Z`;
  const latest = points[points.length - 1];

  return (
    <svg className={styles.chart} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id="btcArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f7931a" stopOpacity="0.24" />
          <stop offset="100%" stopColor="#f7931a" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0.2, 0.4, 0.6, 0.8].map((part) => (
        <line
          key={part}
          className={styles.gridLine}
          x1="0"
          x2={width}
          y1={height * part}
          y2={height * part}
        />
      ))}
      {levels.filter((level) => level.value > 0).map((level) => (
        <g key={level.label}>
          <line
            className={level.className}
            x1="0"
            x2={width}
            y1={y(level.value)}
            y2={y(level.value)}
          />
          <text className={styles.svgLabel} x={width - 12} y={y(level.value) - 7} textAnchor="end">
            {level.label}
          </text>
        </g>
      ))}
      <path d={areaPath} fill="url(#btcArea)" />
      <path className={styles.priceLine} d={path} />
      <circle className={styles.latestDot} cx={x(points.length - 1)} cy={y(latest.price)} r="5" />
    </svg>
  );
}

function StrategyCard({ side, sideData, config, source }: {
  side: Direction;
  sideData: SideData;
  config: LiveData["config"];
  source: string;
}) {
  const isLong = side === "LONG";
  const position = sideData.position;
  const entry = position ? n(position.entry_fill_price) : sideData.plannedEntryFillPrice;
  const stop = position ? n(position.stop_loss_price) : sideData.plannedStopLossPrice;
  const target = position ? n(position.take_profit_price) : sideData.plannedTakeProfitPrice;
  const directionTone = isLong ? styles.positive : styles.negative;

  return (
    <article className={`${styles.card} ${styles.strategy}`}>
      <div className={styles.heroHead}>
        <div>
          <span className={styles.eyebrow}>{side} entry plan · independent slot</span>
          <h3 className={directionTone}>
            {isLong ? "Long after a fast BTC drop" : "Short after a fast BTC pump"}
          </h3>
        </div>
        <span className={`${styles.status} ${statusTone(sideData.status)}`}>
          {sideStatusText(side, sideData.status)}
        </span>
      </div>
      <p>
        {isLong
          ? `A ${config.pumpThresholdPct}% drop across ${config.lookbackCandles} completed one-minute candles can open the LONG slot.`
          : `A ${config.pumpThresholdPct}% rise across ${config.lookbackCandles} completed one-minute candles can open the SHORT slot.`}
      </p>
      <div className={styles.levels}>
        <div className={styles.level}>
          <span>Trigger</span>
          <strong>{isLong ? "−" : "+"}{config.pumpThresholdPct.toFixed(2)}% / {config.lookbackCandles}m</strong>
        </div>
        <div className={styles.level}>
          <span>Current move</span>
          <strong className={directionTone}>{pct(sideData.currentMovePct)}</strong>
        </div>
        <div className={styles.level}>
          <span>{position ? "Entry fill" : "Planned entry"}</span>
          <strong>{usd(entry)}</strong>
        </div>
        <div className={`${styles.level} ${styles.stop}`}>
          <span>Stop loss</span>
          <strong>{usd(stop)} · {isLong ? "−" : "+"}{config.stopLossPct}%</strong>
        </div>
        <div className={`${styles.level} ${styles.target}`}>
          <span>Take profit</span>
          <strong>{usd(target)} · {isLong ? "+" : "−"}{config.takeProfitPct}%</strong>
        </div>
        <div className={styles.level}>
          <span>Slot size</span>
          <strong>{usd(config.marginBudgetUsdt)} margin · {config.leverage}×</strong>
        </div>
      </div>
      <div className={styles.progressBlock}>
        <div className={styles.progressLabels}>
          <strong>{sideData.triggerProgressPct.toFixed(0)}% of trigger</strong>
          <span>{sideData.distanceToTriggerPct.toFixed(2)}% still needed</span>
        </div>
        <div className={styles.progressTrack}>
          <div className={styles.progressFill} style={{ width: `${sideData.triggerProgressPct}%` }} />
        </div>
      </div>
      <div className={styles.note}>
        {source}. This slot is paper-only, database-backed, and includes simulated fees and slippage.
      </div>
    </article>
  );
}

function PositionCard({ position, sideData }: { position: any; sideData: SideData }) {
  const pnlTone = sideData.liveNetPnlUsdt >= 0 ? styles.positive : styles.negative;
  return (
    <article className={`${styles.card} ${styles.positionCard}`}>
      <div className={styles.positionTop}>
        <div>
          <span className={styles.eyebrow}>Open independent {position.side} slot</span>
          <h3>{position.side} {position.symbol} · {position.leverage}×</h3>
          <p>Opened {israelTime(position.opened_at)} Israel · held {sideData.holdMinutes.toFixed(1)} minutes</p>
        </div>
        <div className={`${styles.pnl} ${pnlTone}`}>
          {signedUsd(sideData.liveNetPnlUsdt)}
          <p>{pct(sideData.liveMarginReturnPct)} on margin</p>
        </div>
      </div>
      <div className={styles.positionGrid}>
        <div className={styles.metric}><span>Side</span><strong>{position.side}</strong></div>
        <div className={styles.metric}><span>Entry fill</span><strong>{usd(position.entry_fill_price)}</strong></div>
        <div className={styles.metric}><span>Current price</span><strong>{usd(position.last_market_price)}</strong></div>
        <div className={styles.metric}><span>Quantity</span><strong>{n(position.quantity).toFixed(6)} BTC</strong></div>
        <div className={styles.metric}><span>Price return</span><strong className={pnlTone}>{pct(sideData.livePriceReturnPct)}</strong></div>
        <div className={styles.metric}><span>Gross PnL</span><strong className={pnlTone}>{signedUsd(sideData.liveGrossPnlUsdt)}</strong></div>
      </div>
      <div className={styles.dualProgress}>
        <div>
          <div className={styles.miniLabel}><span>Progress toward target</span><strong>{sideData.targetProgressPct.toFixed(0)}%</strong></div>
          <div className={styles.miniTrack}><div className={styles.miniFillGood} style={{ width: `${sideData.targetProgressPct}%` }} /></div>
        </div>
        <div>
          <div className={styles.miniLabel}><span>Risk used toward stop</span><strong>{sideData.stopRiskPct.toFixed(0)}%</strong></div>
          <div className={styles.miniTrack}><div className={styles.miniFillBad} style={{ width: `${sideData.stopRiskPct}%` }} /></div>
        </div>
      </div>
    </article>
  );
}

export default function BinanceLivePage() {
  const [data, setData] = useState<LiveData | null>(null);
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/binance-live", { cache: "no-store" });
      if (response.status === 401) {
        setNeedsLogin(true);
        setData(null);
        return;
      }
      if (!response.ok) throw new Error("Could not load Binance paper feed");
      const body = (await response.json()) as LiveData;
      setData(body);
      setNeedsLogin(false);
      setError(null);

      const seed: Tick[] = body.scans
        .map((scan) => ({
          at: Date.parse(scan.candle_close_time),
          price: n(scan.close_price),
        }))
        .filter((point) => Number.isFinite(point.at) && point.price > 0);
      const livePoint = {
        at: Date.parse(body.derived.heartbeatAt ?? body.generatedAt),
        price: n(body.derived.currentPrice),
      };
      setTicks((current) => {
        const map = new Map<number, Tick>();
        const source = current.length ? current : seed;
        for (const point of source) map.set(point.at, point);
        if (Number.isFinite(livePoint.at) && livePoint.price > 0) {
          map.set(livePoint.at, livePoint);
        }
        return [...map.values()]
          .sort((left, right) => left.at - right.at)
          .slice(-180);
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load Binance paper feed");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const refreshTimer = setInterval(() => void refresh(), 3_000);
    const clockTimer = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      clearInterval(refreshTimer);
      clearInterval(clockTimer);
    };
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

  const chartLevels = useMemo<ChartLevel[]>(() => {
    if (!data) return [];
    return SIDES.flatMap((side) => {
      const sideData = data.derived.sides[side];
      const position = sideData.position;
      const entry = position ? n(position.entry_fill_price) : sideData.plannedEntryFillPrice;
      const stop = position ? n(position.stop_loss_price) : sideData.plannedStopLossPrice;
      const target = position ? n(position.take_profit_price) : sideData.plannedTakeProfitPrice;
      return [
        { value: stop, label: `${side} STOP ${usd(stop)}`, className: styles.stopLine },
        { value: entry, label: `${side} ENTRY ${usd(entry)}`, className: styles.entryLine },
        { value: target, label: `${side} TARGET ${usd(target)}`, className: styles.targetLine },
      ];
    });
  }, [data]);

  if (!data) {
    if (needsLogin) {
      return (
        <main className={styles.login}>
          <form onSubmit={login}>
            <div className={styles.coin}>₿</div>
            <h1>BTC Dual Position Live</h1>
            <p>Use the same password as the private strategy platform.</p>
            <input
              type="password"
              value={password}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setPassword(event.target.value)}
              placeholder="Dashboard password"
              autoFocus
            />
            <button>Open live feed</button>
            {error && <small className={styles.error}>{error}</small>}
          </form>
        </main>
      );
    }
    return (
      <main className={styles.login}>
        <div className={styles.loader}>
          <span className={styles.spinner} />
          <div>
            <strong>BTC Dual Position Live</strong>
            <p>{error ?? "Synchronizing both Binance paper slots"}</p>
          </div>
        </div>
      </main>
    );
  }

  const { config, derived, state } = data;
  const source =
    state?.data_source === "binance_spot_fallback"
      ? "Binance Spot BTCUSDT reference"
      : "Binance USD-M Futures reference";
  const feedHealthy = derived.feedHealthy;

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.topbar}>
          <div className={styles.brand}>
            <div className={styles.coin}>₿</div>
            <div>
              <h1>BTC Dual Position Paper Trader</h1>
              <p>One independent LONG slot and one independent SHORT slot · paper only</p>
            </div>
          </div>
          <div className={styles.topActions}>
            <a className={styles.back} href="/platform">← Platform</a>
            <div className={styles.livePill}>
              <span className={`${styles.dot} ${feedHealthy ? "" : styles.stale}`} />
              {feedHealthy ? "Live feed" : "Feed delayed"} · {age(derived.heartbeatAt, now)}
            </div>
          </div>
        </header>

        {error && <div className={styles.note}>{error}</div>}

        <section className={styles.grid}>
          <article className={`${styles.card} ${styles.hero}`}>
            <div className={styles.heroHead}>
              <div>
                <span className={styles.eyebrow}>{config.symbol} · 2 independent paper slots</span>
                <h2>{overallStatusText(derived.overallStatus)}</h2>
                <div className={styles.heroPrice}>{usd(derived.currentPrice)}</div>
              </div>
              <span className={`${styles.status} ${statusTone(data.positions.length ? "position_open" : derived.overallStatus)}`}>
                {data.positions.length}/2 open
              </span>
            </div>

            <div className={styles.progressBlock}>
              <div className={styles.progressLabels}>
                <strong className={styles.positive}>LONG drop trigger −{derived.sides.LONG.moveMagnitudePct.toFixed(2)}%</strong>
                <span>{derived.sides.LONG.distanceToTriggerPct.toFixed(2)}% still needed</span>
              </div>
              <div className={styles.progressTrack}>
                <div className={styles.progressFill} style={{ width: `${derived.sides.LONG.triggerProgressPct}%` }} />
              </div>
            </div>
            <div className={styles.progressBlock}>
              <div className={styles.progressLabels}>
                <strong className={styles.negative}>SHORT pump trigger +{derived.sides.SHORT.moveMagnitudePct.toFixed(2)}%</strong>
                <span>{derived.sides.SHORT.distanceToTriggerPct.toFixed(2)}% still needed</span>
              </div>
              <div className={styles.progressTrack}>
                <div className={styles.progressFill} style={{ width: `${derived.sides.SHORT.triggerProgressPct}%` }} />
              </div>
            </div>

            <div className={styles.chartWrap}>
              <PriceChart ticks={ticks} levels={chartLevels} />
            </div>
          </article>

          <aside className={styles.side}>
            <StrategyCard side="LONG" sideData={derived.sides.LONG} config={config} source={source} />
            <StrategyCard side="SHORT" sideData={derived.sides.SHORT} config={config} source={source} />
          </aside>

          <section className={styles.kpis}>
            <article className={`${styles.card} ${styles.kpi}`}><span>BTC price</span><strong>{usd(derived.currentPrice)}</strong><small>Updated {israelTime(derived.heartbeatAt)} Israel</small></article>
            <article className={`${styles.card} ${styles.kpi}`}><span>LONG slot</span><strong className={styles.positive}>{sideStatusText("LONG", derived.sides.LONG.status)}</strong><small>Drop progress {derived.sides.LONG.triggerProgressPct.toFixed(0)}%</small></article>
            <article className={`${styles.card} ${styles.kpi}`}><span>SHORT slot</span><strong className={styles.negative}>{sideStatusText("SHORT", derived.sides.SHORT.status)}</strong><small>Pump progress {derived.sides.SHORT.triggerProgressPct.toFixed(0)}%</small></article>
            <article className={`${styles.card} ${styles.kpi}`}><span>Paper bankroll</span><strong>{usd(state?.bankroll_usdt)}</strong><small>{state?.entries_today ?? 0}/{config.maxDailyEntries} entries today</small></article>
            <article className={`${styles.card} ${styles.kpi}`}><span>Market source</span><strong>{state?.data_source === "binance_spot_fallback" ? "Spot fallback" : "Futures"}</strong><small>{feedHealthy ? "Receiving prices" : "Heartbeat delayed"}</small></article>
          </section>

          {data.positions.length === 0 ? (
            <article className={`${styles.card} ${styles.positionCard}`}>
              <span className={styles.eyebrow}>Open simulated positions</span>
              <h3>No positions open · LONG and SHORT slots are available</h3>
              <p>The bot can hold one LONG and one SHORT at the same time when each side receives its own valid signal.</p>
            </article>
          ) : (
            data.positions.map((position) => (
              <PositionCard
                key={position.position_id}
                position={position}
                sideData={derived.sides[String(position.side).toUpperCase() as Direction]}
              />
            ))
          )}

          <section className={styles.bottom}>
            <article className={`${styles.card} ${styles.events}`}>
              <h3>Decision feed</h3>
              <p>Each candle shows whether the LONG slot, SHORT slot, or both were considered.</p>
              <div className={styles.eventList}>
                {[...data.scans].reverse().slice(0, 14).map((scan) => {
                  const snapshot = scan.snapshot ?? {};
                  const sides = Array.isArray(snapshot.triggered_sides)
                    ? snapshot.triggered_sides.join(" + ")
                    : snapshot.signal_side ?? "NO SIDE";
                  return (
                    <div className={styles.event} key={`${scan.symbol}-${scan.candle_close_time}`}>
                      <time>{israelTime(scan.candle_close_time)}</time>
                      <div>
                        <b>{String(scan.action).replaceAll("_", " ")} · {sides}</b>
                        <div className={n(scan.rolling_change_pct) >= 0 ? styles.positive : styles.negative}>
                          {pct(scan.rolling_change_pct)} recorded move · {usd(scan.close_price)}
                        </div>
                      </div>
                      <em>{String(scan.reason ?? "").replaceAll("_", " ")}</em>
                    </div>
                  );
                })}
              </div>
            </article>

            <article className={`${styles.card} ${styles.trades}`}>
              <h3>Completed paper trades</h3>
              <p>Every result is labeled LONG or SHORT after simulated fees and slippage.</p>
              {data.trades.length === 0 ? (
                <div className={styles.empty}>No completed Binance paper trades yet. Both independent slots are now waiting for valid ±{config.pumpThresholdPct}% moves.</div>
              ) : (
                <div className={styles.tradeTable}>
                  <div className={`${styles.tradeRow} ${styles.head}`}><span>Closed</span><span>Side</span><span>Reason</span><span>Entry</span><span>Exit</span><strong>Net PnL</strong></div>
                  {data.trades.map((trade) => (
                    <div className={styles.tradeRow} key={trade.position_id}>
                      <span>{israelTime(trade.closed_at)}</span>
                      <span>{String(trade.side ?? "—")}</span>
                      <span>{String(trade.exit_reason).replaceAll("_", " ")}</span>
                      <span>{usd(trade.entry_fill_price)}</span>
                      <span>{usd(trade.exit_fill_price)}</span>
                      <strong className={n(trade.net_pnl_usdt) >= 0 ? styles.positive : styles.negative}>{signedUsd(trade.net_pnl_usdt)}</strong>
                    </div>
                  ))}
                </div>
              )}
            </article>
          </section>
        </section>
      </div>
    </main>
  );
}
