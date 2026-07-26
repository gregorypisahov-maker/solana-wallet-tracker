import fs from "node:fs";

function patch(path, replacements) {
  let text = fs.readFileSync(path, "utf8");
  let changed = false;
  for (const { from, to, marker } of replacements) {
    if (marker && text.includes(marker)) continue;
    if (!text.includes(from)) {
      console.warn(`[patch-ai-entry-latency] pattern missing in ${path}: ${String(from).slice(0, 100)}`);
      continue;
    }
    text = text.replace(from, to);
    changed = true;
  }
  if (changed) fs.writeFileSync(path, text);
}

patch("paper-trader/marketDiscoveryAgent.ts", [
  {
    from: "const DEFAULT_INTERVAL_MS = 30_000;",
    to: "const DEFAULT_INTERVAL_MS = 60_000;",
    marker: "const DEFAULT_INTERVAL_MS = 60_000;",
  },
  {
    from: "signal_snapshot: { version: VERSION, buyRatio: item.buysM5 / Math.max(1, item.buysM5 + item.sellsM5) },",
    to: "signal_snapshot: { version: VERSION, buyRatio: item.buysM5 / Math.max(1, item.buysM5 + item.sellsM5), timing: { discoveryScanStartedAt: startedAt, opportunityPersistedAt: now, discoveryPipelineMs: Math.max(0, Date.parse(now) - Date.parse(startedAt)) } },",
    marker: "discoveryPipelineMs:",
  },
  {
    from: "console.log(`[market-discovery-ai] scanned ${candidates.length}; regime ${marketRegime}; top ${top ? `${top.symbol} ${top.score}/100` : \"none\"}`);",
    to: "console.log(`[market-discovery-ai] scanned ${candidates.length}; regime ${marketRegime}; top ${top ? `${top.symbol} ${top.score}/100` : \"none\"}; pipelineMs=${Math.max(0, Date.now() - Date.parse(startedAt))}`);",
    marker: "pipelineMs=${Math.max(0, Date.now() - Date.parse(startedAt))}",
  },
]);

patch("paper-trader/aiDiscoveryTrader.ts", [
  {
    from: "async function fetchJson(url: string, priority = FetchPriority.NORMAL): Promise<any> { return fetchJsonQueued(url, { priority, timeoutMs: REQUEST_TIMEOUT_MS, headers: { Accept: \"application/json\" } }); }",
    to: "async function fetchJson(url: string, priority = FetchPriority.NORMAL, cacheTtlMs?: number): Promise<any> { return fetchJsonQueued(url, { priority, timeoutMs: REQUEST_TIMEOUT_MS, cacheTtlMs, headers: { Accept: \"application/json\" } }); }",
    marker: "cacheTtlMs?: number",
  },
  {
    from: "const body = await fetchJson(`${DEX_URL}/${encodeURIComponent(mint)}`, priority);",
    to: "const body = await fetchJson(`${DEX_URL}/${encodeURIComponent(mint)}`, priority, priority === FetchPriority.HIGH ? 0 : undefined);",
    marker: "priority === FetchPriority.HIGH ? 0",
  },
  {
    from: "const snapshot = { version: VERSION, opportunity, market, observationId, friction: { entryPct: ENTRY_FRICTION_PCT, exitPct: EXIT_FRICTION_PCT } };",
    to: "const opportunitySeenAt = String(opportunity.last_seen_at ?? now); const entryDelayMs = Math.max(0, Date.parse(now) - Date.parse(opportunitySeenAt)); const snapshot = { version: VERSION, opportunity, market, observationId, timing: { discoveryScanStartedAt: opportunity.signal_snapshot?.timing?.discoveryScanStartedAt ?? null, opportunityPersistedAt: opportunity.signal_snapshot?.timing?.opportunityPersistedAt ?? opportunitySeenAt, opportunityLastSeenAt: opportunitySeenAt, entryOpenedAt: now, discoveryPipelineMs: opportunity.signal_snapshot?.timing?.discoveryPipelineMs ?? null, opportunityToEntryMs: entryDelayMs }, friction: { entryPct: ENTRY_FRICTION_PCT, exitPct: EXIT_FRICTION_PCT } }; console.log(`[ai-discovery-trader] entry timing ${opportunity.token_symbol}: opportunityToEntryMs=${entryDelayMs} discoveryPipelineMs=${snapshot.timing.discoveryPipelineMs ?? \"unknown\"}`);",
    marker: "opportunityToEntryMs:",
  },
  {
    from: "const market = await priceFor(opportunity.mint, opportunity.pair_address, FetchPriority.NORMAL);",
    to: "const market = await priceFor(opportunity.mint, opportunity.pair_address, FetchPriority.HIGH);",
    marker: "priceFor(opportunity.mint, opportunity.pair_address, FetchPriority.HIGH)",
  },
  {
    from: "setInterval(() => void scanEntries().catch((error) => console.error(\"[ai-discovery-trader] scan failed\", error)), 30_000);",
    to: "setInterval(() => void scanEntries().catch((error) => console.error(\"[ai-discovery-trader] scan failed\", error)), 60_000);",
    marker: "scanEntries().catch((error) => console.error(\"[ai-discovery-trader] scan failed\", error)), 60_000",
  },
]);

