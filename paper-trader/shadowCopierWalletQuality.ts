import { getSupabaseAdmin } from "../lib/supabase";

const supabase = getSupabaseAdmin();
const PAGE_SIZE = 1_000;
const CACHE_MS = 15 * 60_000;
const MIN_PROVEN_SAMPLE = 20;
const FULL_CONFIDENCE_T_STAT = 1.645;
const PROBE_MULTIPLIER = 0.15;
const DECAY_MARGIN = 0.03;

type ParticipantInput = {
  wallet_address: string;
  sol_amount: number | string;
};

type TieredTradeRow = {
  id: number | string;
  position_id: string;
  entry_wallet: string;
  pnl_sol: number | string;
  sold_size_sol: number | string;
  sold_pct: number | string;
  happened_at: string;
};

type PositionAggregate = {
  positionId: string;
  walletAddress: string;
  pnlSol: number;
  costSol: number;
  soldPct: number;
  completedAtMs: number;
};

export type ShadowCopierWalletProfile = {
  walletAddress: string;
  n: number;
  lifetimeMeanReturn: number | null;
  returnSd: number | null;
  tStat: number | null;
  recent1: number | null;
  recent1To5: number | null;
  recent6To10: number | null;
  recent11To15: number | null;
  recent10Avg: number | null;
  olderAvg: number | null;
  lifetimePnlSol: number;
  winRate: number | null;
};

export type ShadowCopierParticipantDecision = {
  wallet_address: string;
  wallet_sol_bought: number;
  contribution_weight: number;
  n: number;
  lifetime_mean_return: number | null;
  return_sd: number | null;
  t_stat: number | null;
  recent_1: number | null;
  recent_1_5: number | null;
  recent_6_10: number | null;
  recent_11_15: number | null;
  recent_10_avg: number | null;
  older_avg: number | null;
  lifetime_pnl_sol: number;
  win_rate: number | null;
  decay_flag: boolean;
  unproven_flag: boolean;
  wallet_multiplier: number;
  wallet_rejection_reasons: string[];
};

export type ShadowCopierQualityEvaluation = {
  pass: boolean;
  signalMultiplier: number | null;
  reasons: string[];
  snapshot: {
    data_source: "tiered_copier_returns";
    generated_at: string;
    cache_age_seconds: number;
    completed_position_count: number;
    excluded_incomplete_positions: number;
    min_proven_sample: number;
    full_confidence_t_stat: number;
    probe_multiplier: number;
    decay_margin: number;
    participants: ShadowCopierParticipantDecision[];
    signal_multiplier: number | null;
    hard_rejection_triggered: boolean;
    final_reasons: string[];
  };
};

type ProfileCache = {
  generatedAtMs: number;
  profiles: Map<string, ShadowCopierWalletProfile>;
  completedPositionCount: number;
  excludedIncompletePositions: number;
};

let cachedProfiles: ProfileCache | null = null;
let refreshInFlight: Promise<ProfileCache> | null = null;

function finite(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`invalid ${label}`);
  return number;
}

