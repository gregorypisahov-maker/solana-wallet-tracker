import Link from "next/link";
import type { Metadata } from "next";
import { getSupabaseAdmin } from "../../lib/supabase";
import "./storefront.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Solana Intelligence | On-chain strategy research platform",
  description:
    "A multi-strategy Solana intelligence platform for wallet monitoring, manipulation resistance, copier-quality analysis and transparent paper validation.",
};

type TradeRow = {
  id: number | string;
  position_id: string | null;
  pnl_sol: number | string | null;
  happened_at: string | null;
};

type StrategyStats = {
  id: "legion" | "shadow" | "tiered";
  name: string;
  pnl: number;
  positions: number;
  winRate: number;
  profitFactor: number | null;
};

type FeedItem = {
  time: string;
  bot: string;
  token: string;
  detail: string;
  state: "entered" | "rejected" | "closed";
};

type ShowcaseData = {
  activeWallets: number | null;
  decisionsLogged: number | null;
  totalPositions: number;
  totalPnl: number;
  strongest: StrategyStats | null;
  strategies: StrategyStats[];
  feed: FeedItem[];
  readiness: {
    ready: boolean;
    progress: number;
    completedTrades: number;
    activeDays: number;
    profitFactor: number;
    largestWinnerShare: number;
  };
  generatedAt: string;
};

