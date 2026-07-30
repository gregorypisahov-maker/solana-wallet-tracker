import fs from "node:fs";

function replaceRequired(path, before, after, label) {
  let source = fs.readFileSync(path, "utf8");
  if (!source.includes(before)) throw new Error(`${path}: missing ${label}`);
  source = source.replace(before, after);
  fs.writeFileSync(path, source);
}

function replaceRegexRequired(path, pattern, after, label) {
  let source = fs.readFileSync(path, "utf8");
  if (!pattern.test(source)) throw new Error(`${path}: missing ${label}`);
  source = source.replace(pattern, after);
  fs.writeFileSync(path, source);
}

replaceRegexRequired(
  "paper-trader/marketDiscoveryAgent.ts",
  /type Candidate = \{[\s\S]*?\n\};\n\ntype Ranked = \{[\s\S]*?\n\};\n\ntype DiscoveryMeta/,
  `type Candidate = {
  mint: string;
  symbol: string;
  pairAddress: string;
  priceUsd: number;
  liquidityUsd: number;
  marketCapUsd: number;
  fdvUsd: number | null;
  changeM5: number;
  changeH1: number;
  changeH24: number | null;
  volumeM5: number;
  volumeH1: number;
  volumeH24: number | null;
  buysM5: number;
  sellsM5: number;
  buyersM5: number;
  uniqueMakersM5: number | null;
  holderCount: number | null;
  poolAgeMinutes: number;
  poolCreatedAt: string | null;
  dexId: string | null;
};

type Ranked = Candidate & {
  score: number;
  rawScore: number;
  subScores: Record<string, number>;
  confidence: "low" | "medium" | "high";
  status: "watching" | "armed";
  reasons: string[];
  risks: string[];
};

type DiscoveryMeta`,
  "candidate and ranked types"
);

replaceRegexRequired(
  "paper-trader/marketDiscoveryAgent.ts",
  /  const candidate: Candidate = \{[\s\S]*?\n  \};\n\n  const values/,
  `  const candidate: Candidate = {
    mint,
    symbol:
      String(attributes.name ?? "UNKNOWN").split("/")[0]?.trim() || "UNKNOWN",
    pairAddress: String(attributes.address ?? ""),
    priceUsd: num(attributes.base_token_price_usd, Number.NaN),
    liquidityUsd: num(attributes.reserve_in_usd, Number.NaN),
    marketCapUsd: num(
      attributes.market_cap_usd ?? attributes.fdv_usd,
      Number.NaN
    ),
    fdvUsd: Number.isFinite(Number(attributes.fdv_usd)) ? Number(attributes.fdv_usd) : null,
    changeM5: num(attributes.price_change_percentage?.m5, Number.NaN),
    changeH1: num(attributes.price_change_percentage?.h1, Number.NaN),
    changeH24: Number.isFinite(Number(attributes.price_change_percentage?.h24))
      ? Number(attributes.price_change_percentage.h24)
      : null,
    volumeM5: num(attributes.volume_usd?.m5, Number.NaN),
    volumeH1: num(attributes.volume_usd?.h1, Number.NaN),
    volumeH24: Number.isFinite(Number(attributes.volume_usd?.h24))
      ? Number(attributes.volume_usd.h24)
      : null,
    buysM5: Math.max(
      0,
      Math.floor(num(attributes.transactions?.m5?.buys, Number.NaN))
    ),
    sellsM5: Math.max(
      0,
      Math.floor(num(attributes.transactions?.m5?.sells, Number.NaN))
    ),
    buyersM5: Math.max(
      0,
      Math.floor(num(attributes.transactions?.m5?.buyers, Number.NaN))
    ),
    uniqueMakersM5: Number.isFinite(Number(
      attributes.transactions?.m5?.makers ?? attributes.transactions?.m5?.unique_makers
    ))
      ? Math.max(0, Math.floor(Number(
          attributes.transactions?.m5?.makers ?? attributes.transactions?.m5?.unique_makers
        )))
      : null,
    holderCount: Number.isFinite(Number(attributes.holder_count ?? attributes.holders?.count))
      ? Math.max(0, Math.floor(Number(attributes.holder_count ?? attributes.holders?.count)))
      : null,
    poolAgeMinutes: Number.isFinite(createdAt)
      ? Math.max(0, Date.now() - createdAt) / 60_000
      : Number.NaN,
    poolCreatedAt: Number.isFinite(createdAt) ? new Date(createdAt).toISOString() : null,
    dexId: stripId(row?.relationships?.dex?.data?.id) || null,
  };

  const values`,
  "candidate parse block"
);