function average(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleSd(values: number[], meanValue: number): number | null {
  if (values.length < 2) return null;
  const variance = values.reduce((sum, value) => sum + (value - meanValue) ** 2, 0) / (values.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function calculateTStat(meanValue: number | null, sd: number | null, n: number): number | null {
  if (meanValue == null || n < 2 || sd == null) return null;
  if (sd === 0) return meanValue > 0 ? 999 : meanValue < 0 ? -999 : 0;
  return meanValue / (sd / Math.sqrt(n));
}

async function fetchTieredTradeRows(): Promise<TieredTradeRow[]> {
  const rows: TieredTradeRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("tiered_trades")
      .select("id,position_id,entry_wallet,pnl_sol,sold_size_sol,sold_pct,happened_at")
      .not("position_id", "is", null)
      .not("entry_wallet", "is", null)
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(`tiered copier history query failed: ${error.message}`);
    rows.push(...((data ?? []) as TieredTradeRow[]));
    if ((data?.length ?? 0) < PAGE_SIZE) break;
  }
  return rows;
}

function aggregateCompletedPositions(rows: TieredTradeRow[]): {
  completed: PositionAggregate[];
  excludedIncompletePositions: number;
} {
  const byPosition = new Map<string, PositionAggregate>();
  for (const row of rows) {
    const positionId = String(row.position_id ?? "").trim();
    const walletAddress = String(row.entry_wallet ?? "").trim();
    if (!positionId || !walletAddress) throw new Error("tiered copier row missing position or wallet");
    const pnlSol = finite(row.pnl_sol, "tiered pnl_sol");
    const costSol = finite(row.sold_size_sol, "tiered sold_size_sol");
    const soldPct = finite(row.sold_pct, "tiered sold_pct");
    const completedAtMs = Date.parse(row.happened_at);
    if (!Number.isFinite(completedAtMs)) throw new Error("invalid tiered happened_at");
    if (costSol <= 0 || soldPct <= 0) throw new Error("invalid tiered position sizing data");

    const current = byPosition.get(positionId);
    if (current && current.walletAddress !== walletAddress) {
      throw new Error(`tiered position ${positionId} has conflicting entry wallets`);
    }
    const aggregate = current ?? {
      positionId,
      walletAddress,
      pnlSol: 0,
      costSol: 0,
      soldPct: 0,
      completedAtMs: 0,
    };
    aggregate.pnlSol += pnlSol;
    aggregate.costSol += costSol;
    aggregate.soldPct += soldPct;
    aggregate.completedAtMs = Math.max(aggregate.completedAtMs, completedAtMs);
    byPosition.set(positionId, aggregate);
  }

  const completed: PositionAggregate[] = [];
  let excludedIncompletePositions = 0;
  for (const position of byPosition.values()) {
    if (position.soldPct < 0.999) {
      excludedIncompletePositions += 1;
      continue;
    }
    if (position.costSol <= 0) throw new Error(`tiered position ${position.positionId} has zero cost`);
    completed.push(position);
  }
  return { completed, excludedIncompletePositions };
}

function buildProfile(walletAddress: string, positionsNewestFirst: PositionAggregate[]): ShadowCopierWalletProfile {
  const returns = positionsNewestFirst.map((position) => position.pnlSol / position.costSol);
  if (returns.some((value) => !Number.isFinite(value))) {
    throw new Error(`invalid normalized copier return for ${walletAddress}`);
  }
  const lifetimeMeanReturn = average(returns);
  const returnSd = lifetimeMeanReturn == null ? null : sampleSd(returns, lifetimeMeanReturn);
  const n = returns.length;
  return {
    walletAddress,
    n,
    lifetimeMeanReturn,
    returnSd,
    tStat: calculateTStat(lifetimeMeanReturn, returnSd, n),
    recent1: returns[0] ?? null,
    recent1To5: average(returns.slice(0, 5)),
    recent6To10: average(returns.slice(5, 10)),
    recent11To15: average(returns.slice(10, 15)),
    recent10Avg: average(returns.slice(0, 10)),
    olderAvg: average(returns.slice(10)),
    lifetimePnlSol: positionsNewestFirst.reduce((sum, position) => sum + position.pnlSol, 0),
    winRate: n > 0 ? returns.filter((value) => value > 0).length / n : null,
  };
}

async function refreshProfiles(): Promise<ProfileCache> {
  const rows = await fetchTieredTradeRows();
  const { completed, excludedIncompletePositions } = aggregateCompletedPositions(rows);
  const byWallet = new Map<string, PositionAggregate[]>();
  for (const position of completed) {
    const positions = byWallet.get(position.walletAddress) ?? [];
    positions.push(position);
    byWallet.set(position.walletAddress, positions);
  }

  const profiles = new Map<string, ShadowCopierWalletProfile>();
  for (const [walletAddress, positions] of byWallet) {
    positions.sort((a, b) => b.completedAtMs - a.completedAtMs);
    profiles.set(walletAddress, buildProfile(walletAddress, positions));
  }

  const result: ProfileCache = {
    generatedAtMs: Date.now(),
    profiles,
    completedPositionCount: completed.length,
    excludedIncompletePositions,
  };
  cachedProfiles = result;
  return result;
}

async function loadProfiles(): Promise<ProfileCache> {
  if (cachedProfiles && Date.now() - cachedProfiles.generatedAtMs < CACHE_MS) return cachedProfiles;
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = refreshProfiles().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

function emptyProfile(walletAddress: string): ShadowCopierWalletProfile {
  return {
    walletAddress,
    n: 0,
    lifetimeMeanReturn: null,
    returnSd: null,
    tStat: null,
    recent1: null,
    recent1To5: null,
    recent6To10: null,
    recent11To15: null,
    recent10Avg: null,
    olderAvg: null,
    lifetimePnlSol: 0,
    winRate: null,
  };
}

export async function evaluateShadowCopierWalletQuality(
  participants: ParticipantInput[]
): Promise<ShadowCopierQualityEvaluation> {
  if (!participants.length) throw new Error("copier wallet quality requires participants");
  const totalSol = participants.reduce((sum, participant) => {
    const amount = finite(participant.sol_amount, "participant sol_amount");
    if (amount <= 0) throw new Error("participant sol_amount must be positive");
    return sum + amount;
  }, 0);
  if (!Number.isFinite(totalSol) || totalSol <= 0) throw new Error("invalid participant SOL total");

  const profileCache = await loadProfiles();
  const decisions: ShadowCopierParticipantDecision[] = [];
  const signalReasons: string[] = [];
  let weightedMultiplier = 0;

  for (const participant of participants) {
    const walletAddress = String(participant.wallet_address ?? "").trim();
    if (!walletAddress) throw new Error("participant wallet address is missing");
    const walletSol = finite(participant.sol_amount, "participant sol_amount");
    const contributionWeight = walletSol / totalSol;
    const profile = profileCache.profiles.get(walletAddress) ?? emptyProfile(walletAddress);
    const rejectionReasons: string[] = [];
    const unproven = profile.n < MIN_PROVEN_SAMPLE;

    let decayFlag = false;
    if (!unproven) {
      if (profile.tStat == null) rejectionReasons.push("copier_t_stat_unresolved");
      else if (profile.tStat < 0) rejectionReasons.push("copier_t_stat_negative");

      const positiveLifetimeButNegativeRecent =
        profile.recent10Avg != null &&
        profile.recent10Avg < 0 &&
        profile.lifetimeMeanReturn != null &&
        profile.lifetimeMeanReturn > 0;
      const materialRecentDrop =
        profile.recent10Avg != null &&
        profile.olderAvg != null &&
        profile.olderAvg - profile.recent10Avg >= DECAY_MARGIN;
      decayFlag = positiveLifetimeButNegativeRecent || materialRecentDrop;
      if (positiveLifetimeButNegativeRecent) {
        rejectionReasons.push("copier_recent_10_negative_while_lifetime_positive");
      }
      if (materialRecentDrop) rejectionReasons.push("copier_recent_decay_margin_exceeded");
    }

    let walletMultiplier = PROBE_MULTIPLIER;
    if (!unproven && rejectionReasons.length === 0) {
      walletMultiplier = clamp((profile.tStat as number) / FULL_CONFIDENCE_T_STAT, PROBE_MULTIPLIER, 1);
    } else if (rejectionReasons.length > 0) {
      walletMultiplier = 0;
    }
    weightedMultiplier += walletMultiplier * contributionWeight;

    const shortWallet = `${walletAddress.slice(0, 6)}…`;
    for (const reason of rejectionReasons) signalReasons.push(`${reason}:${shortWallet}`);
    decisions.push({
      wallet_address: walletAddress,
      wallet_sol_bought: walletSol,
      contribution_weight: contributionWeight,
      n: profile.n,
      lifetime_mean_return: profile.lifetimeMeanReturn,
      return_sd: profile.returnSd,
      t_stat: profile.tStat,
      recent_1: profile.recent1,
      recent_1_5: profile.recent1To5,
      recent_6_10: profile.recent6To10,
      recent_11_15: profile.recent11To15,
      recent_10_avg: profile.recent10Avg,
      older_avg: profile.olderAvg,
      lifetime_pnl_sol: profile.lifetimePnlSol,
      win_rate: profile.winRate,
      decay_flag: decayFlag,
      unproven_flag: unproven,
      wallet_multiplier: walletMultiplier,
      wallet_rejection_reasons: rejectionReasons,
    });
  }

  const hardRejectionTriggered = signalReasons.length > 0;
  const signalMultiplier = hardRejectionTriggered ? null : clamp(weightedMultiplier, PROBE_MULTIPLIER, 1);
  const generatedAt = new Date(profileCache.generatedAtMs).toISOString();
  return {
    pass: !hardRejectionTriggered,
    signalMultiplier,
    reasons: signalReasons,
    snapshot: {
      data_source: "tiered_copier_returns",
      generated_at: generatedAt,
      cache_age_seconds: Math.max(0, (Date.now() - profileCache.generatedAtMs) / 1_000),
      completed_position_count: profileCache.completedPositionCount,
      excluded_incomplete_positions: profileCache.excludedIncompletePositions,
      min_proven_sample: MIN_PROVEN_SAMPLE,
      full_confidence_t_stat: FULL_CONFIDENCE_T_STAT,
      probe_multiplier: PROBE_MULTIPLIER,
      decay_margin: DECAY_MARGIN,
      participants: decisions,
      signal_multiplier: signalMultiplier,
      hard_rejection_triggered: hardRejectionTriggered,
      final_reasons: signalReasons,
    },
  };
}