const strategyInfo = {
  legion: {
    title: "Legion",
    subtitle: "Consensus intelligence",
    icon: "L",
    description:
      "Waits for qualified wallets to converge, then evaluates score, trust, liquidity, market capitalization and execution risk.",
    protections: ["Multi-wallet confirmation", "Liquidity and market-cap discipline", "Friction-aware paper execution"],
  },
  shadow: {
    title: "Shadow",
    subtitle: "Manipulation-resistant copy intelligence",
    icon: "◆",
    description:
      "Measures whether copying each wallet has actually worked for us, reduces size when evidence is weak, and rejects coordinated launch activity.",
    protections: ["Copier-level statistical quality", "Confidence-weighted sizing", "Same-block bundle detection"],
  },
  tiered: {
    title: "Tiered",
    subtitle: "Confirmed first-buy tracking",
    icon: "↗",
    description:
      "Follows the earliest qualifying buy from proven wallets, then demands a second price and liquidity read before entering.",
    protections: ["Wallet trust 65+", "Eight-second market confirmation", "Atomic position accounting"],
  },
} as const;

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function aggregateStrategy(id: StrategyStats["id"], name: string, rows: TradeRow[]): StrategyStats {
  const grouped = new Map<string, number>();
  for (const row of rows) {
    const key = row.position_id || `legacy-${row.id}`;
    grouped.set(key, (grouped.get(key) ?? 0) + numberValue(row.pnl_sol));
  }
  const pnls = [...grouped.values()];
  const wins = pnls.filter((value) => value > 0).length;
  const losses = pnls.filter((value) => value < 0).length;
  const grossProfit = pnls.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(pnls.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  return {
    id,
    name,
    pnl: pnls.reduce((sum, value) => sum + value, 0),
    positions: pnls.length,
    winRate: wins + losses > 0 ? wins / (wins + losses) : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : null,
  };
}

function displayReason(reason: string): string {
  const clean = String(reason).split(":")[0];
  const labels: Record<string, string> = {
    trust_below_55: "Trust below 55",
    two_wallet_elite_gate_failed: "Elite two-wallet gate failed",
    wallet_count_below_3: "Insufficient wallet consensus",
    score_above_65: "Late-entry guard",
    score_below_10: "Signal score too low",
    mcap_above_200k: "Market cap above $200K",
    mcap_below_20k: "Market cap below $20K",
    liquidity_below_15k: "Liquidity below $15K",
    liq_ratio_below_15pct: "Liquidity ratio below 15%",
    copier_t_stat_negative: "Negative copier expectancy",
    copier_recent_decay_margin_exceeded: "Wallet edge is decaying",
    copier_recent_10_negative_while_lifetime_positive: "Recent copier results turned negative",
    same_block_bundle_detected: "Coordinated launch bundle detected",
    coin_quality_unresolved: "Launch quality could not be verified",
    copier_wallet_quality_unresolved: "Copier evidence could not be verified",
  };
  return labels[clean] ?? clean.replaceAll("_", " ");
}

function israelTime(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "LIVE";
  return new Intl.DateTimeFormat("en-IL", {
    timeZone: "Asia/Jerusalem",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function shortMint(value: string | null | undefined): string {
  if (!value) return "SIGNAL";
  return `${value.slice(0, 4)}…${value.slice(-3)}`;
}

async function loadShowcaseData(): Promise<ShowcaseData> {
  const generatedAt = new Date().toISOString();
  try {
    const supabase = getSupabaseAdmin({ noStore: true });
    const [paperResult, shadowResult, tieredResult, walletCountResult, decisionCountResult, decisionResult, readinessResult] =
      await Promise.all([
        supabase.from("paper_trades").select("id,position_id,pnl_sol,happened_at").limit(3000),
        supabase.from("shadow_trades").select("id,position_id,pnl_sol,happened_at").limit(3000),
        supabase.from("tiered_trades").select("id,position_id,pnl_sol,happened_at").limit(3000),
        supabase.from("wallets").select("address", { count: "exact", head: true }).eq("active", true),
        supabase.from("shadow_processed_alerts").select("alert_id", { count: "exact", head: true }),
        supabase
          .from("shadow_processed_alerts")
          .select("alert_id,processed_at,entered,skip_reasons,filter_snapshot")
          .order("processed_at", { ascending: false })
          .limit(7),
        supabase.from("live_readiness").select("*").eq("id", 1).maybeSingle(),
      ]);

    const strategies = [
      aggregateStrategy("legion", "Legion", (paperResult.data ?? []) as TradeRow[]),
      aggregateStrategy("shadow", "Shadow", (shadowResult.data ?? []) as TradeRow[]),
      aggregateStrategy("tiered", "Tiered", (tieredResult.data ?? []) as TradeRow[]),
    ];

    const latestDecisions = (decisionResult.data ?? []) as any[];
    const alertIds = latestDecisions.map((row) => row.alert_id).filter(Boolean);
    const alertsById = new Map<string, { mint: string }>();
    const symbolsByMint = new Map<string, string>();

    if (alertIds.length > 0) {
      const alertsResult = await supabase.from("alerts_sent").select("id,token_mint").in("id", alertIds);
      for (const row of alertsResult.data ?? []) {
        alertsById.set(String(row.id), { mint: String(row.token_mint ?? "") });
      }
      const mints = [...new Set([...alertsById.values()].map((row) => row.mint).filter(Boolean))];
      if (mints.length > 0) {
        const scoreResult = await supabase
          .from("token_scores")
          .select("token_mint,token_symbol")
          .in("token_mint", mints);
        for (const row of scoreResult.data ?? []) {
          symbolsByMint.set(String(row.token_mint), String(row.token_symbol ?? ""));
        }
      }
    }

    const feed: FeedItem[] = latestDecisions.map((row) => {
      const alert = alertsById.get(String(row.alert_id));
      const mint = alert?.mint ?? "";
      const snapshot = (row.filter_snapshot ?? {}) as Record<string, any>;
      const reasons = Array.isArray(row.skip_reasons)
        ? row.skip_reasons
        : Array.isArray(snapshot.final_reasons)
          ? snapshot.final_reasons
          : [];
      const multiplier = numberValue(snapshot.signal_multiplier);
      return {
        time: israelTime(row.processed_at),
        bot: "SHADOW",
        token: symbolsByMint.get(mint) || shortMint(mint),
        detail: row.entered
          ? `Bundle screen passed · copier size ${multiplier > 0 ? `${multiplier.toFixed(2)}×` : "validated"}`
          : reasons.slice(0, 2).map(displayReason).join(" · ") || "Candidate rejected by risk controls",
        state: row.entered ? "entered" : "rejected",
      };
    });

    const readiness = readinessResult.data ?? {};
    const completedTrades = numberValue(readiness.completed_trades);
    const activeDays = numberValue(readiness.active_days);
    const readinessPf = numberValue(readiness.profit_factor);
    const largestWinnerShare = numberValue(readiness.largest_winner_share);
    const progressParts = [
      Math.min(1, completedTrades / 100),
      Math.min(1, activeDays / 45),
      Math.min(1, readinessPf / 1.4),
      largestWinnerShare > 0 ? Math.min(1, 0.25 / largestWinnerShare) : 0,
    ];

    const strongest = [...strategies].sort((a, b) => (b.profitFactor ?? 0) - (a.profitFactor ?? 0))[0] ?? null;
    return {
      activeWallets: walletCountResult.count ?? null,
      decisionsLogged: decisionCountResult.count ?? null,
      totalPositions: strategies.reduce((sum, strategy) => sum + strategy.positions, 0),
      totalPnl: strategies.reduce((sum, strategy) => sum + strategy.pnl, 0),
      strongest,
      strategies,
      feed,
      readiness: {
        ready: Boolean(readiness.ready),
        progress: Math.round((progressParts.reduce((sum, value) => sum + value, 0) / progressParts.length) * 100),
        completedTrades,
        activeDays,
        profitFactor: readinessPf,
        largestWinnerShare,
      },
      generatedAt,
    };
  } catch (error) {
    console.error("[storefront] live proof load failed:", error);
    return {
      activeWallets: null,
      decisionsLogged: null,
      totalPositions: 0,
      totalPnl: 0,
      strongest: null,
      strategies: [
        { id: "legion", name: "Legion", pnl: 0, positions: 0, winRate: 0, profitFactor: null },
        { id: "shadow", name: "Shadow", pnl: 0, positions: 0, winRate: 0, profitFactor: null },
        { id: "tiered", name: "Tiered", pnl: 0, positions: 0, winRate: 0, profitFactor: null },
      ],
      feed: [],
      readiness: { ready: false, progress: 0, completedTrades: 0, activeDays: 0, profitFactor: 0, largestWinnerShare: 0 },
      generatedAt,
    };
  }
}

const sol = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(3)} SOL`;
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const pf = (value: number | null) => (value == null ? "—" : value >= 99 ? "∞" : value.toFixed(2));

export default async function StorefrontPage() {
  const data = await loadShowcaseData();
  const proof = [
    { value: "3", label: "Active strategy engines" },
    { value: data.activeWallets == null ? "LIVE" : String(data.activeWallets), label: "Monitored wallet signals" },
    { value: data.totalPositions > 0 ? `${data.totalPositions}+` : "300+", label: "Paper positions analyzed" },
    { value: data.decisionsLogged == null ? "24/7" : `${data.decisionsLogged}+`, label: "Shadow decisions logged" },
    { value: "24/7", label: "Automated monitoring" },
  ];
  const readinessChecks = [
    {
      label: "Forward trades",
      value: `${Math.round(data.readiness.completedTrades)} / 100`,
      passed: data.readiness.completedTrades >= 100,
    },
    {
      label: "Forward-test duration",
      value: `${data.readiness.activeDays.toFixed(1)} / 45 days`,
      passed: data.readiness.activeDays >= 45,
    },
    {
      label: "Profit factor target",
      value: `${data.readiness.profitFactor.toFixed(2)} / 1.40`,
      passed: data.readiness.profitFactor >= 1.4,
    },
    {
      label: "Winner concentration",
      value: data.readiness.largestWinnerShare > 0 ? `${pct(data.readiness.largestWinnerShare)} / ≤25%` : "Collecting data",
      passed: data.readiness.largestWinnerShare > 0 && data.readiness.largestWinnerShare <= 0.25,
    },
  ];

  return (
    <main className="sfPage">
      <div className="sfNoise" />
      <nav className="sfNav">
        <div className="sfShell sfNavInner">
          <Link className="sfBrand" href="/">
            <span className="sfBrandMark">S</span>
            <span className="sfBrandText">
              <strong>Solana Intelligence</strong>
              <span>On-chain strategy research</span>
            </span>
          </Link>
          <div className="sfNavLinks">
            <a href="#intelligence">Intelligence</a>
            <a href="#strategies">Strategies</a>
            <a href="#architecture">Architecture</a>
            <a href="#validation">Validation</a>
            <Link className="sfButton sfButtonGhost" href="/platform">
              Open platform <span>↗</span>
            </Link>
          </div>
        </div>
      </nav>

      <section className="sfShell sfHero">
        <div className="sfGrid" />
        <div>
          <span className="sfEyebrow"><i /> Live paper-research network</span>
          <h1>On-chain intelligence, <em>engineered to prove itself.</em></h1>
          <p className="sfHeroLead">
            Monitor proven Solana wallets, detect coordinated launches, measure the real copier edge and validate independent strategies before capital is exposed.
          </p>
          <div className="sfHeroActions">
            <Link className="sfButton sfButtonPrimary" href="/platform">Enter live platform <span>↗</span></Link>
            <a className="sfButton sfButtonGhost" href="#intelligence">Explore the intelligence</a>
          </div>
          <div className="sfTrustLine">
            <span>Paper trading research</span>
            <span>Transparent performance</span>
            <span>No guaranteed returns</span>
          </div>
        </div>

        <div className="sfHeroVisual" aria-label="Animated intelligence architecture">
          <div className="sfOrb" />
          <div className="sfEngine">
            <div className="sfEngineTop">
              <div className="sfWindowDots"><i /><i /><i /></div>
              <span>SIGNAL NETWORK / LIVE</span>
            </div>
            <div className="sfSignalMap">
              <div className="sfCorePulse" />
              <div className="sfBeam sfBeam1" />
              <div className="sfBeam sfBeam2" />
              <div className="sfBeam sfBeam3" />
              <div className="sfBeam sfBeam4" />
              <article className="sfNode sfNodeA"><small>Data source</small><strong>Tracked wallets</strong><span>Helius activity and reconciliation</span></article>
              <article className="sfNode sfNodeB"><small>Market layer</small><strong>Token intelligence</strong><span>Liquidity, price and market structure</span></article>
              <article className="sfNode sfNodeC"><small>Decision core</small><strong>Signal engine</strong><span>Trust · consensus · copier quality · manipulation</span></article>
              <article className="sfNode sfNodeD"><small>Execution</small><strong>Strategy modules</strong><span>Legion · Shadow · Tiered</span></article>
              <article className="sfNode sfNodeE"><small>Delivery</small><strong>Live control room</strong><span>Dashboard · Telegram · analytics</span></article>
            </div>
          </div>
        </div>
      </section>

      <section className="sfProof">
        <div className="sfShell sfProofGrid">
          {proof.map((item) => <div className="sfProofItem" key={item.label}><strong>{item.value}</strong><span>{item.label}</span></div>)}
        </div>
      </section>

      <section className="sfSection" id="intelligence">
        <div className="sfShell">
          <div className="sfSectionHead">
            <div><small>Intelligence pipeline</small><h2>Every signal earns the right to become a trade.</h2></div>
            <p>The platform does more than watch wallets. It reconstructs context, tests execution quality, rejects weak or manipulated opportunities and records every decision for later analysis.</p>
          </div>
          <div className="sfPipeline">
            {[
              ["01", "Detect", "Capture buys and sells from tracked and newly evaluated Solana wallets."],
              ["02", "Understand", "Build wallet participation, consensus, trust and token-market context."],
              ["03", "Filter", "Apply liquidity, market-cap, late-entry, copier-quality and bundle screens."],
              ["04", "Execute", "Let isolated strategies test the same opportunity through different hypotheses."],
              ["05", "Protect", "Enforce position limits, stops, targets, maximum holds and fail-closed data."],
              ["06", "Learn", "Store entries, exits and rejection reasons for forward testing and backtesting."],
            ].map(([number, title, description]) => <article key={number}><b>{number}</b><h3>{title}</h3><p>{description}</p></article>)}
          </div>
        </div>
      </section>

      <section className="sfSection sfSectionTight" id="strategies">
        <div className="sfShell">
          <div className="sfSectionHead">
            <div><small>Strategy showroom</small><h2>Three engines. Three different views of the same market.</h2></div>
            <p>Each module owns a separate paper bankroll, logs its own performance and can be judged without contaminating the other experiments.</p>
          </div>
          <div className="sfStrategies">
            {data.strategies.map((strategy) => {
              const info = strategyInfo[strategy.id];
              return (
                <article className={`sfStrategy ${strategy.id}`} key={strategy.id}>
                  <div className="sfStrategyTop"><span className="sfStrategyIcon">{info.icon}</span><span className="sfStatus">Active paper</span></div>
                  <h3>{info.title}</h3>
                  <p><strong style={{ color: "white" }}>{info.subtitle}.</strong> {info.description}</p>
                  <div className="sfStrategyStats">
                    <div><small>Paper PnL</small><strong>{sol(strategy.pnl)}</strong></div>
                    <div><small>Profit factor</small><strong>{pf(strategy.profitFactor)}</strong></div>
                    <div><small>Positions</small><strong>{strategy.positions}</strong></div>
                  </div>
                  <ul>{info.protections.map((protection) => <li key={protection}>{protection}</li>)}</ul>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section className="sfSection">
        <div className="sfShell">
          <div className="sfSectionHead">
            <div><small>Live decision intelligence</small><h2>See what the system refuses to trade.</h2></div>
            <p>A normal trade list shows only outcomes. Our decision trail also shows the opportunities rejected by trust, liquidity, timing, copier quality and manipulation controls.</p>
          </div>
          <div className="sfTerminalGrid">
            <div className="sfTerminal">
              <div className="sfTerminalHead"><strong>Decision stream</strong><span>Sanitized public view</span></div>
              <div className="sfFeed">
                {data.feed.length > 0 ? data.feed.map((item, index) => (
                  <div className="sfFeedRow" key={`${item.time}-${item.token}-${index}`}>
                    <span className="sfFeedTime">{item.time}</span>
                    <span className="sfFeedBot">{item.bot}</span>
                    <span className="sfFeedMain"><strong>{item.token}</strong><span>{item.detail}</span></span>
                    <span className={`sfDecision ${item.state}`}>{item.state.toUpperCase()}</span>
                  </div>
                )) : <div className="sfEmpty">Live decisions are synchronizing. The private platform remains available.</div>}
              </div>
            </div>
            <aside className="sfTerminalSide">
              <div className="sfInsightCard">
                <small>Strongest measured module</small>
                <h3>{data.strongest?.name ?? "Collecting data"}</h3>
                <p>Ranked by paper profit factor, not by win rate alone. A high hit rate can still lose money when average losses exceed average wins.</p>
                <div className="sfInsightMetric"><strong>{pf(data.strongest?.profitFactor ?? null)}</strong><span>Current paper profit factor</span></div>
              </div>
              <div className="sfInsightCard">
                <small>Combined research record</small>
                <h3>{data.totalPositions || "300+"} analyzed positions</h3>
                <p>Independent ledgers make it possible to compare hypotheses rather than blend all activity into one flattering number.</p>
                <div className="sfInsightMetric"><strong>{data.totalPositions ? sol(data.totalPnl) : "LIVE"}</strong><span>Model-dependent paper PnL</span></div>
              </div>
            </aside>
          </div>
        </div>
      </section>

      <section className="sfSection sfSectionTight">
        <div className="sfShell">
          <div className="sfSectionHead">
            <div><small>Why it is different</small><h2>Not a blind copy bot. A measurable intelligence system.</h2></div>
            <p>The real product is the decision infrastructure: evidence, isolation, manipulation resistance, risk controls and transparent validation.</p>
          </div>
          <div className="sfCompare">
            <div className="sfCompareCol"><small>Basic copy bot</small><h3>Copies activity</h3><div className="sfCompareRows"><div>Copies one wallet blindly</div><div>Enters without market context</div><div>Hides rejected opportunities</div><div>Assumes wallet profit transfers</div><div>Combines every result</div><div>Declares success too early</div></div></div>
            <div className="sfCompareCol"><small>Solana Intelligence</small><h3>Tests the edge</h3><div className="sfCompareRows"><div>Measures wallet and copier quality</div><div>Checks liquidity, timing and manipulation</div><div>Logs every acceptance and rejection</div><div>Quantifies the imitation penalty</div><div>Isolates strategy bankrolls</div><div>Requires forward-validation gates</div></div></div>
          </div>
        </div>
      </section>

      <section className="sfSection" id="architecture">
        <div className="sfShell">
          <div className="sfSectionHead">
            <div><small>Platform architecture</small><h2>A complete operating stack, not a single script.</h2></div>
            <p>Data ingestion, strategy execution, storage, deployment, reporting and alerts operate as one connected research environment.</p>
          </div>
          <div className="sfArchitecture">
            <article className="sfLayer"><small>Data layer</small><h3>Observe the chain</h3><div className="sfLayerStack"><span>Helius wallet activity</span><span>Solana RPC</span><span>DexScreener</span><span>GeckoTerminal fallback</span></div></article>
            <article className="sfLayer"><small>Intelligence layer</small><h3>Evaluate the signal</h3><div className="sfLayerStack"><span>Wallet profiler</span><span>Consensus engine</span><span>Copier-quality model</span><span>Bundle detection</span></div></article>
            <article className="sfLayer"><small>Infrastructure layer</small><h3>Run continuously</h3><div className="sfLayerStack"><span>Railway services</span><span>Supabase ledgers</span><span>GitHub source control</span><span>Vercel interface</span></div></article>
            <article className="sfLayer"><small>Delivery layer</small><h3>Make it visible</h3><div className="sfLayerStack"><span>Live private terminal</span><span>Telegram alerts</span><span>Decision logs</span><span>Performance analytics</span></div></article>
          </div>
        </div>
      </section>

      <section className="sfSection sfSectionTight" id="validation">
        <div className="sfShell">
          <div className="sfSectionHead">
            <div><small>Evidence before capital</small><h2>Built to prove itself before real money is used.</h2></div>
            <p>The platform does not call one profitable day a success. It requires enough forward trades, enough time, acceptable profit factor and diversified results.</p>
          </div>
          <div className="sfReadiness">
            <article className="sfReadinessLead"><small>Live-money readiness</small><h3>{data.readiness.ready ? "Validated" : "Research in progress"}</h3><p>Transparent blockers remain visible. That discipline is a product feature, not a weakness.</p><div className="sfReadinessScore"><strong>{data.readiness.progress}%</strong><span>Evidence progress across four validation gates</span></div></article>
            <article className="sfReadinessChecks">{readinessChecks.map((check) => <div className={`sfCheck ${check.passed ? "pass" : ""}`} key={check.label}><div><b>{check.label}</b><span>{check.value}</span></div><em>{check.passed ? "Passed" : "Collecting"}</em></div>)}</article>
          </div>
        </div>
      </section>

      <section className="sfSection">
        <div className="sfShell">
          <div className="sfSectionHead">
            <div><small>Built for more than one operator</small><h2>Intelligence infrastructure that can become a product.</h2></div>
            <p>The platform can evolve into private research tooling, community intelligence, a managed strategy workspace or a white-label monitoring product.</p>
          </div>
          <div className="sfUseCases">
            <article className="sfUseCase"><b>01</b><h3>Private traders</h3><p>Monitor qualified wallets and test strategy hypotheses before risking capital.</p></article>
            <article className="sfUseCase"><b>02</b><h3>Research teams</h3><p>Compare wallet cohorts, filters, execution models and market regimes.</p></article>
            <article className="sfUseCase"><b>03</b><h3>Trading communities</h3><p>Deliver structured alerts with transparent paper performance and decision context.</p></article>
            <article className="sfUseCase"><b>04</b><h3>White-label operators</h3><p>Build branded client experiences on top of the same monitoring infrastructure.</p></article>
          </div>
        </div>
      </section>

      <section className="sfShell sfCta">
        <small>Private control room</small>
        <h2>See what the system sees.</h2>
        <p>Enter the protected platform to explore live strategy status, paper trades, analytics and the operational control room.</p>
        <div className="sfHeroActions"><Link className="sfButton sfButtonPrimary" href="/platform">Open live platform <span>↗</span></Link><a className="sfButton sfButtonGhost" href="#architecture">Review architecture</a></div>
      </section>

      <footer className="sfFooter">
        <div className="sfShell sfFooterInner">
          <span>Solana Intelligence · Paper-trading research platform · Updated {israelTime(data.generatedAt)} Israel time</span>
          <div className="sfFooterLinks"><a href="#strategies">Strategies</a><a href="#validation">Validation</a><Link href="/platform">Private platform</Link></div>
        </div>
      </footer>
    </main>
  );
}
