import fs from "node:fs";

function patchFile(path, replacements) {
  let source = fs.readFileSync(path, "utf8");
  for (const [before, after, label] of replacements) {
    if (!source.includes(before)) throw new Error(`${path}: missing pattern ${label}`);
    source = source.replace(before, after);
  }
  fs.writeFileSync(path, source);
}

patchFile("paper-trader/aiOutcomeTrackerV10.ts", [
  [
    'import { geckoFetchJson } from "../lib/geckoFetch";\n',
    'import { geckoFetchJson } from "../lib/geckoFetch";\nimport { getPriceViaHelius } from "../lib/heliusPrice";\n',
    "outcome helius import",
  ],
  [
    'type PriceSource = "dexscreener" | "geckoterminal";',
    'type PriceSource = "helius" | "cache" | "dexscreener" | "geckoterminal";',
    "outcome price source",
  ],
  [
    '  geckoFallbacks: number;\n};',
    '  geckoFallbacks: number;\n  heliusRequests: number;\n  heliusHits: number;\n  heliusCacheHits: number;\n};',
    "outcome stats type",
  ],
  [
    `): Promise<MeasurementAttempt> {\n  let dexError: string | null = null;\n  if (stats) stats.dexRequests += 1;`,
    `): Promise<MeasurementAttempt> {\n  if (stats) stats.heliusRequests += 1;\n  const helius = await getPriceViaHelius(mint, pairAddress);\n  if (helius) {\n    if (stats) {\n      stats.heliusHits += 1;\n      if (helius.source === "cache") stats.heliusCacheHits += 1;\n    }\n    console.log(\`[outcome-tracker] price \${mint} src=\${helius.source} poolProgram=\${helius.poolProgram}\`);\n    return {\n      measurement: {\n        priceUsd: helius.priceUsd,\n        measuredAt: helius.observedAt,\n        source: helius.source,\n      },\n      error: null,\n      dex429: false,\n      usedFallback: false,\n    };\n  }\n\n  let dexError: string | null = null;\n  if (stats) stats.dexRequests += 1;`,
    "outcome helius first",
  ],
  [
    `    if (measurement) {\n      return { measurement, error: null, dex429: false, usedFallback: false };\n    }`,
    `    if (measurement) {\n      console.log(\`[outcome-tracker] price \${mint} src=dex poolProgram=fallback\`);\n      return { measurement, error: null, dex429: false, usedFallback: false };\n    }`,
    "outcome dex log",
  ],
  [
    `    if (measurement) {\n      if (stats) stats.geckoFallbacks += 1;\n      return { measurement, error: dexError, dex429, usedFallback: true };\n    }`,
    `    if (measurement) {\n      if (stats) stats.geckoFallbacks += 1;\n      console.log(\`[outcome-tracker] price \${mint} src=gecko poolProgram=fallback\`);\n      return { measurement, error: dexError, dex429, usedFallback: true };\n    }`,
    "outcome gecko log",
  ],
  [
    `    geckoFallbacks: 0,\n  };`,
    `    geckoFallbacks: 0,\n    heliusRequests: 0,\n    heliusHits: 0,\n    heliusCacheHits: 0,\n  };`,
    "outcome stats init",
  ],
  [
    `      \`429=\${stats.dex429} geckoFallback=\${stats.geckoFallbacks} backlog=\${backlog ?? 0}\``,
    `      \`429=\${stats.dex429} geckoFallback=\${stats.geckoFallbacks} \` +\n      \`helius=\${stats.heliusHits}/\${stats.heliusRequests} heliusCache=\${stats.heliusCacheHits} backlog=\${backlog ?? 0}\``,
    "outcome log stats",
  ],
]);