replaceRegexRequired(
  "paper-trader/marketDiscoveryAgent.ts",
  /function rank\(candidate: Candidate\): Ranked \{[\s\S]*?\n\}\n\nfunction regime/,
  `function rank(candidate: Candidate): Ranked {
  let score = 0;
  const reasons: string[] = [];
  const risks: string[] = [];
  const buyRatio =
    candidate.buysM5 / Math.max(1, candidate.buysM5 + candidate.sellsM5);
  const turnover =
    candidate.volumeM5 / Math.max(1, candidate.liquidityUsd);
  const liquidityToCap =
    candidate.liquidityUsd / Math.max(1, candidate.marketCapUsd);

  if (candidate.liquidityUsd >= 150_000) {
    score += 22;
    reasons.push("deep_liquidity");
  } else if (candidate.liquidityUsd >= 60_000) {
    score += 17;
    reasons.push("healthy_liquidity");
  } else if (candidate.liquidityUsd >= 25_000) {
    score += 10;
    reasons.push("acceptable_liquidity");
  } else {
    risks.push("thin_liquidity");
  }

  if (candidate.volumeM5 >= 75_000) {
    score += 18;
    reasons.push("strong_volume_acceleration");
  } else if (candidate.volumeM5 >= 25_000) {
    score += 12;
    reasons.push("rising_short_term_volume");
  } else if (candidate.volumeM5 >= 8_000) {
    score += 6;
  }

  if (buyRatio >= 0.68 && candidate.buysM5 >= 20) {
    score += 16;
    reasons.push("strong_buy_pressure");
  } else if (buyRatio >= 0.58 && candidate.buysM5 >= 10) {
    score += 10;
    reasons.push("positive_buy_pressure");
  } else if (buyRatio < 0.45) {
    risks.push("sell_pressure");
  }

  if (candidate.buyersM5 >= 35) {
    score += 14;
    reasons.push("broad_buyer_growth");
  } else if (candidate.buyersM5 >= 15) {
    score += 8;
    reasons.push("buyer_count_rising");
  }

  if (candidate.changeM5 >= 2 && candidate.changeM5 <= 12) {
    score += 12;
    reasons.push("healthy_momentum");
  } else if (candidate.changeM5 > 12 && candidate.changeM5 <= 25) {
    score += 5;
    risks.push("extended_momentum");
  } else if (candidate.changeM5 > 25) {
    score -= 12;
    risks.push("vertical_price_spike");
  } else if (candidate.changeM5 < -4) {
    risks.push("negative_momentum");
  }

  if (candidate.changeH1 >= 5 && candidate.changeH1 <= 60) {
    score += 8;
    reasons.push("one_hour_confirmation");
  } else if (candidate.changeH1 > 100) {
    score -= 8;
    risks.push("late_entry_risk");
  }

  if (liquidityToCap >= 0.15) {
    score += 6;
    reasons.push("strong_liquidity_to_cap");
  } else if (liquidityToCap < 0.05) {
    risks.push("weak_liquidity_to_cap");
  }

  if (turnover >= 0.15 && turnover <= 2.5) {
    score += 4;
  } else if (turnover > 4) {
    risks.push("possible_churn_or_fake_volume");
  }

  if (
    candidate.poolAgeMinutes >= 20 &&
    candidate.poolAgeMinutes <= 720
  ) {
    score += 6;
    reasons.push("useful_pool_age");
  } else if (candidate.poolAgeMinutes < 5) {
    score -= 10;
    risks.push("extremely_new_pool");
  }

  if (candidate.marketCapUsd < 20_000) risks.push("micro_market_cap");
  if (candidate.marketCapUsd > 5_000_000) {
    risks.push("outside_primary_discovery_range");
  }

  const subScores = {
    liquidity: candidate.liquidityUsd >= 150_000 ? 22 : candidate.liquidityUsd >= 60_000 ? 17 : candidate.liquidityUsd >= 25_000 ? 10 : 0,
    volume: candidate.volumeM5 >= 75_000 ? 18 : candidate.volumeM5 >= 25_000 ? 12 : candidate.volumeM5 >= 8_000 ? 6 : 0,
    buyPressure: buyRatio >= 0.68 && candidate.buysM5 >= 20 ? 16 : buyRatio >= 0.58 && candidate.buysM5 >= 10 ? 10 : 0,
    buyerBreadth: candidate.buyersM5 >= 35 ? 14 : candidate.buyersM5 >= 15 ? 8 : 0,
    momentum5m: candidate.changeM5 >= 2 && candidate.changeM5 <= 12 ? 12 : candidate.changeM5 > 12 && candidate.changeM5 <= 25 ? 5 : candidate.changeM5 > 25 ? -12 : 0,
    momentum1h: candidate.changeH1 >= 5 && candidate.changeH1 <= 60 ? 8 : candidate.changeH1 > 100 ? -8 : 0,
    liquidityToCap: liquidityToCap >= 0.15 ? 6 : 0,
    turnover: turnover >= 0.15 && turnover <= 2.5 ? 4 : 0,
    poolAge: candidate.poolAgeMinutes >= 20 && candidate.poolAgeMinutes <= 720 ? 6 : candidate.poolAgeMinutes < 5 ? -10 : 0,
  };
  const rawScore = score;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const confidence =
    score >= 78 ? "high" : score >= 62 ? "medium" : "low";
  const status =
    score >= 78 && risks.length <= 2 ? "armed" : "watching";

  return {
    ...candidate,
    score,
    rawScore,
    subScores,
    confidence,
    status,
    reasons,
    risks,
  };
}

function regime`,
  "rank function"
);

