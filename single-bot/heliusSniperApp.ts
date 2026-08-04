// The old Gecko/DexScreener discovery scheduler must not compete with the
// event-driven Helius launch stream. Position management remains enabled by
// sniperPaperApp, but its timed discovery loop is disabled before import.
process.env.ENABLE_MOMENTUM_SCALPER = "false";

function clean(value: string | undefined): string {
  return (value ?? "").trim().replace(/^[\"']|[\"']$/g, "").trim();
}

function configureHeliusEndpoints(): { rpc: string; ws: string; source: string } {
  const apiKey = clean(process.env.HELIUS_API_KEY);
  const configuredRpc = clean(process.env.HELIUS_RPC_URL);

  // A valid API key is the source of truth. This deliberately ignores a stale
  // or malformed HELIUS_WS_URL, which previously caused an endless 401 loop.
  if (apiKey) {
    const rpc = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
    const ws = `wss://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
    process.env.HELIUS_RPC_URL = rpc;
    process.env.HELIUS_WS_URL = ws;
    return { rpc, ws, source: "HELIUS_API_KEY" };
  }

  if (!configuredRpc) {
    throw new Error("HELIUS_API_KEY_or_HELIUS_RPC_URL_missing");
  }

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
    console.log("[helius-sniper-app] Helius authentication preflight passed");
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  const endpoints = configureHeliusEndpoints();
  console.log(`[helius-sniper-app] Helius endpoints normalized from ${endpoints.source}; custom WS override ignored`);
  await preflightHelius(endpoints.rpc);

  // Import only after endpoint normalization so the worker cannot initialize
  // with a stale Railway HELIUS_WS_URL value.
  const { startHeliusMillisecondSniper } = await import("./heliusMillisecondSniper");
  startHeliusMillisecondSniper();
  await import("./sniperPaperApp");
}

main().catch((error) => {
  console.error("[helius-sniper-app] fatal startup error", error);
  process.exit(1);
});