patchFile("paper-trader/aiDiscoveryTrader.ts", [
  [
    'import { getSupabaseAdmin } from "../lib/supabase";\n',
    'import { getSupabaseAdmin } from "../lib/supabase";\nimport { getPriceViaHelius } from "../lib/heliusPrice";\n',
    "discovery trader helius import",
  ],
  [
    `async function pairFor(\n  mint: string,\n  pairAddress: string,\n  minimumLiquidity = 0\n): Promise<Market | null> {\n  const body = await fetchJson(\`\${DEX_URL}/\${encodeURIComponent(mint)}\`);`,
    `async function pairFor(\n  mint: string,\n  pairAddress: string,\n  minimumLiquidity = 0\n): Promise<Market | null> {\n  if (minimumLiquidity <= 0) {\n    const helius = await getPriceViaHelius(mint, pairAddress);\n    if (helius) {\n      console.log(\`[ai-discovery-trader] price \${mint} src=\${helius.source} poolProgram=\${helius.poolProgram}\`);\n      return { priceUsd: helius.priceUsd, liquidityUsd: 0, marketCapUsd: 0, changeM5: 0 };\n    }\n  }\n\n  const body = await fetchJson(\`\${DEX_URL}/\${encodeURIComponent(mint)}\`);`,
    "discovery trader exit helius",
  ],
  [
    `async function priceFor(mint: string, pairAddress: string): Promise<Market | null> {\n  return pairFor(mint, pairAddress, 25_000);\n}`,
    `async function priceForOpportunity(opportunity: any): Promise<Market | null> {\n  const mint = String(opportunity.mint ?? "");\n  const pairAddress = String(opportunity.pair_address ?? "");\n  const helius = await getPriceViaHelius(mint, pairAddress);\n  const liquidityUsd = n(opportunity.liquidity_usd, Number.NaN);\n  if (helius && Number.isFinite(liquidityUsd) && liquidityUsd >= 25_000) {\n    console.log(\`[ai-discovery-trader] price \${mint} src=\${helius.source} poolProgram=\${helius.poolProgram}\`);\n    return {\n      priceUsd: helius.priceUsd,\n      liquidityUsd,\n      marketCapUsd: n(opportunity.market_cap_usd, 0),\n      changeM5: n(opportunity.price_change_m5, 0),\n    };\n  }\n\n  const fallback = await pairFor(mint, pairAddress, 25_000);\n  if (fallback) console.log(\`[ai-discovery-trader] price \${mint} src=dex poolProgram=fallback\`);\n  return fallback;\n}`,
    "discovery trader entry price",
  ],
  [
    `        const market = await priceFor(opportunity.mint, opportunity.pair_address);`,
    `        const market = await priceForOpportunity(opportunity);`,
    "discovery trader call",
  ],
]);

