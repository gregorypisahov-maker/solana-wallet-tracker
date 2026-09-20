export type RpcCall = <T>(method: string, params: unknown[], mint: string, estimatedCredits?: number) => Promise<T>;

export type HolderSample = {
  token_account: string;
  owner: string | null;
  amount: number;
  funding_source: string | null;
  recent_sol_delta: number | null;
};

export type FundingClusterMetrics = {
  resolved_funding_count: number;
  unresolved_funding_count: number;
  funding_resolution_ratio: number | null;
  resolved_independent_count: number;
  resolved_independent_ratio: number | null;
  holder_cluster_count: number;
  largest_holder_cluster_size: number;
  largest_holder_cluster_ratio: number | null;
  direct_holder_funding_links: number;
  shared_external_funder_links: number;
};

export type FlowSignalResult = {
  signal_version: "helius_flow_signal_v1";
  trade_eligible: boolean;
  recommendation: "would_consider" | "would_watch";
  signal_score: number;
  reasons: string[];
  missing_evidence: string[];
  features: Record<string, unknown>;
  holder_samples: HolderSample[];
};

function keyOf(value: any): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value.pubkey === "string") return value.pubkey;
  return null;
}

function parsedTokenOwner(account: any): string | null {
  return account?.data?.parsed?.info?.owner || null;
}

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

export function computeFundingClusterMetrics(samples: HolderSample[]): FundingClusterMetrics {
  const owners = samples.map((x) => x.owner).filter((x): x is string => Boolean(x));
  const ownerSet = new Set(owners);
  const resolved = samples.filter((x) => x.owner && x.funding_source);
  const unresolved = samples.filter((x) => x.owner && !x.funding_source);

  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const current = parent.get(x) ?? x;
    if (current === x) {
      parent.set(x, x);
      return x;
    }
    const root = find(current);
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  for (const owner of ownerSet) parent.set(owner, owner);

  let directHolderFundingLinks = 0;
  const byExternalFunder = new Map<string, string[]>();
  for (const row of resolved) {
    const owner = row.owner!;
    const funder = row.funding_source!;
    if (ownerSet.has(funder)) {
      directHolderFundingLinks += 1;
      union(owner, funder);
    } else {
      const list = byExternalFunder.get(funder) ?? [];
      list.push(owner);
      byExternalFunder.set(funder, list);
    }
  }

  let sharedExternalFunderLinks = 0;
  for (const linkedOwners of byExternalFunder.values()) {
    if (linkedOwners.length < 2) continue;
    for (let i = 1; i < linkedOwners.length; i += 1) {
      union(linkedOwners[0], linkedOwners[i]);
      sharedExternalFunderLinks += 1;
    }
  }

  const clusterSizes = new Map<string, number>();
  for (const owner of ownerSet) {
    const root = find(owner);
    clusterSizes.set(root, (clusterSizes.get(root) ?? 0) + 1);
  }
  const largestHolderClusterSize = Math.max(0, ...clusterSizes.values());

  const resolvedOwners = new Set(resolved.map((x) => x.owner!));
  const resolvedRoots = new Set([...resolvedOwners].map(find));
  const clusteredResolvedOwners = [...resolvedOwners].filter((owner) => (clusterSizes.get(find(owner)) ?? 0) > 1).length;
  const resolvedIndependentCount = Math.max(0, resolvedOwners.size - clusteredResolvedOwners);

  return {
    resolved_funding_count: resolved.length,
    unresolved_funding_count: unresolved.length,
    funding_resolution_ratio: owners.length ? resolved.length / owners.length : null,
    resolved_independent_count: resolvedIndependentCount,
    resolved_independent_ratio: resolvedOwners.size ? resolvedIndependentCount / resolvedOwners.size : null,
    holder_cluster_count: clusterSizes.size,
    largest_holder_cluster_size: largestHolderClusterSize,
    largest_holder_cluster_ratio: owners.length ? largestHolderClusterSize / owners.length : null,
    direct_holder_funding_links: directHolderFundingLinks,
    shared_external_funder_links: sharedExternalFunderLinks,
  };
}

