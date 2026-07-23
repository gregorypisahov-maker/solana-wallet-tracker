import fs from "node:fs";

function patch(path, replacements) {
  let text = fs.readFileSync(path, "utf8");
  for (const [from, to] of replacements) {
    if (!text.includes(from)) {
      console.warn(`[patch-ai-discovery-dashboard] pattern missing in ${path}: ${from.slice(0, 90)}`);
      continue;
    }
    text = text.replace(from, to);
  }
  fs.writeFileSync(path, text);
}

patch("app/api/compact-dashboard/route.ts", [
  [
`    scalpState, scalpPositions, scalpTrades, scalpScans,
    wallets, walletPerformance, tokenScores, readiness, adaptive, usage,`,
`    scalpState, scalpPositions, scalpTrades, scalpScans,
    aiState, aiPositions, aiTrades, marketOpportunities, marketRuns,
    wallets, walletPerformance, tokenScores, readiness, adaptive, usage,`
  ],
  [
`    supabase.from("scalp_scan_runs").select("*").order("started_at", { ascending: false }).limit(20),
    supabase.from("wallets")`,
`    supabase.from("scalp_scan_runs").select("*").order("started_at", { ascending: false }).limit(20),
    supabase.from("ai_discovery_state").select("*").eq("id", 1).maybeSingle(),
    supabase.from("ai_discovery_positions").select("*").order("opened_at", { ascending: false }),
    supabase.from("ai_discovery_trades").select("*").order("closed_at", { ascending: false }).limit(500),
    supabase.from("market_opportunities").select("*").order("score", { ascending: false }).limit(25),
    supabase.from("market_discovery_runs").select("*").order("started_at", { ascending: false }).limit(20),
    supabase.from("wallets")`
  ],
  [
`  const results = { paperState, paperPositions, paperTrades, shadowState, shadowPositions, shadowTrades, scalpState, scalpPositions, scalpTrades, scalpScans, wallets, walletPerformance, tokenScores, readiness, adaptive, usage };`,
`  const results = { paperState, paperPositions, paperTrades, shadowState, shadowPositions, shadowTrades, scalpState, scalpPositions, scalpTrades, scalpScans, aiState, aiPositions, aiTrades, marketOpportunities, marketRuns, wallets, walletPerformance, tokenScores, readiness, adaptive, usage };`
  ],
  [
`  const scalper = summarize(scalpTrades.data ?? [], "pnl_sol", "closed_at");`,
`  const scalper = summarize(scalpTrades.data ?? [], "pnl_sol", "closed_at");
  const aiDiscovery = summarize(aiTrades.data ?? [], "pnl_sol", "closed_at");`
  ],
  [
`  const latestScalpScan = scalpScans.data?.[0] ?? null;`,
`  const latestScalpScan = scalpScans.data?.[0] ?? null;
  const latestMarketRun = marketRuns.data?.[0] ?? null;`
  ],
  [
`    {
      id: "shadow",`,
`    {
      id: "ai-discovery",
      name: "AI Discovery Bot",
      subtitle: "Market-wide signals · independent paper execution",
      version: "ai_discovery_trader_v1_2026_07_24",
      state: {
        ...(aiState.data ?? {}),
        marketRegime: latestMarketRun?.market_regime ?? null,
        scannedCount: latestMarketRun?.scanned_count ?? 0,
        topSymbol: latestMarketRun?.top_symbol ?? null,
        topScore: latestMarketRun?.top_score ?? null,
      },
      bankrollSol: Number(aiState.data?.bankroll_sol ?? 0),
      startingBankrollSol: Number(aiState.data?.starting_bankroll_sol ?? 1),
      lastScanAt: newest(aiState.data?.last_scan_at, latestMarketRun?.started_at, aiDiscovery.recentTrades[0]?.happenedAt),
      positions: aiPositions.data ?? [],
      openPositions: (aiPositions.data ?? []).length,
      ...aiDiscovery,
      maxDrawdownSol: drawdown(aiDiscovery.recentTrades),
    },
    {
      id: "shadow",`
  ],
  [
`    scalpIntelligence: {
      latestScan: latestScalpScan,`,
`    marketDiscovery: {
      latestRun: latestMarketRun,
      recentRuns: marketRuns.data ?? [],
      opportunities: marketOpportunities.data ?? [],
      rules: {
        paperOnly: true,
        minScore: 82,
        fixedSizeSol: 0.1,
        maxDailyEntries: 4,
        maxConcurrentPositions: 1,
      },
    },
    scalpIntelligence: {
      latestScan: latestScalpScan,`
  ],
]);

patch("app/page.tsx", [
  [`type BotId = "legion" | "scalper" | "shadow";`, `type BotId = "legion" | "scalper" | "ai-discovery" | "shadow";`],
  [
'  return <div className={`v2Icon ${id}`}>{id === "legion" ? "L" : id === "scalper" ? "ϟ" : "◆"}</div>;',
'  return <div className={`v2Icon ${id}`}>{id === "legion" ? "L" : id === "scalper" ? "ϟ" : id === "ai-discovery" ? "AI" : "◆"}</div>;'
  ],
  [`sub="Across 3 paper strategies"`, 'sub={`Across ${data.bots.length} paper strategies`}'],
  [`sub="The three paper strategies currently measured"`, `sub="All paper strategies currently measured"`],
  [`<p>Performance and live position status for every paper bot.</p>`, `<p>Performance, live positions and independent market-discovery status for every paper bot.</p>`],
  [`<p>Completed positions across all three strategies, with bot and trade time.</p>`, `<p>Completed positions across all strategies, with bot and trade time.</p>`],
]);

patch("app/api/bot-control/route.ts", [
  [`type BotId = "legion" | "shadow";`, `type BotId = "legion" | "ai-discovery" | "shadow";`],
  [`if (!['legion', 'shadow'].includes(bot)`, `if (!['legion', 'ai-discovery', 'shadow'].includes(bot)`],
  [
`  } else {
    const result = await supabase
      .from("shadow_strategy_state")`,
`  } else if (bot === "ai-discovery") {
    const result = await supabase
      .from("ai_discovery_state")
      .update(action === "resume"
        ? { enabled: true, halted: false, halt_reason: null, consecutive_losses: 0, updated_at: now }
        : { enabled: false, halt_reason: "manual_dashboard_pause", updated_at: now })
      .eq("id", 1)
      .select("*")
      .single();
    data = result.data;
    error = result.error;
  } else {
    const result = await supabase
      .from("shadow_strategy_state")`
  ],
]);

console.log("[patch-ai-discovery-dashboard] applied");
