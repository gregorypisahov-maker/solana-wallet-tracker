export type RpcCall = <T>(method: string, params: unknown[], mint: string, estimatedCredits?: number) => Promise<T>;

export type HolderSample = {
  token_account: string;
  owner: string | null;
  amount: number;
  funding_source: string | null;
  recent_sol_delta: number | null;
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

  const ownerSet = new Set(sampled.map((x) => x.owner));
  const funded = sampled.filter((x) => x.funding_source);
  const fundingCounts = new Map<string, number>();
  for (const row of funded) fundingCounts.set(row.funding_source!, (fundingCounts.get(row.funding_source!) || 0) + 1);
  const largestFundingCluster = Math.max(0, ...fundingCounts.values());
  const sharedFunderClusterRatio = funded.length ? largestFundingCluster / funded.length : null;
  const independentBuyerRatio = sampled.length ? ownerSet.size / sampled.length : null;

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
  if (funded.length < 4) missing.push("minimum_four_funding_paths");
  if (!input.previousSnapshot) missing.push("second_time_series_snapshot");
  if (netTopHolderFlowRatio === null) missing.push("net_holder_flow_window");
  if (earlyWalletSellPressure === null) missing.push("early_wallet_sell_pressure_window");
  if (netSolFlowSample === null) missing.push("recent_sol_flow_sample");

  let score = 50;
  if (independentBuyerRatio !== null) score += (independentBuyerRatio - 0.7) * 30;
  if (sharedFunderClusterRatio !== null) score += (0.35 - sharedFunderClusterRatio) * 35;
  if (netTopHolderFlowRatio !== null) score += clamp(netTopHolderFlowRatio, -0.5, 0.5) * 30;
  if (earlyWalletSellPressure !== null) score -= clamp(earlyWalletSellPressure, 0, 1) * 35;
  score -= creatorLinkedOwners * 15;
  score -= creatorLinkedFunding * 12;
  score = Math.round(Math.min(100, Math.max(0, score)));

  const reasons: string[] = [];
  if ((independentBuyerRatio ?? 0) >= 0.8) reasons.push("buyers_appear_independent");
  if (sharedFunderClusterRatio !== null && sharedFunderClusterRatio <= 0.35) reasons.push("no_dominant_shared_funder_cluster");
  if ((netTopHolderFlowRatio ?? -1) > 0.03) reasons.push("positive_holder_flow_window");
  if ((earlyWalletSellPressure ?? 1) < 0.12) reasons.push("low_early_wallet_sell_pressure");
  if (creatorLinkedOwners === 0 && creatorLinkedFunding === 0) reasons.push("no_creator_linked_sample_flow");

  const tradeEligible = missing.length === 0
    && score >= 72
    && (independentBuyerRatio ?? 0) >= 0.75
    && (sharedFunderClusterRatio ?? 1) <= 0.4
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
      independent_buyer_count: ownerSet.size,
      independent_buyer_ratio: independentBuyerRatio,
      funding_paths_observed: funded.length,
      largest_shared_funder_cluster: largestFundingCluster,
      shared_funder_cluster_ratio: sharedFunderClusterRatio,
      creator_linked_owner_count: creatorLinkedOwners,
      creator_linked_funding_count: creatorLinkedFunding,
      net_top_holder_flow_ratio: netTopHolderFlowRatio,
      recent_net_sol_delta_sample: netSolFlowSample,
      early_wallet_sell_pressure: earlyWalletSellPressure,
      time_series_ready: Boolean(input.previousSnapshot),
      limitations: [
        "holder-flow is a sampled top-holder proxy, not full market-wide order flow",
        "funding paths are inferred from a bounded recent transaction sample",
        "pool-vault classification remains conservative and no raw concentration veto is used",
      ],
    },
    holder_samples: samples,
  };
}