async function resolveOwners(rpc: RpcCall, mint: string, largestValues: any[], maxOwners: number): Promise<HolderSample[]> {
  const chosen = largestValues.slice(0, maxOwners);
  const addresses = chosen.map((x: any) => String(x.address || "")).filter(Boolean);
  if (!addresses.length) return [];
  const result = await rpc<any>("getMultipleAccounts", [addresses, { encoding: "jsonParsed", commitment: "confirmed" }], mint, 1);
  const accounts = Array.isArray(result?.value) ? result.value : [];
  return chosen.map((row: any, index: number) => ({
    token_account: String(row.address || ""),
    owner: parsedTokenOwner(accounts[index]),
    amount: Number(row.uiAmountString || row.uiAmount || 0),
    funding_source: null,
    recent_sol_delta: null,
  }));
}

async function fundingEvidence(rpc: RpcCall, mint: string, owner: string): Promise<{ source: string | null; solDelta: number | null }> {
  const signatures = await rpc<any[]>("getSignaturesForAddress", [owner, { limit: 6, commitment: "confirmed" }], mint, 1);
  const list = Array.isArray(signatures) ? signatures : [];
  for (const item of list) {
    if (!item?.signature || item.err) continue;
    const tx = await rpc<any>("getTransaction", [item.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }], mint, 1);
    if (!tx?.transaction?.message || !tx?.meta) continue;
    const keys = (tx.transaction.message.accountKeys || []).map(keyOf);
    const ownerIndex = keys.indexOf(owner);
    const payer = keys[0] || null;
    let solDelta: number | null = null;
    if (ownerIndex >= 0 && Array.isArray(tx.meta.preBalances) && Array.isArray(tx.meta.postBalances)) {
      solDelta = (Number(tx.meta.postBalances[ownerIndex] || 0) - Number(tx.meta.preBalances[ownerIndex] || 0)) / 1_000_000_000;
    }
    if (payer && payer !== owner) return { source: payer, solDelta };
    if (solDelta !== null) return { source: null, solDelta };
  }
  return { source: null, solDelta: null };
}

function previousOwners(previousSnapshot: any): Map<string, number> {
  const rows = Array.isArray(previousSnapshot?.holder_samples) ? previousSnapshot.holder_samples : [];
  return new Map(rows.filter((r: any) => r?.owner).map((r: any) => [String(r.owner), Number(r.amount || 0)]));
}