replaceRequired(
  "paper-trader/marketDiscoveryAgent.ts",
  `  const now = new Date().toISOString();
  const top = ranked.slice(0, TOP_LIMIT);

  if (top.length > 0) {`,
  `  const now = new Date().toISOString();
  const top = ranked.slice(0, TOP_LIMIT);
  const discoveryFeatureSource = discoveryMeta.servedFrom === "cache" ? "cache" : "gecko";

  if (top.length > 0) {`,
  "discovery feature source"
);

replaceRequired(
  "paper-trader/marketDiscoveryAgent.ts",
  `        signal_snapshot: {
          version: VERSION,
          buyRatio: item.buysM5 / Math.max(1, item.buysM5 + item.sellsM5),
          discoveryStale: discoveryMeta.stale,
          discoveryServedFrom: discoveryMeta.servedFrom,
          discoveryCacheAgeMs: discoveryMeta.cacheAgeMs,
        },`,
  `        signal_snapshot: {
          version: VERSION,
          buyRatio: item.buysM5 / Math.max(1, item.buysM5 + item.sellsM5),
          rawScore: item.rawScore,
          subScores: item.subScores,
          fdvUsd: item.fdvUsd,
          marketCapUsd: item.marketCapUsd,
          volumeM5Usd: item.volumeM5,
          volumeH1Usd: item.volumeH1,
          volumeH24Usd: item.volumeH24,
          priceChangeM5: item.changeM5,
          priceChangeH1: item.changeH1,
          priceChangeH24: item.changeH24,
          buysM5: item.buysM5,
          sellsM5: item.sellsM5,
          buyersM5: item.buyersM5,
          uniqueMakersM5: item.uniqueMakersM5,
          holderCount: item.holderCount,
          poolAgeMinutes: item.poolAgeMinutes,
          poolCreatedAt: item.poolCreatedAt,
          dexId: item.dexId,
          discoveryStale: discoveryMeta.stale,
          discoveryServedFrom: discoveryMeta.servedFrom,
          discoveryCacheAgeMs: discoveryMeta.cacheAgeMs,
          featureSources: {
            discovery_score: discoveryFeatureSource,
            discovery_sub_scores: discoveryFeatureSource,
            regime: discoveryFeatureSource,
            liquidity_usd: discoveryFeatureSource,
            fdv_usd: discoveryFeatureSource,
            market_cap_usd: discoveryFeatureSource,
            token_age_sec: discoveryFeatureSource,
            vol_5m: discoveryFeatureSource,
            vol_1h: discoveryFeatureSource,
            vol_24h: discoveryFeatureSource,
            price_change_5m: discoveryFeatureSource,
            price_change_1h: discoveryFeatureSource,
            price_change_24h: discoveryFeatureSource,
            txns_5m_buys: discoveryFeatureSource,
            txns_5m_sells: discoveryFeatureSource,
            unique_makers_5m: item.uniqueMakersM5 == null ? null : discoveryFeatureSource,
          },
        },`,
  "enriched discovery signal snapshot"
);

