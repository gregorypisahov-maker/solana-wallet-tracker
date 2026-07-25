import fs from "node:fs";

function patch(path, replacements) {
  let text = fs.readFileSync(path, "utf8");
  let changed = false;
  for (const replacement of replacements) {
    const { from, to, marker } = replacement;
    if (marker && text.includes(marker)) continue;
    if (!text.includes(from)) {
      console.warn(`[patch-ai-live-position] pattern missing in ${path}: ${from.slice(0, 120)}`);
      continue;
    }
    text = text.replace(from, to);
    changed = true;
  }
  if (changed) fs.writeFileSync(path, text);
}

patch("paper-trader/aiDiscoveryTrader.ts", [
  {
    from: 'async function loadPositions(): Promise<Position[]> { const { data, error } = await supabase.from("ai_discovery_positions").select("*").order("opened_at", { ascending: true }); if (error) throw new Error(error.message); return (data ?? []) as Position[]; }',
    to: `async function loadPositions(): Promise<Position[]> { const { data, error } = await supabase.from("ai_discovery_positions").select("*").order("opened_at", { ascending: true }); if (error) throw new Error(error.message); return (data ?? []) as Position[]; }

async function recordAiPositionSample(position: Position, market: Market, peak: number): Promise<void> {
  try {
    const entry = n(position.entry_price_usd);
    if (!(entry > 0) || !(market.priceUsd > 0)) return;
    const grossReturnPct = ((market.priceUsd / entry) - 1) * 100;
    const netReturnPct = grossReturnPct - ENTRY_FRICTION_PCT - EXIT_FRICTION_PCT;
    const peakReturnPct = ((peak / entry) - 1) * 100;
    const trailingArmed = peakReturnPct >= TRAIL_ARM_PCT;
    const trailingFloorPriceUsd = trailingArmed ? peak * (1 - TRAIL_DISTANCE_PCT / 100) : null;
    const { error } = await supabase.from("ai_position_price_samples").insert({
      position_id: position.position_id,
      mint: position.mint,
      token_symbol: position.token_symbol,
      pair_address: position.pair_address,
      sampled_at: new Date().toISOString(),
      price_usd: market.priceUsd,
      peak_price_usd: peak,
      gross_return_pct: grossReturnPct,
      net_return_pct: netReturnPct,
      trailing_armed: trailingArmed,
      trailing_floor_price_usd: trailingFloorPriceUsd,
      source: "worker",
    });
    if (error) console.warn(\`[ai-discovery-trader] live sample failed for \${position.token_symbol}: \${error.message}\`);
  } catch (error) {
    console.warn(\`[ai-discovery-trader] live sample failed for \${position.token_symbol}\`, error);
  }
}`,
    marker: "recordAiPositionSample",
  },
  {
    from: '        const pullbackPct = (market.priceUsd / peak - 1) * 100;\n        let reason: string | null = null;',
    to: '        const pullbackPct = (market.priceUsd / peak - 1) * 100;\n        await recordAiPositionSample(position, market, peak);\n        let reason: string | null = null;',
    marker: "await recordAiPositionSample(position, market, peak)",
  },
  {
    from: '<a href=\\"https://dexscreener.com/solana/${opportunity.pair_address}\\">Open chart</a>',
    to: '<a href=\\"https://dexscreener.com/solana/${opportunity.pair_address}\\">DexScreener</a>\\n<a href=\\"https://gmgn.ai/sol/token/${opportunity.mint}\\">GMGN</a>',
    marker: "https://gmgn.ai/sol/token/${opportunity.mint}",
  },
]);

patch("paper-trader/aiCapitalMirror.ts", [
  {
    from: '<a href=\\"https://dexscreener.com/solana/${source.pair_address}\\">Open chart</a>',
    to: '<a href=\\"https://dexscreener.com/solana/${source.pair_address}\\">DexScreener</a>\\n<a href=\\"https://gmgn.ai/sol/token/${source.mint}\\">GMGN</a>',
    marker: "https://gmgn.ai/sol/token/${source.mint}",
  },
]);

