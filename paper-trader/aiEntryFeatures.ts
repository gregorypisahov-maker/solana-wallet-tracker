export type EntryFeatureSource = "helius" | "gecko" | "dex" | "cache" | null;

export type EntryFeatureMarket = {
  priceUsd: number;
  liquidityUsd: number;
  marketCapUsd: number;
  changeM5: number;
  priceSource?: EntryFeatureSource;
  poolProgram?: string | null;
};

export type EntryFeatureCapture = {
  nonnull: number;
  total: number;
  ratio: number;
};

const CAPTURE_FIELDS = [
  "discovery_score",
  "discovery_sub_scores",
  "regime",
  "lp_lock",
  "helius_would_block",
  "liquidity_usd",
  "fdv_usd",
  "market_cap_usd",
  "token_age_sec",
  "holder_count",
  "top10_holder_pct",
  "vol_5m",
  "vol_1h",
  "vol_24h",
  "price_change_5m",
  "price_change_1h",
  "price_change_24h",
  "txns_5m_buys",
  "txns_5m_sells",
  "unique_makers_5m",
  "price_usd_at_entry",
] as const;

function finiteOrNull(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integerOrNull(value: unknown): number | null {
  const parsed = finiteOrNull(value);
  return parsed == null ? null : Math.trunc(parsed);
}

function sourceOrNull(value: unknown): EntryFeatureSource {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "helius" || normalized === "gecko" || normalized === "dex" || normalized === "cache") {
    return normalized;
  }
  if (normalized === "dexscreener") return "dex";
  if (normalized === "geckoterminal") return "gecko";
  return null;
}