replaceRequired(
  "paper-trader/aiDiscoveryTrader.ts",
  `import { PAPER_COST_MODEL } from "./executionCosts";
import { evaluateLiveEntrySafety } from "../live-executor/liveSafety";`,
  `import { PAPER_COST_MODEL } from "./executionCosts";
import { buildAiEntryFeatureSnapshot } from "./aiEntryFeatures";
import { evaluateLiveEntrySafety } from "../live-executor/liveSafety";`,
  "entry feature import"
);

replaceRequired(
  "paper-trader/aiDiscoveryTrader.ts",
  `type Market = {
  priceUsd: number;
  liquidityUsd: number;
  marketCapUsd: number;
  changeM5: number;
};`,
  `type Market = {
  priceUsd: number;
  liquidityUsd: number;
  marketCapUsd: number;
  changeM5: number;
  priceSource?: "helius" | "gecko" | "dex" | "cache" | null;
  poolProgram?: string | null;
};`,
  "market source fields"
);

replaceRequired(
  "paper-trader/aiDiscoveryTrader.ts",
  `      return { priceUsd: helius.priceUsd, liquidityUsd: 0, marketCapUsd: 0, changeM5: 0 };`,
  `      return {
        priceUsd: helius.priceUsd,
        liquidityUsd: 0,
        marketCapUsd: 0,
        changeM5: 0,
        priceSource: helius.source,
        poolProgram: helius.poolProgram,
      };`,
  "exit helius market metadata"
);

replaceRequired(
  "paper-trader/aiDiscoveryTrader.ts",
  `  return {
    priceUsd,
    liquidityUsd,
    marketCapUsd: n(pair?.marketCap ?? pair?.fdv, 0),
    changeM5: n(pair?.priceChange?.m5, 0),
  };`,
  `  return {
    priceUsd,
    liquidityUsd,
    marketCapUsd: n(pair?.marketCap ?? pair?.fdv, 0),
    changeM5: n(pair?.priceChange?.m5, 0),
    priceSource: "dex",
    poolProgram: null,
  };`,
  "dex market metadata"
);

replaceRequired(
  "paper-trader/aiDiscoveryTrader.ts",
  `    return {
      priceUsd: helius.priceUsd,
      liquidityUsd,
      marketCapUsd: n(opportunity.market_cap_usd, 0),
      changeM5: n(opportunity.price_change_m5, 0),
    };`,
  `    return {
      priceUsd: helius.priceUsd,
      liquidityUsd,
      marketCapUsd: n(opportunity.market_cap_usd, 0),
      changeM5: n(opportunity.price_change_m5, 0),
      priceSource: helius.source,
      poolProgram: helius.poolProgram,
    };`,
  "entry helius market metadata"
);

replaceRequired(
  "paper-trader/aiDiscoveryTrader.ts",
  `async function recordObservation(
  opportunity: any,
  assessment: { passed: boolean; reasons: string[] }
): Promise<number | null> {`,
  `function observationFeatures(opportunity: any): Record<string, unknown> {
  return {
    score: n(opportunity.score),
    confidence: opportunity.confidence,
    status: opportunity.status,
    marketRegime: opportunity.market_regime,
    liquidityUsd: n(opportunity.liquidity_usd),
    marketCapUsd: n(opportunity.market_cap_usd),
    priceChangeM5: n(opportunity.price_change_m5),
    priceChangeH1: n(opportunity.price_change_h1),
    volumeM5Usd: n(opportunity.volume_m5_usd),
    volumeH1Usd: n(opportunity.volume_h1_usd),
    buysM5: n(opportunity.buys_m5),
    sellsM5: n(opportunity.sells_m5),
    buyersM5: n(opportunity.buyers_m5),
    poolAgeMinutes: n(opportunity.pool_age_minutes),
    reasons: opportunity.reasons ?? [],
    risks: opportunity.risks ?? [],
    discoverySignal: opportunity.signal_snapshot ?? {},
  };
}

async function recordObservation(
  opportunity: any,
  assessment: { passed: boolean; reasons: string[] }
): Promise<number | null> {`,
  "observation features helper"
);

replaceRegexRequired(
  "paper-trader/aiDiscoveryTrader.ts",
  /  const features = \{\n    score: n\(opportunity\.score\),[\s\S]*?\n  \};\n\n  const \{ data, error \}/,
  `  const features = observationFeatures(opportunity);

  const { data, error }`,
  "observation feature object"
);

