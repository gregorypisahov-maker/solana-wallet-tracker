import { getSupabaseAdmin } from "../lib/supabase";
import { getJupiterQuote, JUPITER_SOL_MINT } from "../lib/jupiterQuote";
import {
  conservativeQuoteOutputRaw,
  conservativeSolProceeds,
  legOverheadSol,
} from "./liveCostSimulation";

const supabase = getSupabaseAdmin();
const DEX_URL = "https://api.dexscreener.com/tokens/v1/solana";
const WINDOWS_MINUTES = [1, 3, 5, 15, 30] as const;

function envNumber(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value == null || value.trim() === "") return fallback;
  return !["0", "false", "off", "no"].includes(value.trim().toLowerCase());
}

const CONFIG = {
  enabled: envBool("ENABLE_CANDIDATE_TRACKER", true),
  sampleIntervalMs: envNumber("CANDIDATE_TRACKER_SAMPLE_INTERVAL_MS", 20_000, 10_000, 300_000),
  stopPct: envNumber("CANDIDATE_TRACKER_STOP_PCT", 4, 0.5, 50),
  targetPct: envNumber("CANDIDATE_TRACKER_TARGET_PCT", 10, 0.5, 100),
  quoteAcceptedOnly: envBool("CANDIDATE_TRACKER_QUOTE_ACCEPTED_ONLY", true),
  quoteSizeSol: envNumber("CANDIDATE_TRACKER_QUOTE_SIZE_SOL", 0.2, 0.01, 10),
  slippageBps: Math.floor(envNumber("SNIPER_SLIPPAGE_BPS", 200, 10, 200)),
  retentionDays: Math.floor(envNumber("CANDIDATE_TRACKER_RETENTION_DAYS", 45, 7, 365)),
} as const;

export type CandidateObservationInput = {
  strategy: string;
  strategyVersion: string;
  mint: string;
  tokenSymbol?: string | null;
  pairAddress?: string | null;
  decision: "accepted" | "rejected";
  rejectReasons?: string[];
  score?: number | null;
  detectionPriceUsd?: number | null;
  liquidityUsd?: number | null;
  marketCapUsd?: number | null;
  poolAgeMinutes?: number | null;
  m5ChangePct?: number | null;
  m15ChangePct?: number | null;
  h1ChangePct?: number | null;
  volume5mUsd?: number | null;
  buySellRatio?: number | null;
  uniqueBuyers?: number | null;
  extra?: Record<string, unknown>;
};

let samplerRunning = false;
let maintenanceDate = "";