patch("app/page.tsx", [
  {
    from: `const chartUrl = (item: any) => {
  const address = chartAddress(item);
  return address ? \`https://dexscreener.com/solana/\${encodeURIComponent(address)}\` : null;
};

function botStatus`,
    to: `const chartUrl = (item: any) => {
  const address = chartAddress(item);
  return address ? \`https://dexscreener.com/solana/\${encodeURIComponent(address)}\` : null;
};
const gmgnUrl = (item: any) => {
  const mint = item?.mint ?? item?.entry_snapshot?.opportunity?.mint ?? null;
  return mint ? \`https://gmgn.ai/sol/token/\${encodeURIComponent(mint)}\` : null;
};

function botStatus`,
    marker: "const gmgnUrl =",
  },
  {
    from: 'function OpenPositions({ bot, now }: { bot: Bot; now: number }) {',
    to: `function LiveAiPosition({ bot, now }: { bot: Bot; now: number }) {
  const isAi = bot.id === "ai-discovery" || bot.id === "ai-capital";
  const positionKey = bot.positions[0]?.source_position_id ?? bot.positions[0]?.position_id ?? "none";
  const [live, setLive] = useState<any | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAi || bot.openPositions === 0) {
      setLive(null);
      setLiveError(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/ai-position-live", { cache: "no-store" });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error ?? "Could not load live AI position");
        if (!cancelled) {
          setLive(payload);
          setLiveError(null);
        }
      } catch (error) {
        if (!cancelled) setLiveError(error instanceof Error ? error.message : "Live position unavailable");
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isAi, bot.openPositions, positionKey]);

  if (!isAi || bot.openPositions === 0) return null;
  if (!live || live.open === false) {
    return (
      <section className="v2Panel v2LivePosition">
        <Title title="Live position chart" sub={liveError ?? "Loading exact market price and exit levels…"} />
      </section>
    );
  }

  const history = Array.isArray(live.history)
    ? live.history.filter((point: any) => Number.isFinite(Number(point.priceUsd)) && Number.isFinite(Date.parse(point.sampledAt)))
    : [];
  const entry = Number(live.entryPriceUsd ?? 0);
  const current = Number(live.currentPriceUsd ?? entry);
  const peak = Number(live.peakPriceUsd ?? current);
  const hardStop = Number(live.rules?.hardStopPriceUsd ?? 0);
  const takeProfit = Number(live.rules?.takeProfitPriceUsd ?? 0);
  const trailArm = Number(live.rules?.trailArmPriceUsd ?? 0);
  const trailFloor = live.rules?.trailingFloorPriceUsd == null ? null : Number(live.rules.trailingFloorPriceUsd);
  const selectedPnl = bot.id === "ai-capital" ? Number(live.capitalPnlSol ?? 0) : Number(live.sourcePnlSol ?? 0);
  const formatPrice = (value: number) => value >= 1 ? \`$\${value.toFixed(4)}\` : \`$\${value.toPrecision(6)}\`;
  const remainingMs = Math.max(0, Number(live.rules?.timeRemainingMs ?? 0));
  const remainingText = remainingMs <= 0
    ? "Due now"
    : \`\${Math.floor(remainingMs / 60_000)}m \${Math.floor((remainingMs % 60_000) / 1_000)}s\`;

  const width = 900;
  const height = 270;
  const left = 20;
  const right = 112;
  const top = 18;
  const bottom = 28;
  const guideValues = [entry, hardStop, takeProfit, trailArm, trailFloor].filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  const prices = [...history.map((point: any) => Number(point.priceUsd)), current, peak, ...guideValues].filter((value) => Number.isFinite(value) && value > 0);
  const rawMin = Math.min(...prices);
  const rawMax = Math.max(...prices);
  const pricePad = Math.max((rawMax - rawMin) * 0.12, entry * 0.01, 1e-12);
  const minPrice = rawMin - pricePad;
  const maxPrice = rawMax + pricePad;
  const startMs = Date.parse(live.openedAt);
  const lastHistoryMs = history.length ? Date.parse(history[history.length - 1].sampledAt) : now;
  const endMs = Math.max(now, lastHistoryMs, startMs + 1);
  const xAt = (timestamp: string | number) => {
    const value = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
    return left + ((value - startMs) / Math.max(1, endMs - startMs)) * (width - left - right);
  };
  const yAt = (price: number) => top + ((maxPrice - price) / Math.max(1e-18, maxPrice - minPrice)) * (height - top - bottom);
  const points = history.map((point: any) => \`\${xAt(point.sampledAt)},\${yAt(Number(point.priceUsd))}\`).join(" ");
  const guides = [
    { key: "take", label: "Take profit", price: takeProfit },
    { key: "arm", label: "Trail arms", price: trailArm },
    { key: "entry", label: "Bought", price: entry },
    ...(trailFloor ? [{ key: "trail", label: "Trail floor", price: trailFloor }] : []),
    { key: "stop", label: "Hard stop", price: hardStop },
  ].filter((guide) => Number.isFinite(guide.price) && guide.price > 0);

  return (
    <section className="v2Panel v2LivePosition">
      <div className="v2LivePositionHead">
        <div>
          <Title title={\`Live \${live.tokenSymbol} position\`} sub={\`Updates every 5 seconds · \${live.priceSource}\`} />
          {liveError && <small className="negative">{liveError}</small>}
        </div>
        <div className="v2MarketLinks">
          <a href={live.links?.dexscreener ?? chartUrl(bot.positions[0]) ?? "#"} target="_blank" rel="noreferrer">DexScreener ↗</a>
          <a href={live.links?.gmgn ?? gmgnUrl(bot.positions[0]) ?? "#"} target="_blank" rel="noreferrer">GMGN ↗</a>
        </div>
      </div>

      <div className="v2LivePriceRow">
        <div><small>Current price</small><strong>{formatPrice(current)}</strong></div>
        <div><small>Unrealized net</small><strong className={Number(live.netReturnPct) >= 0 ? "positive" : "negative"}>{Number(live.netReturnPct) >= 0 ? "+" : ""}{Number(live.netReturnPct).toFixed(2)}%</strong></div>
        <div><small>{bot.name} PnL</small><strong className={selectedPnl >= 0 ? "positive" : "negative"}>{sol(selectedPnl)}</strong></div>
        <div><small>Exit state</small><strong className={live.rules?.trailingArmed ? "amber" : ""}>{live.rules?.exitStatus ?? "Monitoring"}</strong></div>
      </div>

      <div className="v2PriceChartWrap">
        <svg className="v2PriceChart" viewBox={\`0 0 \${width} \${height}\`} preserveAspectRatio="none" aria-label="Live AI position price chart">
          {[0.25, 0.5, 0.75].map((fraction) => (
            <line key={fraction} className="grid" x1={left} x2={width - right} y1={top + fraction * (height - top - bottom)} y2={top + fraction * (height - top - bottom)} />
          ))}
          {guides.map((guide) => (
            <g key={guide.key} className={\`guide \${guide.key}\`}>
              <line x1={left} x2={width - right} y1={yAt(guide.price)} y2={yAt(guide.price)} />
              <text x={width - right + 8} y={yAt(guide.price) + 4}>{guide.label}</text>
            </g>
          ))}
          {points && <polyline className="price" points={points} />}
          <circle className="entryPoint" cx={xAt(live.openedAt)} cy={yAt(entry)} r="5" />
          <circle className="currentPoint" cx={xAt(endMs)} cy={yAt(current)} r="5" />
        </svg>
        <div className="v2ChartTimes"><span>{exactIsraelTime(live.openedAt)}</span><span>Now</span></div>
      </div>

      <div className="v2RuleGrid">
        <div><small>Bought at</small><strong>{formatPrice(entry)}</strong><span>Entry marker on chart</span></div>
        <div><small>Peak</small><strong>{formatPrice(peak)}</strong><span>{Number(live.peakReturnPct ?? ((peak / entry - 1) * 100)).toFixed(2)}% gross</span></div>
        <div className="take"><small>Take profit</small><strong>{formatPrice(takeProfit)}</strong><span>+10.0% gross · +8.8% net</span></div>
        <div className="stop"><small>Hard stop</small><strong>{formatPrice(hardStop)}</strong><span>−6.0% gross · −7.2% net</span></div>
        <div className="arm"><small>Trailing arm</small><strong>{formatPrice(trailArm)}</strong><span>Arms after +6.0% gross</span></div>
        <div className="trail"><small>Trailing floor</small><strong>{trailFloor ? formatPrice(trailFloor) : "Not armed"}</strong><span>{trailFloor ? "4% below the highest price" : "Appears after trail is armed"}</span></div>
        <div><small>Maximum hold</small><strong>{remainingText}</strong><span>Automatic exit by {exactIsraelTime(live.rules?.maxHoldAt)}</span></div>
        <div><small>Friction included</small><strong>1.2%</strong><span>0.6% entry + 0.6% exit</span></div>
      </div>
      <p className="v2ExitNote">The bot sells when the first rule is hit: hard stop, take profit, armed trailing stop, maximum hold, or your manual paper sell.</p>
    </section>
  );
}

function OpenPositions({ bot, now }: { bot: Bot; now: number }) {`,
    marker: "function LiveAiPosition",
  },
  {
    from: '      <OpenPositions bot={bot} now={now} />\n      <section className="v2Panel"><Title title="Equity curve"',
    to: '      <OpenPositions bot={bot} now={now} />\n      <LiveAiPosition bot={bot} now={now} />\n      <section className="v2Panel"><Title title="Equity curve"',
    marker: "<LiveAiPosition bot={bot} now={now} />",
  },
]);