function meaningful(value: unknown): boolean {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

export function captureStats(snapshot: Record<string, unknown>): EntryFeatureCapture {
  const nonnull = CAPTURE_FIELDS.reduce((count, field) => count + (meaningful(snapshot[field]) ? 1 : 0), 0);
  const total = CAPTURE_FIELDS.length;
  return { nonnull, total, ratio: Number((nonnull / total).toFixed(4)) };
}

export function buildAiEntryFeatureSnapshot(input: {
  entryId: string;
  entryTs: string;
  opportunity: Record<string, any>;
  market: EntryFeatureMarket;
}): Record<string, unknown> & { capture: EntryFeatureCapture } {
  const { entryId, entryTs, opportunity, market } = input;
  const signal = (opportunity.signal_snapshot ?? {}) as Record<string, any>;
  const safety = (opportunity.entry_safety ?? {}) as Record<string, any>;
  const lpLock = (safety.lp_lock ?? safety.liquiditySafety ?? null) as Record<string, any> | null;
  const rawSources = (signal.featureSources ?? signal.feature_source ?? {}) as Record<string, unknown>;
  const discoverySource = sourceOrNull(
    signal.discoveryServedFrom === "cache" || signal.discoveryStale === true ? "cache" : "gecko"
  );
  const buys = integerOrNull(opportunity.buys_m5 ?? signal.buysM5);
  const sells = integerOrNull(opportunity.sells_m5 ?? signal.sellsM5);
  const buySellRatio = buys != null && sells != null && buys + sells > 0 ? buys / (buys + sells) : null;
  const poolAgeMinutes = finiteOrNull(opportunity.pool_age_minutes ?? signal.poolAgeMinutes);
  const liquidityUsd = finiteOrNull(market.liquidityUsd ?? opportunity.liquidity_usd ?? safety.liquidityUsd);
  const marketCapUsd = finiteOrNull(opportunity.market_cap_usd ?? market.marketCapUsd ?? signal.marketCapUsd);
  const fdvUsd = finiteOrNull(signal.fdvUsd ?? safety.fdv ?? opportunity.fdv_usd ?? marketCapUsd);
  const top10HolderPct = finiteOrNull(safety.top10HolderPct ?? signal.top10HolderPct);
  const holderCount = integerOrNull(safety.holderCount ?? signal.holderCount);
  const poolProgram = market.poolProgram ?? signal.poolProgram ?? null;
  const priceSource = sourceOrNull(market.priceSource ?? rawSources.price_usd_at_entry);

  const featureSource: Record<string, EntryFeatureSource> = {
    discovery_score: sourceOrNull(rawSources.discovery_score) ?? discoverySource,
    discovery_sub_scores: sourceOrNull(rawSources.discovery_sub_scores) ?? discoverySource,
    regime: sourceOrNull(rawSources.regime) ?? discoverySource,
    lp_lock: lpLock ? "helius" : null,
    helius_would_block: safety.heliusWouldBlock == null ? null : "helius",
    liquidity_usd: sourceOrNull(rawSources.liquidity_usd) ?? discoverySource,
    fdv_usd: sourceOrNull(rawSources.fdv_usd) ?? (safety.fdv != null ? "dex" : discoverySource),
    market_cap_usd: sourceOrNull(rawSources.market_cap_usd) ?? discoverySource,
    token_age_sec: sourceOrNull(rawSources.token_age_sec) ?? discoverySource,
    holder_count: holderCount == null ? null : "helius",
    top10_holder_pct: top10HolderPct == null ? null : "helius",
    vol_5m: sourceOrNull(rawSources.vol_5m) ?? discoverySource,
    vol_1h: sourceOrNull(rawSources.vol_1h) ?? discoverySource,
    vol_24h: sourceOrNull(rawSources.vol_24h) ?? discoverySource,
    price_change_5m: sourceOrNull(rawSources.price_change_5m) ?? discoverySource,
    price_change_1h: sourceOrNull(rawSources.price_change_1h) ?? discoverySource,
    price_change_24h: sourceOrNull(rawSources.price_change_24h) ?? discoverySource,
    txns_5m_buys: sourceOrNull(rawSources.txns_5m_buys) ?? discoverySource,
    txns_5m_sells: sourceOrNull(rawSources.txns_5m_sells) ?? discoverySource,
    unique_makers_5m: sourceOrNull(rawSources.unique_makers_5m) ?? discoverySource,
    price_usd_at_entry: priceSource,
  };

  const snapshot: Record<string, unknown> = {
    entry_id: entryId,
    mint: String(opportunity.mint ?? ""),
    symbol: String(opportunity.token_symbol ?? opportunity.symbol ?? opportunity.mint ?? ""),
    poolAddress: String(opportunity.pair_address ?? opportunity.poolAddress ?? "") || null,
    poolProgram,
    dex_id: signal.dexId ?? opportunity.dex_id ?? null,
    entry_ts: entryTs,
    discovery_score: finiteOrNull(opportunity.score),
    discovery_sub_scores: signal.subScores ?? opportunity.sub_scores ?? null,
    regime: opportunity.market_regime ?? signal.marketRegime ?? null,
    lp_lock: lpLock
      ? {
          verdict: lpLock.verdict ?? null,
          method: lpLock.method ?? null,
          pctLocked: finiteOrNull(lpLock.pctLocked),
          action: lpLock.action ?? null,
        }
      : null,
    helius_would_block: safety.heliusWouldBlock == null ? null : safety.heliusWouldBlock === true,
    liquidity_usd: liquidityUsd,
    fdv_usd: fdvUsd,
    market_cap_usd: marketCapUsd,
    token_age_sec: poolAgeMinutes == null ? null : Math.max(0, Math.round(poolAgeMinutes * 60)),
    holder_count: holderCount,
    top10_holder_pct: top10HolderPct,
    vol_5m: finiteOrNull(opportunity.volume_m5_usd ?? signal.volumeM5Usd),
    vol_1h: finiteOrNull(opportunity.volume_h1_usd ?? signal.volumeH1Usd),
    vol_24h: finiteOrNull(signal.volumeH24Usd ?? opportunity.volume_h24_usd),
    price_change_5m: finiteOrNull(opportunity.price_change_m5 ?? signal.priceChangeM5),
    price_change_1h: finiteOrNull(opportunity.price_change_h1 ?? signal.priceChangeH1),
    price_change_24h: finiteOrNull(signal.priceChangeH24 ?? opportunity.price_change_h24),
    txns_5m_buys: buys,
    txns_5m_sells: sells,
    buy_sell_ratio: buySellRatio == null ? null : Number(buySellRatio.toFixed(6)),
    unique_makers_5m: integerOrNull(signal.uniqueMakersM5 ?? opportunity.unique_makers_m5),
    price_usd_at_entry: finiteOrNull(market.priceUsd),
    feature_source: featureSource,
  };

  return { ...snapshot, capture: captureStats(snapshot) };
}
