import { getSupabaseAdmin } from "../lib/supabase";
import { intelligenceConfig as config } from "./config";

const supabase = getSupabaseAdmin();
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";
const HELIUS_RPC_URL = process.env.HELIUS_RPC_URL || (HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : "");
const VERSION = "helius_intelligence_shadow_v1_1_2026_07_29";
let running = false;

function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function startOfHour() { const d = new Date(); d.setMinutes(0, 0, 0); return d.toISOString(); }
function startOfDay() { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.toISOString(); }
function startOfMonth() { const d = new Date(); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0); return d.toISOString(); }

async function usageSince(since: string): Promise<number> {
  const { data, error } = await supabase.from("helius_credit_usage").select("estimated_credits").gte("created_at", since);
  if (error) throw error;
  return (data || []).reduce((sum, row: any) => sum + Number(row.estimated_credits || 0), 0);
}

async function analysesThisHour(): Promise<number> {
  const { count, error } = await supabase.from("token_intelligence_snapshots")
    .select("id", { count: "exact", head: true }).gte("observed_at", startOfHour());
  if (error) throw error;
  return count || 0;
}

async function budgetState() {
  const [hour, day, month, analyses] = await Promise.all([
    usageSince(startOfHour()), usageSince(startOfDay()), usageSince(startOfMonth()), analysesThisHour(),
  ]);
  const ratio = Math.max(hour / config.hourlyCreditLimit, day / config.dailyCreditLimit, month / config.monthlyCreditLimit);
  const analysisCapReached = analyses >= config.maxDeepAnalysesPerHour;
  return { hour, day, month, analyses, ratio, analysisCapReached, stopped: ratio >= config.stopRatio, reduced: ratio >= config.reduceRatio };
}

async function recordUsage(operation: string, mint: string, estimatedCredits = 1) {
  const { error } = await supabase.from("helius_credit_usage").insert({ service: VERSION, operation, mint, estimated_credits: estimatedCredits });
  if (error) throw error;
}

async function heliusRpc<T>(method: string, params: unknown[], mint: string, estimatedCredits = 1): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetch(HELIUS_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: `${Date.now()}`, method, params }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`helius_http_${response.status}`);
    const body: any = await response.json();
    if (body.error) throw new Error(`helius_rpc_${body.error.code || "unknown"}`);
    await recordUsage(method, mint, estimatedCredits);
    return body.result as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function alreadyFresh(mint: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - config.cacheTtlSeconds * 1000).toISOString();
  const { data, error } = await supabase.from("token_intelligence_snapshots").select("id").eq("mint", mint).gte("observed_at", cutoff).limit(1);
  if (error) throw error;
  return Boolean(data?.length);
}

async function analyze(candidate: any, reduced: boolean) {
  const mint = String(candidate.mint || "");
  if (!mint || await alreadyFresh(mint)) return;

  const largest = await heliusRpc<any>("getTokenLargestAccounts", [mint, { commitment: "confirmed" }], mint, 1);
  const values = Array.isArray(largest?.value) ? largest.value : [];
  const amounts = values.map((x: any) => Number(x.uiAmountString || x.uiAmount || 0)).filter(Number.isFinite);
  const totalTop = amounts.reduce((a: number, b: number) => a + b, 0);
  const top1Share = totalTop > 0 ? amounts[0] / totalTop : null;
  const top5Share = totalTop > 0 ? amounts.slice(0, 5).reduce((a: number, b: number) => a + b, 0) / totalTop : null;

  let asset: any = null;
  if (!reduced) {
    try { asset = await heliusRpc<any>("getAsset", [{ id: mint }], mint, 1); }
    catch (error) { console.warn("[helius-intelligence] getAsset failed", mint, error); }
  }

  const snapshot = {
    model_version: VERSION,
    signal_version: "placeholder_not_tradeable",
    trade_eligible: false,
    source_score: Number(candidate.score || 0),
    source_status: candidate.status,
    source_market_regime: candidate.market_regime,
    liquidity_usd: Number(candidate.liquidity_usd || 0),
    market_cap_usd: Number(candidate.market_cap_usd || 0),
    top_accounts_count: amounts.length,
    raw_top1_share_of_top_accounts: top1Share,
    raw_top5_share_of_top_accounts: top5Share,
    raw_holder_warning: top1Share !== null && top1Share > 0.55,
    mutable: asset?.mutable ?? null,
    authorities: asset?.authorities ?? null,
    reduced_mode: reduced,
    missing_for_trade_eligibility: [
      "classified_pool_vaults_and_burn_accounts",
      "independent_buyer_count",
      "shared_funder_cluster_ratio",
      "creator_linked_flow",
      "net_sol_inflow_window",
      "early_wallet_sell_pressure",
    ],
    note: "Observation plumbing only. Raw largest-account concentration is noisy and is not a trading signal.",
  };

  const { error } = await supabase.from("token_intelligence_snapshots").insert({
    mint,
    symbol: candidate.token_symbol,
    pair_address: candidate.pair_address,
    observed_at: new Date().toISOString(),
    mode: config.mode,
    recommendation: "observation_only",
    snapshot,
  });
  if (error) throw error;
}

async function cycle() {
  if (running || config.mode === "off") return;
  running = true;
  try {
    if (!HELIUS_RPC_URL) throw new Error("HELIUS_API_KEY_or_HELIUS_RPC_URL_missing");
    const budget = await budgetState();
    const status = budget.stopped ? "credit_stop" : budget.analysisCapReached ? "hourly_analysis_cap" : budget.reduced ? "reduced" : "active";
    await supabase.from("intelligence_worker_state").upsert({
      service: VERSION,
      mode: config.mode,
      status,
      hourly_credits: budget.hour,
      daily_credits: budget.day,
      monthly_credits: budget.month,
      last_heartbeat_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      details: {
        limits: { hourly: config.hourlyCreditLimit, daily: config.dailyCreditLimit, monthly: config.monthlyCreditLimit, analyses_per_hour: config.maxDeepAnalysesPerHour },
        usage: { analyses_this_hour: budget.analyses },
        ratio: budget.ratio,
      },
    }, { onConflict: "service" });
    if (budget.stopped || budget.analysisCapReached) return;

    const cutoff = new Date(Date.now() - config.candidateMaxAgeMinutes * 60_000).toISOString();
    const remainingAnalysisSlots = Math.max(0, config.maxDeepAnalysesPerHour - budget.analyses);
    const limit = Math.min(budget.reduced ? 1 : config.maxCandidatesPerCycle, remainingAnalysisSlots);
    if (limit < 1) return;

    const { data, error } = await supabase.from("market_opportunities")
      .select("mint,token_symbol,pair_address,score,status,market_regime,liquidity_usd,market_cap_usd,last_seen_at")
      .gte("score", config.minimumAiScore).gte("last_seen_at", cutoff).order("score", { ascending: false }).limit(limit);
    if (error) throw error;
    for (const candidate of data || []) {
      try { await analyze(candidate, budget.reduced); }
      catch (error) { console.error("[helius-intelligence] candidate failed", candidate.mint, error); }
    }
  } catch (error) {
    console.error("[helius-intelligence] cycle failed", error);
  } finally {
    running = false;
  }
}

async function main() {
  console.log(`[helius-intelligence] ${VERSION} mode=${config.mode}`);
  if (config.mode === "enforce") console.warn("[helius-intelligence] ENFORCE is intentionally observation-only in v1");
  while (true) { await cycle(); await sleep(config.pollMs); }
}

main().catch((error) => { console.error("[helius-intelligence] fatal", error); process.exit(1); });