const cssPath = "app/platform-v2.css";
const css = fs.readFileSync(cssPath, "utf8");
if (!css.includes(".v2LivePosition{")) {
  fs.appendFileSync(cssPath, `
.v2LivePosition{padding:18px;overflow:hidden}.v2LivePositionHead{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.v2LivePositionHead .v2Title h2{font-size:18px}.v2MarketLinks{display:flex;gap:8px;flex-wrap:wrap}.v2MarketLinks a{border:1px solid var(--line);border-radius:9px;padding:8px 10px;background:#0d141c;color:#dce8f6;text-decoration:none;font-size:10px;font-weight:700}.v2MarketLinks a:last-child{color:#9fe7bf;border-color:rgba(69,212,131,.28);background:rgba(69,212,131,.07)}.v2LivePriceRow{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;margin-top:16px}.v2LivePriceRow>div,.v2RuleGrid>div{border:1px solid var(--line);border-radius:11px;background:#0d141c;padding:11px}.v2LivePriceRow small,.v2RuleGrid small{display:block;color:var(--muted);font-size:8px;text-transform:uppercase;letter-spacing:.04em}.v2LivePriceRow strong{display:block;margin-top:6px;font-size:15px}.v2PriceChartWrap{margin-top:14px;border:1px solid var(--line);border-radius:13px;background:#0a1016;padding:10px 10px 6px}.v2PriceChart{display:block;width:100%;height:280px}.v2PriceChart .grid{stroke:#202b37;stroke-width:1;vector-effect:non-scaling-stroke}.v2PriceChart .price{fill:none;stroke:var(--blue);stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke}.v2PriceChart .guide line{stroke-width:1.3;stroke-dasharray:6 5;vector-effect:non-scaling-stroke}.v2PriceChart .guide text{font-size:10px;fill:var(--muted)}.v2PriceChart .guide.entry line{stroke:#dce8f6}.v2PriceChart .guide.entry text{fill:#dce8f6}.v2PriceChart .guide.take line{stroke:var(--green)}.v2PriceChart .guide.take text{fill:var(--green)}.v2PriceChart .guide.stop line{stroke:var(--red)}.v2PriceChart .guide.stop text{fill:var(--red)}.v2PriceChart .guide.arm line{stroke:var(--amber)}.v2PriceChart .guide.arm text{fill:var(--amber)}.v2PriceChart .guide.trail line{stroke:var(--purple)}.v2PriceChart .guide.trail text{fill:var(--purple)}.v2PriceChart .entryPoint{fill:#fff;stroke:#0a1016;stroke-width:2}.v2PriceChart .currentPoint{fill:var(--blue);stroke:#0a1016;stroke-width:2}.v2ChartTimes{display:flex;justify-content:space-between;color:var(--muted);font-size:8px;padding:0 4px}.v2RuleGrid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;margin-top:12px}.v2RuleGrid strong{display:block;margin-top:6px;font-size:12px}.v2RuleGrid span{display:block;margin-top:4px;color:var(--muted);font-size:8px;line-height:1.35}.v2RuleGrid .take{border-color:rgba(69,212,131,.24)}.v2RuleGrid .stop{border-color:rgba(255,111,127,.24)}.v2RuleGrid .arm{border-color:rgba(240,180,77,.24)}.v2RuleGrid .trail{border-color:rgba(156,125,255,.24)}.v2ExitNote{margin:12px 2px 0;color:var(--muted);font-size:9px;line-height:1.45}@media(max-width:760px){.v2LivePosition{padding:14px}.v2LivePositionHead{display:grid}.v2MarketLinks a{flex:1;text-align:center}.v2LivePriceRow{grid-template-columns:1fr 1fr}.v2PriceChart{height:220px}.v2RuleGrid{grid-template-columns:1fr 1fr}.v2PriceChart .guide text{font-size:9px}}
`);
}

console.log("[patch-ai-live-position] applied");