function n(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function rawSol(sol: number): string {
  return String(Math.max(1, Math.floor(sol * 1_000_000_000)));
}

async function fetchJson(url: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`http_${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function dexPair(mint: string, pairAddress?: string | null): Promise<any | null> {
  const rows = await fetchJson(`${DEX_URL}/${encodeURIComponent(mint)}`);
  const pairs = Array.isArray(rows) ? rows : [];
  return pairs.find((pair: any) => pair?.pairAddress === pairAddress) ??
    pairs
      .filter((pair: any) => pair?.chainId === "solana" && pair?.baseToken?.address === mint)
      .sort((a: any, b: any) => n(b?.liquidity?.usd) - n(a?.liquidity?.usd))[0] ?? null;
}

async function executableEconomics(input: CandidateObservationInput): Promise<{
  immediateRoundtripCostPct: number | null;
  quoteExtra: Record<string, unknown>;
}> {
  if (CONFIG.quoteAcceptedOnly && input.decision !== "accepted") {
    return { immediateRoundtripCostPct: null, quoteExtra: { execution_quote_status: "skipped_rejected" } };
  }

  const tradeInputSol = CONFIG.quoteSizeSol - legOverheadSol();
  if (tradeInputSol <= 0) {
    return { immediateRoundtripCostPct: null, quoteExtra: { execution_quote_status: "size_below_overhead" } };
  }

  try {
    const buy = await getJupiterQuote({
      inputMint: JUPITER_SOL_MINT,
      outputMint: input.mint,
      rawTokenAmount: rawSol(tradeInputSol),
      slippageBps: CONFIG.slippageBps,
    });
    if (!buy.route || buy.outLamports <= 0n) {
      return { immediateRoundtripCostPct: null, quoteExtra: { execution_quote_status: "no_buy_route" } };
    }

    const tokenRaw = conservativeQuoteOutputRaw(buy);
    if (tokenRaw <= 0n) {
      return { immediateRoundtripCostPct: null, quoteExtra: { execution_quote_status: "invalid_expected_buy_output" } };
    }

    const sell = await getJupiterQuote({
      inputMint: input.mint,
      outputMint: JUPITER_SOL_MINT,
      rawTokenAmount: tokenRaw.toString(),
      slippageBps: CONFIG.slippageBps,
    });
    if (!sell.route || sell.outLamports <= 0n) {
      return { immediateRoundtripCostPct: null, quoteExtra: { execution_quote_status: "no_sell_route" } };
    }

    const roundtripSol = conservativeSolProceeds(sell);
    const costPct = Math.max(0, (1 - roundtripSol / CONFIG.quoteSizeSol) * 100);
    return {
      immediateRoundtripCostPct: costPct,
      quoteExtra: {
        execution_quote_status: "quoted",
        quote_size_sol: CONFIG.quoteSizeSol,
        slippage_tolerance_bps: CONFIG.slippageBps,
        expected_roundtrip_sol: roundtripSol,
        buy_quote: buy.raw,
        sell_quote: sell.raw,
      },
    };
  } catch (error) {
    return {
      immediateRoundtripCostPct: null,
      quoteExtra: {
        execution_quote_status: "quote_error",
        execution_quote_error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function recordCandidateObservation(input: CandidateObservationInput): Promise<void> {
  if (!CONFIG.enabled) return;
  try {
    const cutoff = new Date(Date.now() - 50_000).toISOString();
    const { data: existing, error: existingError } = await supabase
      .from("candidate_observations")
      .select("id")
      .eq("strategy", input.strategy)
      .eq("strategy_version", input.strategyVersion)
      .eq("mint", input.mint)
      .gte("observed_at", cutoff)
      .limit(1);
    if (existingError) throw existingError;
    if (existing?.length) return;

    const economics = await executableEconomics(input);
    const marketCap = n(input.marketCapUsd, 0);
    const liquidity = n(input.liquidityUsd, 0);
    const now = new Date();
    const { error } = await supabase.from("candidate_observations").insert({
      observed_at: now.toISOString(),
      strategy: input.strategy,
      strategy_version: input.strategyVersion,
      mint: input.mint,
      token_symbol: input.tokenSymbol ?? null,
      pair_address: input.pairAddress ?? null,
      decision: input.decision,
      reject_reasons: input.rejectReasons ?? [],
      score: input.score ?? null,
      detection_price_usd: input.detectionPriceUsd ?? null,
      liquidity_usd: input.liquidityUsd ?? null,
      market_cap_usd: input.marketCapUsd ?? null,
      liq_to_mcap: marketCap > 0 ? liquidity / marketCap : null,
      pool_age_minutes: input.poolAgeMinutes ?? null,
      m5_change_pct: input.m5ChangePct ?? null,
      m15_change_pct: input.m15ChangePct ?? null,
      h1_change_pct: input.h1ChangePct ?? null,
      volume_5m_usd: input.volume5mUsd ?? null,
      buy_sell_ratio: input.buySellRatio ?? null,
      unique_buyers: input.uniqueBuyers ?? null,
      entry_exec_price_usd: null,
      immediate_roundtrip_cost_pct: economics.immediateRoundtripCostPct,
      status: "open",
      sample_index: 0,
      next_sample_due_at: new Date(now.getTime() + 60_000).toISOString(),
      extra: {
        ...(input.extra ?? {}),
        ...economics.quoteExtra,
        feature_schema_version: "candidate_features_v1_2026_08_05",
        execution_model_version: "champion_expected_fill_v1_2026_08_05",
        position_size_assumption_sol: CONFIG.quoteSizeSol,
        stop_pct: CONFIG.stopPct,
        target_pct: CONFIG.targetPct,
        stop_target_ordering: "sampled_not_exact",
        paper_only: true,
      },
    });
    if (error) throw error;
  } catch (error) {
    console.warn("[candidate-tracker] record failed", error);
  }
}

function sampleColumns(windowMinutes: number): { price: string; ret: string } {
  return { price: `price_${windowMinutes}m_usd`, ret: `ret_${windowMinutes}m_pct` };
}

async function sampleOne(row: any): Promise<void> {
  const index = Math.max(0, Math.floor(n(row.sample_index)));
  const windowMinutes = WINDOWS_MINUTES[index];
  if (!windowMinutes) return;

  const pair = await dexPair(row.mint, row.pair_address);
  const price = n(pair?.priceUsd, 0);
  const entry = n(row.detection_price_usd, 0);
  const ret = price > 0 && entry > 0 ? (price / entry - 1) * 100 : null;
  const columns = sampleColumns(windowMinutes);
  const nextIndex = index + 1;
  const isComplete = nextIndex >= WINDOWS_MINUTES.length;

  const returns = WINDOWS_MINUTES
    .map((minutes) => n(row[`ret_${minutes}m_pct`], NaN))
    .filter(Number.isFinite);
  if (ret != null) returns.push(ret);
  const mfe = returns.length ? Math.max(...returns) : null;
  const mae = returns.length ? Math.min(...returns) : null;
  const cost = n(row.immediate_roundtrip_cost_pct, 0);

  const update: Record<string, unknown> = {
    [columns.price]: price || null,
    [columns.ret]: ret,
    sample_index: nextIndex,
    became_untradable: !pair || price <= 0 || n(pair?.liquidity?.usd) <= 0,
    next_sample_due_at: isComplete
      ? new Date().toISOString()
      : new Date(Date.parse(row.observed_at) + WINDOWS_MINUTES[nextIndex] * 60_000).toISOString(),
  };

  if (isComplete || update.became_untradable) {
    update.status = "complete";
    update.completed_at = new Date().toISOString();
    update.mfe_pct = mfe;
    update.mae_pct = mae;
    update.would_target_fire = mfe != null ? mfe >= CONFIG.targetPct : null;
    update.would_stop_fire = mae != null ? mae <= -CONFIG.stopPct : null;
    update.best_window_net_after_cost_pct = mfe != null ? mfe - cost : null;
  }

  const { error } = await supabase.from("candidate_observations").update(update).eq("id", row.id);
  if (error) throw error;
}

async function maintenance(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  if (maintenanceDate === today) return;
  maintenanceDate = today;

  const { error: rollupError } = await supabase.rpc("refresh_candidate_observation_daily");
  if (rollupError) console.warn("[candidate-tracker] daily rollup failed", rollupError);

  const cutoff = new Date(Date.now() - CONFIG.retentionDays * 86_400_000).toISOString();
  const { error: deleteError } = await supabase
    .from("candidate_observations")
    .delete()
    .eq("status", "complete")
    .lt("completed_at", cutoff);
  if (deleteError) console.warn("[candidate-tracker] retention cleanup failed", deleteError);
}

async function runSampler(): Promise<void> {
  if (!CONFIG.enabled || samplerRunning) return;
  samplerRunning = true;
  try {
    const { data, error } = await supabase
      .from("candidate_observations")
      .select("*")
      .eq("status", "open")
      .lte("next_sample_due_at", new Date().toISOString())
      .order("next_sample_due_at", { ascending: true })
      .limit(25);
    if (error) throw error;

    for (const row of data ?? []) {
      try {
        await sampleOne(row);
      } catch (error) {
        console.warn(`[candidate-tracker] sample failed ${row.mint}`, error);
      }
    }
    await maintenance();
  } finally {
    samplerRunning = false;
  }
}

export function startCandidateOutcomeScheduler(): void {
  if (!CONFIG.enabled) {
    console.log("[candidate-tracker] disabled");
    return;
  }
  console.log(
    `[candidate-tracker] enabled windows=${WINDOWS_MINUTES.join(",")}m ` +
    `acceptedQuotesOnly=${CONFIG.quoteAcceptedOnly} retention=${CONFIG.retentionDays}d paperOnly=true`,
  );
  void runSampler().catch((error) => console.error("[candidate-tracker] initial sampler failed", error));
  setInterval(() => {
    void runSampler().catch((error) => console.error("[candidate-tracker] sampler failed", error));
  }, CONFIG.sampleIntervalMs);
}
