import { getSupabaseAdmin } from "../lib/supabase";

const supabase = getSupabaseAdmin();

function envNumber(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function resolvedPaperConfig(): Record<string, unknown> {
  return {
    positionSizeSol: envNumber("CHAMPION_PAPER_POSITION_SIZE_SOL", 0.2, 0.01, 10),
    maxConcurrent: Math.floor(envNumber("CHAMPION_PAPER_MAX_CONCURRENT", 3, 1, 20)),
    maxDailyEntries: Math.floor(envNumber("CHAMPION_PAPER_MAX_DAILY_ENTRIES", 15, 1, 200)),
    entryPollMs: envNumber("CHAMPION_PAPER_ENTRY_POLL_MS", 15_000, 5_000, 300_000),
    positionCheckMs: envNumber("CHAMPION_PAPER_POSITION_CHECK_MS", 5_000, 1_000, 60_000),
    targetPct: envNumber("CHAMPION_PAPER_TARGET_PCT", 10, 1, 100),
    hardStopPct: envNumber("CHAMPION_PAPER_HARD_STOP_PCT", 4, 0.5, 50),
    trailArmPct: envNumber("CHAMPION_PAPER_TRAIL_ARM_PCT", 6, 1, 100),
    trailGivebackPct: envNumber("CHAMPION_PAPER_TRAIL_GIVEBACK_PCT", 3, 0.5, 50),
    maxHoldSeconds: Math.floor(envNumber("CHAMPION_PAPER_MAX_HOLD_SECONDS", 1800, 60, 86_400)),
    minScore: envNumber("CHAMPION_PAPER_MIN_SCORE", 65, 0, 100),
    candidateMaxAgeSeconds: Math.floor(envNumber("CHAMPION_PAPER_CANDIDATE_MAX_AGE_SECONDS", 180, 30, 3600)),
    cooldownMinutes: Math.floor(envNumber("CHAMPION_PAPER_COOLDOWN_MINUTES", 180, 0, 10080)),
    maxRoundtripCostPct: envNumber("CHAMPION_PAPER_MAX_ROUNDTRIP_COST_PCT", 1.5, 0.1, 20),
    slippageBps: Math.floor(envNumber("SNIPER_SLIPPAGE_BPS", 200, 10, 200)),
    minLiquidityUsd: envNumber("CHAMPION_PAPER_MIN_LIQUIDITY_USD", 100_000, 10_000, 100_000_000),
  };
}

function resolvedResearchConfig(): Record<string, unknown> {
  return {
    scanMs: envNumber("CHAMPION_SCAN_INTERVAL_MS", 60_000, 30_000, 600_000),
    outcomeMs: envNumber("CHAMPION_OUTCOME_INTERVAL_MS", 30_000, 15_000, 300_000),
    maxPerScan: Math.floor(envNumber("CHAMPION_MAX_CANDIDATES_PER_SCAN", 30, 5, 100)),
    minLiquidityUsd: envNumber("CHAMPION_MIN_LIQUIDITY_USD", 100_000, 10_000, 100_000_000),
    minMarketCapUsd: envNumber("CHAMPION_MIN_MARKET_CAP_USD", 250_000, 10_000, 10_000_000_000),
    maxMarketCapUsd: envNumber("CHAMPION_MAX_MARKET_CAP_USD", 20_000_000, 20_000, 100_000_000_000),
    minPoolAgeMinutes: envNumber("CHAMPION_MIN_POOL_AGE_MINUTES", 360, 15, 525_600),
    targetPct: envNumber("CHAMPION_RESEARCH_TARGET_PCT", 10, 0.5, 100),
    stopPct: envNumber("CHAMPION_RESEARCH_STOP_PCT", 4, 0.5, 100),
    minScore: envNumber("CHAMPION_MIN_SCORE", 60, 0, 100),
  };
}

export async function enforceChampionStrategyFreeze(): Promise<void> {
  const { data, error } = await supabase
    .from("champion_strategy_lock")
    .select("locked,locked_until,reason,champion_paper_version,champion_research_version,paper_config,research_config")
    .eq("id", 1)
    .single();

  if (error) throw new Error(`champion_strategy_lock_read_failed:${error.message}`);
  const active = Boolean(data?.locked && Date.parse(data.locked_until) > Date.now());
  if (!active) {
    console.log(`[champion-lock] inactive expired=${data?.locked_until ?? "unknown"}`);
    return;
  }

  const expectedPaperVersion = "champion_paper_v1_2026_08_05";
  const expectedResearchVersion = "champion_research_v1_2026_08_05";
  const paperVersionMatches = data.champion_paper_version === expectedPaperVersion;
  const researchVersionMatches = data.champion_research_version === expectedResearchVersion;
  const paperConfigMatches = canonical(resolvedPaperConfig()) === canonical(data.paper_config);
  const researchConfigMatches = canonical(resolvedResearchConfig()) === canonical(data.research_config);

  if (!paperVersionMatches || !researchVersionMatches || !paperConfigMatches || !researchConfigMatches) {
    const reason = [
      "champion_strategy_lock_violation",
      `locked_until=${data.locked_until}`,
      `paper_version_match=${paperVersionMatches}`,
      `research_version_match=${researchVersionMatches}`,
      `paper_config_match=${paperConfigMatches}`,
      `research_config_match=${researchConfigMatches}`,
    ].join(";");

    const now = new Date().toISOString();
    await Promise.all([
      supabase.from("champion_paper_state").update({
        halted: true,
        halt_reason: reason,
        updated_at: now,
      }).eq("id", 1),
      supabase.from("champion_strategy_state").update({
        halt_reason: reason,
        updated_at: now,
      }).eq("id", 1),
    ]);
    throw new Error(reason);
  }

  console.log(
    `[champion-lock] enforced paper=${expectedPaperVersion} research=${expectedResearchVersion} ` +
    `lockedUntil=${data.locked_until} reason=${data.reason}`,
  );
}