replaceRegexRequired(
  "paper-trader/aiDiscoveryTrader.ts",
  /async function markObservationEntered\([\s\S]*?\n\}\n\nasync function collectCandidateObservations/,
  `async function markObservationEntered(
  id: number | null,
  entryPriceUsd: number,
  entryId: string,
  entryTs: string,
  entrySnapshot: Record<string, unknown>,
  opportunity: any
): Promise<void> {
  if (!id) return;
  const features = {
    ...observationFeatures(opportunity),
    entry_id: entryId,
    entry_ts: entryTs,
    entry_snapshot: entrySnapshot,
  };
  const { error } = await supabase
    .from("ai_candidate_observations")
    .update({
      entered: true,
      decision: "enter",
      entry_price_usd: entryPriceUsd,
      entry_id: entryId,
      entry_ts: entryTs,
      features,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) {
    console.error(
      `[ai-discovery-trader] entry feature join failed entry_id=${entryId} observation_id=${id}`,
      error
    );
  }
}

async function collectCandidateObservations`,
  "entered observation join"
);

replaceRegexRequired(
  "paper-trader/aiDiscoveryTrader.ts",
  /async function openTrade\([\s\S]*?\n\}\n\nasync function scanEntries/,
  `async function openTrade(
  state: State,
  opportunity: any,
  market: Market,
  observationId: number | null
): Promise<void> {
  const sizeSol = Math.min(FIXED_SIZE_SOL, n(state.bankroll_sol));
  if (sizeSol < FIXED_SIZE_SOL) return;

  const now = new Date().toISOString();
  const positionId = `ai_${randomUUID()}`;
  const entryQuote = await paperEntryTokenAmount(opportunity.mint, sizeSol);
  const entryFeatures = buildAiEntryFeatureSnapshot({
    entryId: positionId,
    entryTs: now,
    opportunity,
    market,
  });
  const snapshot = {
    version: VERSION,
    opportunity,
    market,
    observationId,
    quoteExitAccounting: true,
    entryQuote: entryQuote.quote,
    ...entryFeatures,
  };

  const { error } = await supabase.from("ai_discovery_positions").insert({
    position_id: positionId,
    mint: opportunity.mint,
    token_symbol: opportunity.token_symbol,
    pair_address: opportunity.pair_address,
    entry_price_usd: market.priceUsd,
    last_price_usd: market.priceUsd,
    peak_price_usd: market.priceUsd,
    size_sol: sizeSol,
    token_amount: entryQuote.tokenAmount,
    quote_peak_value_sol: sizeSol,
    last_executable_value_sol: sizeSol,
    opened_at: now,
    last_checked_at: now,
    entry_snapshot: snapshot,
    updated_at: now,
  });
  if (error) throw new Error(error.message);

  await supabase
    .from("ai_discovery_state")
    .update({
      bankroll_sol: n(state.bankroll_sol) - sizeSol,
      entries_today: state.entries_today + 1,
      last_entry_at: now,
      last_scan_at: now,
      updated_at: now,
    })
    .eq("id", 1);

  await markObservationEntered(
    observationId,
    market.priceUsd,
    positionId,
    now,
    snapshot,
    opportunity
  );
  console.log(
    `[ai-discovery-trader] features ${opportunity.token_symbol ?? opportunity.mint} ` +
      `score=${entryFeatures.discovery_score ?? "null"} ` +
      `liq=${entryFeatures.liquidity_usd ?? "null"} ` +
      `age=${entryFeatures.token_age_sec ?? "null"}s ` +
      `holders=${entryFeatures.holder_count ?? "null"} ` +
      `vol5m=${entryFeatures.vol_5m ?? "null"} ` +
      `captured=${entryFeatures.capture.nonnull}/${entryFeatures.capture.total}`
  );
  await sendTelegramAlert(
    [
      "🧠⚡ <b>AI DISCOVERY PAPER TRADE OPENED</b>",
      "",
      `Token: <b>${opportunity.token_symbol}</b>`,
      `Score: <b>${opportunity.score}/100</b>`,
      `Size: <b>${sizeSol.toFixed(3)} SOL</b>`,
      `Liquidity: <b>$${Math.round(market.liquidityUsd).toLocaleString()}</b>`,
      `Reasons: ${(opportunity.reasons ?? []).slice(0, 3).join(", ")}`,
      "",
      `<a href="https://dexscreener.com/solana/${opportunity.pair_address}">Open chart</a>`,
      "",
      "🧪 Paper only — no real SOL used.",
    ].join("\n")
  );
}

async function scanEntries`,
  "open trade feature capture"
);