patchFile("paper-trader/marketDiscoveryAgent.ts", [
  [
    'import { getSupabaseAdmin } from "../lib/supabase";\n',
    'import { GeckoCooldownError, geckoFetchJson } from "../lib/geckoFetch";\nimport { getSupabaseAdmin } from "../lib/supabase";\n',
    "market discovery gecko import",
  ],
  [
    `const STABLES = new Set([\n  WRAPPED_SOL,\n  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",\n  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",\n]);`,
    `const STABLES = new Set([\n  WRAPPED_SOL,\n  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",\n  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",\n]);\nconst DISCOVERY_CACHE_TTL_MS = Math.max(30_000, Number(process.env.DISCOVERY_CACHE_TTL_MS) || 90_000);\nconst DISCOVERY_CACHE_MAX_STALE_MS = Math.max(\n  DISCOVERY_CACHE_TTL_MS,\n  Number(process.env.DISCOVERY_CACHE_MAX_STALE_MS) || 10 * 60_000\n);`,
    "market discovery cache config",
  ],
  [
    `type Ranked = Candidate & {\n  score: number;\n  confidence: "low" | "medium" | "high";\n  status: "watching" | "armed";\n  reasons: string[];\n  risks: string[];\n};\n\nlet running = false;`,
    `type Ranked = Candidate & {\n  score: number;\n  confidence: "low" | "medium" | "high";\n  status: "watching" | "armed";\n  reasons: string[];\n  risks: string[];\n};\n\ntype DiscoveryMeta = {\n  servedFrom: "live" | "cache" | "live_partial";\n  stale: boolean;\n  cacheAgeMs: number | null;\n  failedFeeds: number;\n};\n\ntype DiscoveryResult = { candidates: Candidate[]; meta: DiscoveryMeta };\n\nlet running = false;\nlet lastGoodDiscovery: { savedAt: number; candidates: Candidate[] } | null = null;`,
    "market discovery types",
  ],
  [
    `async function fetchJson(url: string): Promise<any> {\n  const controller = new AbortController();\n  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);\n  try {\n    const response = await fetch(url, {\n      cache: "no-store",\n      signal: controller.signal,\n      headers: {\n        Accept: "application/vnd.api+json;version=20230302",\n        "User-Agent": "solana-market-discovery-ai/1.0",\n      },\n    });\n    if (!response.ok) throw new Error(\`\${response.status} \${response.statusText}\`);\n    return await response.json();\n  } finally {\n    clearTimeout(timeout);\n  }\n}`,
    `async function fetchJson(url: string): Promise<any> {\n  return geckoFetchJson(url);\n}\n\nfunction isCooldownFailure(error: unknown): boolean {\n  return error instanceof GeckoCooldownError || /(^|\\s)429(\\s|$)|cooling down|too many requests/i.test(\n    error instanceof Error ? error.message : String(error)\n  );\n}`,
    "market discovery fetch",
  ],
  [
    `async function discover(): Promise<Candidate[]> {\n  const results = await Promise.allSettled(FEEDS.map(fetchJson));\n  const byMint = new Map<string, Candidate>();\n\n  for (const result of results) {\n    if (result.status === "rejected") {\n      console.warn("[market-discovery-ai] feed failed:", result.reason);\n      continue;\n    }\n\n    const rows = Array.isArray(result.value?.data) ? result.value.data : [];\n    for (const row of rows) {\n      const candidate = parse(row);\n      if (!candidate) continue;\n      const existing = byMint.get(candidate.mint);\n      if (!existing || candidate.liquidityUsd > existing.liquidityUsd) {\n        byMint.set(candidate.mint, candidate);\n      }\n    }\n  }\n\n  if (\n    byMint.size === 0 &&\n    results.every((result) => result.status === "rejected")\n  ) {\n    throw new Error("all discovery feeds failed");\n  }\n\n  return [...byMint.values()];\n}`,
    `async function discover(): Promise<DiscoveryResult> {\n  const now = Date.now();\n  if (lastGoodDiscovery && now - lastGoodDiscovery.savedAt <= DISCOVERY_CACHE_TTL_MS) {\n    const age = now - lastGoodDiscovery.savedAt;\n    console.log(\`[market-discovery-ai] discovery served_from=cache age=\${age}ms stale=false\`);\n    return {\n      candidates: lastGoodDiscovery.candidates.map((item) => ({ ...item })),\n      meta: { servedFrom: "cache", stale: false, cacheAgeMs: age, failedFeeds: 0 },\n    };\n  }\n\n  const results = await Promise.allSettled(FEEDS.map(fetchJson));\n  const byMint = new Map<string, Candidate>();\n  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");\n\n  for (const result of results) {\n    if (result.status === "rejected") {\n      console.warn("[market-discovery-ai] feed failed:", result.reason);\n      continue;\n    }\n\n    const rows = Array.isArray(result.value?.data) ? result.value.data : [];\n    for (const row of rows) {\n      const candidate = parse(row);\n      if (!candidate) continue;\n      const existing = byMint.get(candidate.mint);\n      if (!existing || candidate.liquidityUsd > existing.liquidityUsd) byMint.set(candidate.mint, candidate);\n    }\n  }\n\n  if (failures.length === 0 && byMint.size > 0) {\n    const candidates = [...byMint.values()];\n    lastGoodDiscovery = { savedAt: Date.now(), candidates: candidates.map((item) => ({ ...item })) };\n    return { candidates, meta: { servedFrom: "live", stale: false, cacheAgeMs: null, failedFeeds: 0 } };\n  }\n\n  const cacheAge = lastGoodDiscovery ? Date.now() - lastGoodDiscovery.savedAt : Number.POSITIVE_INFINITY;\n  const cooldown = failures.some((result) => isCooldownFailure(result.reason));\n  if (lastGoodDiscovery && cacheAge <= DISCOVERY_CACHE_MAX_STALE_MS) {\n    console.warn(\n      \`[market-discovery-ai] discovery served_from=cache age=\${cacheAge}ms stale=true failures=\${failures.length} cooldown=\${cooldown}\`\n    );\n    return {\n      candidates: lastGoodDiscovery.candidates.map((item) => ({ ...item })),\n      meta: { servedFrom: "cache", stale: true, cacheAgeMs: cacheAge, failedFeeds: failures.length },\n    };\n  }\n\n  if (byMint.size === 0 && failures.length === results.length) throw new Error("all discovery feeds failed");\n  return {\n    candidates: [...byMint.values()],\n    meta: { servedFrom: "live_partial", stale: true, cacheAgeMs: null, failedFeeds: failures.length },\n  };\n}`,
    "market discovery cache behavior",
  ],
  [
    `async function persist(\n  startedAt: string,\n  candidates: Candidate[],\n  ranked: Ranked[],\n  marketRegime: string\n): Promise<void> {`,
    `async function persist(\n  startedAt: string,\n  candidates: Candidate[],\n  ranked: Ranked[],\n  marketRegime: string,\n  discoveryMeta: DiscoveryMeta\n): Promise<void> {`,
    "market discovery persist signature",
  ],
  [
    `        signal_snapshot: {\n          version: VERSION,\n          buyRatio: item.buysM5 / Math.max(1, item.buysM5 + item.sellsM5),\n        },`,
    `        signal_snapshot: {\n          version: VERSION,\n          buyRatio: item.buysM5 / Math.max(1, item.buysM5 + item.sellsM5),\n          discoveryStale: discoveryMeta.stale,\n          discoveryServedFrom: discoveryMeta.servedFrom,\n          discoveryCacheAgeMs: discoveryMeta.cacheAgeMs,\n        },`,
    "market discovery opportunity meta",
  ],
  [
    `    snapshot: { version: VERSION, top: top.slice(0, 10) },`,
    `    snapshot: { version: VERSION, top: top.slice(0, 10), discovery: discoveryMeta },`,
    "market discovery run meta",
  ],
  [
    `    const candidates = await discover();\n    const ranked = candidates.map(rank).sort((a, b) => b.score - a.score);\n    const marketRegime = regime(ranked);\n    await persist(startedAt, candidates, ranked, marketRegime);`,
    `    const discovery = await discover();\n    const candidates = discovery.candidates;\n    const ranked = candidates.map(rank).sort((a, b) => b.score - a.score);\n    const marketRegime = regime(ranked);\n    await persist(startedAt, candidates, ranked, marketRegime, discovery.meta);`,
    "market discovery run",
  ],
  [
    `      \`[market-discovery-ai] scanned \${candidates.length}; regime \${marketRegime}; \` +\n        \`top \${top ? \`\${top.symbol} \${top.score}/100\` : "none"}\``,
    `      \`[market-discovery-ai] scanned \${candidates.length}; regime \${marketRegime}; \` +\n        \`served_from=\${discovery.meta.servedFrom} stale=\${discovery.meta.stale}; \` +\n        \`top \${top ? \`\${top.symbol} \${top.score}/100\` : "none"}\``,
    "market discovery scan log",
  ],
  [
    `    \`[market-discovery-ai] \${VERSION} enabled; scan \${every / 1000}s; \` +\n      "restored original GeckoTerminal discovery; analysis-only, no direct real-money execution"`,
    `    \`[market-discovery-ai] \${VERSION} enabled; scan \${every / 1000}s; \` +\n      \`discoveryCacheTtlMs=\${DISCOVERY_CACHE_TTL_MS} maxStaleMs=\${DISCOVERY_CACHE_MAX_STALE_MS}; \` +\n      "GeckoTerminal discovery with full-universe cache; analysis-only, no direct real-money execution"`,
    "market discovery startup log",
  ],
]);

