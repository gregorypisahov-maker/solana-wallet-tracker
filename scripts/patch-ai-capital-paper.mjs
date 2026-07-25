import fs from "node:fs";

function patch(path, replacements) {
  let text = fs.readFileSync(path, "utf8");
  let changed = false;
  for (const replacement of replacements) {
    const { from, to, marker } = replacement;
    if (marker && text.includes(marker)) continue;
    if (!text.includes(from)) {
      console.warn(`[patch-ai-capital-paper] pattern missing in ${path}: ${from.slice(0, 100)}`);
      continue;
    }
    text = text.replace(from, to);
    changed = true;
  }
  if (changed) fs.writeFileSync(path, text);
}

patch("worker/workerEntrypoint.ts", [
  {
    from: 'import { startAiDiscoveryTrader } from "../paper-trader/aiDiscoveryTrader";',
    to: 'import { startAiDiscoveryTrader } from "../paper-trader/aiDiscoveryTrader";\nimport { startAiCapitalMirror } from "../paper-trader/aiCapitalMirror";',
    marker: 'startAiCapitalMirror',
  },
  {
    from: 'startAiDiscoveryTrader();',
    to: 'startAiDiscoveryTrader();\nstartAiCapitalMirror();',
    marker: 'startAiCapitalMirror();',
  },
]);

patch("worker/telegramBot.ts", [
  {
    from: 'import { handleAiStats } from "../paper-trader/aiDiscoveryStats";',
    to: 'import { handleAiStats } from "../paper-trader/aiDiscoveryStats";\nimport { handleAiCapitalStats } from "../paper-trader/aiCapitalStats";',
    marker: 'handleAiCapitalStats',
  },
  {
    from: '    "/aistats — AI discovery paper trading performance",',
    to: '    "/aistats — AI discovery paper trading performance",\n    "/aicapital — 5× AI paper mirror performance",',
    marker: '"/aicapital — 5× AI paper mirror performance"',
  },
  {
    from: '    [{ text: "🧠 AI Stats", callback_data: "/aistats" }, { text: "📉 Binance Paper", callback_data: "/binancestats" }],',
    to: '    [{ text: "🧠 AI Stats", callback_data: "/aistats" }, { text: "💰 AI Capital", callback_data: "/aicapital" }],\n    [{ text: "📉 Binance Paper", callback_data: "/binancestats" }],',
    marker: 'callback_data: "/aicapital"',
  },
  {
    from: '  "/aidiscovery": handleAiStats,',
    to: '  "/aidiscovery": handleAiStats,\n  "/aicapital": handleAiCapitalStats,\n  "/ai_capital": handleAiCapitalStats,\n  "/capitalstats": handleAiCapitalStats,',
    marker: '"/aicapital": handleAiCapitalStats',
  },
]);

const compactPath = "app/api/compact-dashboard/route.ts";
const compact = fs.readFileSync(compactPath, "utf8");
if (compact.includes('aiState, aiPositions, aiTrades')) {
  patch(compactPath, [
    {
      from: '    aiState, aiPositions, aiTrades, marketOpportunities, marketRuns,\n    wallets, walletPerformance, tokenScores, readiness, adaptive, usage,',
      to: '    aiState, aiPositions, aiTrades,\n    aiCapitalState, aiCapitalPositions, aiCapitalTrades,\n    marketOpportunities, marketRuns,\n    wallets, walletPerformance, tokenScores, readiness, adaptive, usage,',
      marker: 'aiCapitalState, aiCapitalPositions, aiCapitalTrades',
    },
    {
      from: '    supabase.from("ai_discovery_trades").select("*").order("closed_at", { ascending: false }).limit(500),\n    supabase.from("market_opportunities")',
      to: '    supabase.from("ai_discovery_trades").select("*").order("closed_at", { ascending: false }).limit(500),\n    supabase.from("ai_capital_state").select("*").eq("id", 1).maybeSingle(),\n    supabase.from("ai_capital_positions").select("*").order("opened_at", { ascending: false }),\n    supabase.from("ai_capital_trades").select("*").order("closed_at", { ascending: false }).limit(500),\n    supabase.from("market_opportunities")',
      marker: 'supabase.from("ai_capital_state")',
    },
    {
      from: 'scalpScans, aiState, aiPositions, aiTrades, marketOpportunities, marketRuns, wallets,',
      to: 'scalpScans, aiState, aiPositions, aiTrades, aiCapitalState, aiCapitalPositions, aiCapitalTrades, marketOpportunities, marketRuns, wallets,',
      marker: 'aiTrades, aiCapitalState, aiCapitalPositions, aiCapitalTrades, marketOpportunities',
    },
    {
      from: '  const aiDiscovery = summarize(aiTrades.data ?? [], "pnl_sol", "closed_at");',
      to: '  const aiDiscovery = summarize(aiTrades.data ?? [], "pnl_sol", "closed_at");\n  const aiCapital = summarize(aiCapitalTrades.data ?? [], "pnl_sol", "closed_at");',
      marker: 'const aiCapital = summarize',
    },
    {
      from: '    {\n      id: "shadow",',
      to: `    {
      id: "ai-capital",
      name: "AI Capital",
      subtitle: "Same AI trades · 5× paper sizing",
      version: "ai_capital_paper_mirror_v1_2026_07_25",
      state: aiCapitalState.data,
      bankrollSol: Number(aiCapitalState.data?.bankroll_sol ?? 0),
      startingBankrollSol: Number(aiCapitalState.data?.starting_bankroll_sol ?? 5),
      lastScanAt: newest(aiCapitalState.data?.last_sync_at, aiCapital.recentTrades[0]?.happenedAt),
      positions: aiCapitalPositions.data ?? [],
      openPositions: (aiCapitalPositions.data ?? []).length,
      ...aiCapital,
      maxDrawdownSol: drawdown(aiCapital.recentTrades),
    },
    {
      id: "shadow",`,
      marker: 'id: "ai-capital"',
    },
  ]);
} else {
  console.log("[patch-ai-capital-paper] Dashboard AI discovery patch not present in this runtime; dashboard patch skipped.");
}