replaceRequired(
  "live-executor/liveSafety.ts",
  `    const topAmounts = largest.value.slice(0, 5).map((item) => BigInt(item.amount));
    const top1Pct = Number(((topAmounts[0] ?? 0n) * 10_000n) / supply) / 100;
    const top5Pct = Number((topAmounts.reduce((sum, amount) => sum + amount, 0n) * 10_000n) / supply) / 100;
    Object.assign(details, {
      top1HolderPct: top1Pct,
      top5HolderPct: top5Pct,`,
  `    const topAmounts = largest.value.slice(0, 10).map((item) => BigInt(item.amount));
    const top1Pct = Number(((topAmounts[0] ?? 0n) * 10_000n) / supply) / 100;
    const top5Pct = Number((topAmounts.slice(0, 5).reduce((sum, amount) => sum + amount, 0n) * 10_000n) / supply) / 100;
    const top10Pct = Number((topAmounts.reduce((sum, amount) => sum + amount, 0n) * 10_000n) / supply) / 100;
    Object.assign(details, {
      top1HolderPct: top1Pct,
      top5HolderPct: top5Pct,
      top10HolderPct: top10Pct,
      largestAccountsSampled: topAmounts.length,`,
  "top ten holder capture"
);

replaceRequired(
  "paper-trader/aiOutcomeTrackerV10.ts",
  `.select("id,mint,pair_address,entered,entry_price_usd,observed_at,outcome_quality")`,
  `.select("id,mint,pair_address,entered,entry_id,entry_ts,entry_price_usd,observed_at,outcome_quality")`,
  "sample entry join fields"
);

replaceRequired(
  "paper-trader/aiOutcomeTrackerV10.ts",
  `    let measuredAt = forced ? row.observed_at : null;`,
  `    let measuredAt = forced ? row.entry_ts ?? row.observed_at : null;`,
  "sample baseline entry timestamp"
);

replaceRequired(
  "paper-trader/aiOutcomeTrackerV10.ts",
  `.select("id,entry_price_usd,observed_at")`,
  `.select("id,entry_id,entry_ts,entry_price_usd,observed_at")`,
  "promote entry join fields"
);

replaceRequired(
  "paper-trader/aiOutcomeTrackerV10.ts",
  `        observed_price_at: row.observed_at ?? now,`,
  `        observed_price_at: row.entry_ts ?? row.observed_at ?? now,`,
  "promote baseline entry timestamp"
);

replaceRequired(
  "paper-trader/aiOutcomeTrackerV10.ts",
  `function rowResolved(
  row: any,`,
  `function outcomeAnchor(row: any): string {
  return row.entry_ts ?? row.observed_at;
}

function rowResolved(
  row: any,`,
  "outcome anchor helper"
);

replaceRequired(
  "paper-trader/aiOutcomeTrackerV10.ts",
  `        (horizon) => horizonState(row.observed_at, horizon, nowMs) !== "pending"
      );
      if (!firstActionable) return null;
      return {
        row,
        targetMs: Date.parse(row.observed_at) + firstActionable * 60_000,`,
  `        (horizon) => horizonState(outcomeAnchor(row), horizon, nowMs) !== "pending"
      );
      if (!firstActionable) return null;
      return {
        row,
        targetMs: Date.parse(outcomeAnchor(row)) + firstActionable * 60_000,`,
  "actionable entry anchor"
);

replaceRequired(
  "paper-trader/aiOutcomeTrackerV10.ts",
  `      const state = horizonState(row.observed_at, horizon);`,
  `      const state = horizonState(outcomeAnchor(row), horizon);`,
  "due horizon entry anchor"
);

replaceRequired(
  "paper-trader/aiOutcomeTrackerV10.ts",
  `        const targetMs = Date.parse(row.observed_at) + dueHorizon * 60_000;`,
  `        const targetMs = Date.parse(outcomeAnchor(row)) + dueHorizon * 60_000;`,
  "measurement target entry anchor"
);

console.log("AI entry feature snapshot codemod applied.");