patch("paper-trader/fetchQueue.ts", [
  {
    from: "const MAX_CONCURRENT = Math.max(1, Math.floor(envNumber(\"FETCH_MAX_CONCURRENT_PER_HOST\", 2, 1)));",
    to: "const MAX_CONCURRENT = Math.max(1, Math.floor(envNumber(\"FETCH_MAX_CONCURRENT_PER_HOST\", 1, 1)));",
    marker: "FETCH_MAX_CONCURRENT_PER_HOST\", 1",
  },
  {
    from: "const MIN_INTERVAL_MS = envNumber(\"FETCH_MIN_INTERVAL_MS\", 350, 0);",
    to: "const MIN_INTERVAL_MS = envNumber(\"FETCH_MIN_INTERVAL_MS\", 1_000, 0);",
    marker: "FETCH_MIN_INTERVAL_MS\", 1_000",
  },
  {
    from: "const MAX_RETRIES = Math.floor(envNumber(\"FETCH_MAX_RETRIES\", 3, 0));",
    to: "const MAX_RETRIES = Math.floor(envNumber(\"FETCH_MAX_RETRIES\", 1, 0));",
    marker: "FETCH_MAX_RETRIES\", 1",
  },
  {
    from: "const CACHE_TTL_MS = envNumber(\"FETCH_CACHE_TTL_MS\", 8_000, 0);",
    to: "const CACHE_TTL_MS = envNumber(\"FETCH_CACHE_TTL_MS\", 30_000, 0);",
    marker: "FETCH_CACHE_TTL_MS\", 30_000",
  },
  {
    from: "const ADAPTIVE_MULTIPLIER = envNumber(\"FETCH_ADAPTIVE_429_MULTIPLIER\", 2, 1);",
    to: "const ADAPTIVE_MULTIPLIER = envNumber(\"FETCH_ADAPTIVE_429_MULTIPLIER\", 5, 1);",
    marker: "FETCH_ADAPTIVE_429_MULTIPLIER\", 5",
  },
  {
    from: "const ADAPTIVE_COOLDOWN_MS = envNumber(\"FETCH_ADAPTIVE_COOLDOWN_MS\", 60_000, 1);",
    to: "const ADAPTIVE_COOLDOWN_MS = envNumber(\"FETCH_ADAPTIVE_COOLDOWN_MS\", 120_000, 1);",
    marker: "FETCH_ADAPTIVE_COOLDOWN_MS\", 120_000",
  },
]);

console.log("[patch-ai-entry-latency] safe mode enabled: 60s discovery/entry scans, fresh entry quotes, 1 request/host, 30s cache, and stronger 429 cooldown");