patchFile("lib/geckoFetch.ts", [
  [
    `const REQUEST_TIMEOUT_MS = Math.max(3_000, Number(process.env.GECKO_FETCH_TIMEOUT_MS ?? 12_000));`,
    `const REQUEST_TIMEOUT_MS = Math.max(3_000, Number(process.env.GECKO_FETCH_TIMEOUT_MS ?? 12_000));\nconst TOKEN_BUCKET_CAPACITY = Math.max(1, Math.min(5, Number(process.env.GECKO_TOKEN_BUCKET_CAPACITY ?? 1)));`,
    "gecko token config",
  ],
  [
    `let lastRequestAt = 0;\nlet cooldownUntil = 0;`,
    `let lastRequestAt = 0;\nlet bucketTokens = TOKEN_BUCKET_CAPACITY;\nlet bucketUpdatedAt = Date.now();\nlet cooldownUntil = 0;`,
    "gecko token state",
  ],
  [
    `const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));\n\nasync function waitForTurn(): Promise<void> {`,
    `const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));\n\nfunction refillBucket(): void {\n  const now = Date.now();\n  const elapsed = now - bucketUpdatedAt;\n  if (elapsed < MIN_INTERVAL_MS) return;\n  const tokens = Math.floor(elapsed / MIN_INTERVAL_MS);\n  bucketTokens = Math.min(TOKEN_BUCKET_CAPACITY, bucketTokens + tokens);\n  bucketUpdatedAt += tokens * MIN_INTERVAL_MS;\n}\n\nasync function takeToken(): Promise<void> {\n  while (true) {\n    refillBucket();\n    if (bucketTokens >= 1) {\n      bucketTokens -= 1;\n      return;\n    }\n    await sleep(Math.max(25, MIN_INTERVAL_MS - (Date.now() - bucketUpdatedAt)));\n  }\n}\n\nasync function waitForTurn(): Promise<void> {`,
    "gecko token helpers",
  ],
  [
    `    const waitMs = Math.max(\n      0,\n      MIN_INTERVAL_MS - (Date.now() - lastRequestAt),\n      cooldownUntil - Date.now()\n    );\n    if (waitMs > 0) await sleep(waitMs);\n    lastRequestAt = Date.now();`,
    `    const waitMs = Math.max(0, cooldownUntil - Date.now());\n    if (waitMs > 0) await sleep(waitMs);\n    await takeToken();\n    lastRequestAt = Date.now();`,
    "gecko token consume",
  ],
  [
    `    \`staleCache=\${STALE_CACHE_MS}ms retries=\${MAX_RETRIES} cooldown=\${COOLDOWN_MS}ms\``,
    `    \`staleCache=\${STALE_CACHE_MS}ms retries=\${MAX_RETRIES} cooldown=\${COOLDOWN_MS}ms \` +\n    \`tokenBucket=\${TOKEN_BUCKET_CAPACITY}\``,
    "gecko token log",
  ],
]);

console.log("Helius price routing and discovery cache source codemod applied.");