export async function computeFlowSignal(input: {
  rpc: RpcCall;
  mint: string;
  largestValues: any[];
  authorities: any[] | null;
  previousSnapshot: any | null;
  reduced: boolean;
  maxOwners: number;
  maxFundingLookups: number;
}): Promise<FlowSignalResult> {
  const samples = await resolveOwners(input.rpc, input.mint, input.largestValues, input.maxOwners);
  const sampled = samples.filter((x) => x.owner);

  if (!input.reduced) {
    for (const sample of sampled.slice(0, input.maxFundingLookups)) {
      try {
        const evidence = await fundingEvidence(input.rpc, input.mint, sample.owner!);
        sample.funding_source = evidence.source;
        sample.recent_sol_delta = evidence.solDelta;
      } catch {
        // Missing evidence is recorded below; one bad owner must not abort the candidate.
      }
    }
  }

  const cluster = computeFundingClusterMetrics(samples);

  const authorityAddresses = new Set<string>();
  for (const authority of input.authorities || []) {
    const address = authority?.address || authority?.authority || authority;
    if (typeof address === "string") authorityAddresses.add(address);
  }
  const creatorLinkedOwners = sampled.filter((x) => x.owner && authorityAddresses.has(x.owner)).length;
  const creatorLinkedFunding = sampled.filter((x) => x.funding_source && authorityAddresses.has(x.funding_source)).length;

  const previous = previousOwners(input.previousSnapshot);
  let inflow = 0;
  let outflow = 0;
  let previousTotal = 0;
  for (const amount of previous.values()) previousTotal += amount;
  for (const row of sampled) {
    const before = previous.get(row.owner!) || 0;
    const delta = row.amount - before;
    if (delta > 0) inflow += delta;
    if (delta < 0) outflow += -delta;
  }
  const netTopHolderFlowRatio = previousTotal > 0 ? (inflow - outflow) / previousTotal : null;
  const earlyWalletSellPressure = previousTotal > 0 ? outflow / previousTotal : null;

  const solDeltas = sampled.map((x) => x.recent_sol_delta).filter((x): x is number => Number.isFinite(x));
  const netSolFlowSample = solDeltas.length ? solDeltas.reduce((a, b) => a + b, 0) : null;

  const missing: string[] = [];
  if (sampled.length < 6) missing.push("minimum_six_resolved_holder_owners");
  if (cluster.resolved_funding_count < 4) missing.push("minimum_four_funding_paths");
  if ((cluster.funding_resolution_ratio ?? 0) < 0.5) missing.push("insufficient_funding_resolution");
  if (!input.previousSnapshot) missing.push("second_time_series_snapshot");
  if (netTopHolderFlowRatio === null) missing.push("net_holder_flow_window");
  if (earlyWalletSellPressure === null) missing.push("early_wallet_sell_pressure_window");
  if (netSolFlowSample === null) missing.push("recent_sol_flow_sample");

  let score = 50;
  if (cluster.resolved_independent_ratio !== null) score += (cluster.resolved_independent_ratio - 0.7) * 30;
  if (cluster.largest_holder_cluster_ratio !== null) score += (0.35 - cluster.largest_holder_cluster_ratio) * 35;
  if (netTopHolderFlowRatio !== null) score += clamp(netTopHolderFlowRatio, -0.5, 0.5) * 30;
  if (earlyWalletSellPressure !== null) score -= clamp(earlyWalletSellPressure, 0, 1) * 35;
  score -= creatorLinkedOwners * 15;
  score -= creatorLinkedFunding * 12;
  score = Math.round(Math.min(100, Math.max(0, score)));

  const reasons: string[] = [];
  if ((cluster.resolved_independent_ratio ?? 0) >= 0.8 && (cluster.funding_resolution_ratio ?? 0) >= 0.5) reasons.push("resolved_buyers_appear_independent");
  if ((cluster.largest_holder_cluster_ratio ?? 1) <= 0.35) reasons.push("no_dominant_holder_funding_cluster");
  if ((netTopHolderFlowRatio ?? -1) > 0.03) reasons.push("positive_holder_flow_window");
  if ((earlyWalletSellPressure ?? 1) < 0.12) reasons.push("low_early_wallet_sell_pressure");
  if (creatorLinkedOwners === 0 && creatorLinkedFunding === 0) reasons.push("no_creator_linked_sample_flow");

  const tradeEligible = missing.length === 0
    && score >= 72
    && (cluster.resolved_independent_ratio ?? 0) >= 0.75
    && (cluster.funding_resolution_ratio ?? 0) >= 0.5
    && (cluster.largest_holder_cluster_ratio ?? 1) <= 0.4
    && creatorLinkedOwners === 0
    && creatorLinkedFunding === 0
    && (netTopHolderFlowRatio ?? -1) > 0
    && (earlyWalletSellPressure ?? 1) < 0.2;

  return {
    signal_version: "helius_flow_signal_v1",
    trade_eligible: tradeEligible,
    recommendation: tradeEligible ? "would_consider" : "would_watch",
    signal_score: score,
    reasons,
    missing_evidence: missing,
    features: {
      resolved_holder_owners: sampled.length,
      ...cluster,
      creator_linked_owner_count: creatorLinkedOwners,
      creator_linked_funding_count: creatorLinkedFunding,
      net_top_holder_flow_ratio: netTopHolderFlowRatio,
      recent_net_sol_delta_sample: netSolFlowSample,
      early_wallet_sell_pressure: earlyWalletSellPressure,
      time_series_ready: Boolean(input.previousSnapshot),
      launch_bundle_status: "not_analyzed",
      launch_bundle_trade_eligible: false,
      limitations: [
        "holder-flow is a sampled top-holder proxy, not a launch bundle map",
        "unresolved funding is treated as unknown and never counted as independent",
        "funding paths are inferred from a bounded recent transaction sample",
        "pool-vault classification remains conservative and no raw concentration veto is used",
      ],
    },
    holder_samples: samples,
  };
}
