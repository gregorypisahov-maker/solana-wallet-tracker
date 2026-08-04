// Champion-only service entrypoint.
// The legacy momentum scalper and Helius launch sniper are intentionally disabled.
process.env.ENABLE_MOMENTUM_SCALPER = "false";
process.env.ENABLE_HELIUS_MILLISECOND_SNIPER = "false";

function clean(value: string | undefined): string {
  return (value ?? "").trim().replace(/^[\"']|[\"']$/g, "").trim();
}

function configureHeliusEndpoints(): { rpc: string; ws: string; source: string } {
  const apiKey = clean(process.env.HELIUS_API_KEY);
  const configuredRpc = clean(process.env.HELIUS_RPC_URL);

  if (apiKey) {
    const rpc = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
    const ws = `wss://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
    process.env.HELIUS_RPC_URL = rpc;
    process.env.HELIUS_WS_URL = ws;
    return { rpc, ws, source: "HELIUS_API_KEY" };
  }

  if (!configuredRpc) throw new Error("HELIUS_API_KEY_or_HELIUS_RPC_URL_missing");
  const rpcUrl = new URL(configuredRpc);
  if (rpcUrl.protocol !== "https:" && rpcUrl.protocol !== "http:") {
    throw new Error("HELIUS_RPC_URL_invalid_protocol");
  }

  const wsUrl = new URL(configuredRpc);
  wsUrl.protocol = rpcUrl.protocol === "https:" ? "wss:" : "ws:";
  process.env.HELIUS_RPC_URL = rpcUrl.toString();
  process.env.HELIUS_WS_URL = wsUrl.toString();
  return { rpc: rpcUrl.toString(), ws: wsUrl.toString(), source: "HELIUS_RPC_URL" };
}

async function preflightHelius(rpc: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Helius authentication failed: HTTP ${response.status} ${body.slice(0, 200)}`);
    }
    const parsed = JSON.parse(body) as { result?: unknown; error?: { message?: string } };
    if (parsed.error) {
      throw new Error(`Helius RPC rejected preflight: ${parsed.error.message ?? "unknown error"}`);
    }
    console.log("[champion-app] Helius authentication preflight passed");
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  const endpoints = configureHeliusEndpoints();
  console.log(`[champion-app] Helius endpoints normalized from ${endpoints.source}`);
  await preflightHelius(endpoints.rpc);

  const { startChampionResearchScheduler } = await import("../paper-trader/championResearch");
  const { startChampionPaperScheduler } = await import("../paper-trader/championPaper");
  startChampionResearchScheduler();
  startChampionPaperScheduler();

  // Dashboard import starts the Express server. No sniper scheduler is imported or started.
  await import("./sniperPaperApp");
}

main().catch((error) => {
  console.error("[champion-app] fatal startup error", error);
  process.exit(1);
});