patch("app/page.tsx", [
  {
    from: 'type BotId = "legion" | "scalper" | "ai-discovery" | "shadow";',
    to: 'type BotId = "legion" | "scalper" | "ai-discovery" | "ai-capital" | "shadow";',
    marker: '| "ai-capital" |',
  },
  {
    from: 'id === "ai-discovery" ? "AI" : "◆"',
    to: 'id === "ai-discovery" ? "AI" : id === "ai-capital" ? "5×" : "◆"',
    marker: 'id === "ai-capital" ? "5×"',
  },
]);

patch("app/platform-v2.css", [
  {
    from: '.v2Chart.shadow{color:var(--purple)}',
    to: '.v2Chart.shadow{color:var(--purple)}.v2Chart.ai-discovery{color:var(--blue)}.v2Chart.ai-capital{color:var(--amber)}',
    marker: '.v2Chart.ai-capital',
  },
  {
    from: '.v2Icon.shadow{background:rgba(156,125,255,.12);color:var(--purple)}',
    to: '.v2Icon.shadow{background:rgba(156,125,255,.12);color:var(--purple)}.v2Icon.ai-discovery{background:rgba(100,168,255,.12);color:var(--blue);font-size:12px}.v2Icon.ai-capital{background:rgba(240,180,77,.12);color:var(--amber);font-size:12px}',
    marker: '.v2Icon.ai-capital',
  },
]);

const controlPath = "app/api/bot-control/route.ts";
const control = fs.readFileSync(controlPath, "utf8");
if (control.includes('"ai-discovery"')) {
  patch(controlPath, [
    {
      from: 'type BotId = "legion" | "ai-discovery" | "shadow";',
      to: 'type BotId = "legion" | "ai-discovery" | "ai-capital" | "shadow";',
      marker: '| "ai-capital" |',
    },
    {
      from: "if (!['legion', 'ai-discovery', 'shadow'].includes(bot)",
      to: "if (!['legion', 'ai-discovery', 'ai-capital', 'shadow'].includes(bot)",
      marker: "'ai-capital', 'shadow'",
    },
    {
      from: `  } else {
    const result = await supabase
      .from("shadow_strategy_state")`,
      to: `  } else if (bot === "ai-capital") {
    const result = await supabase
      .from("ai_capital_state")
      .update(action === "resume"
        ? { enabled: true, halted: false, halt_reason: null, consecutive_losses: 0, updated_at: now }
        : { enabled: false, halted: true, halt_reason: "manual_dashboard_pause", updated_at: now })
      .eq("id", 1)
      .select("*")
      .single();
    data = result.data;
    error = result.error;
  } else {
    const result = await supabase
      .from("shadow_strategy_state")`,
      marker: 'bot === "ai-capital"',
    },
  ]);
} else {
  console.log("[patch-ai-capital-paper] Dashboard control AI patch not present in this runtime; control patch skipped.");
}

console.log("[patch-ai-capital-paper] applied");
