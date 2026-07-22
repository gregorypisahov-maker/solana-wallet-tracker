import fs from "node:fs";

const managerFile = "worker/heliusWebhookManager.ts";
const monitorFile = "worker/monitor.ts";

function patchManager() {
  let source = fs.readFileSync(managerFile, "utf8");
  const before = `// Cost guard: the monitor must not create, update, or reactivate Helius
// webhooks. It will use its existing WebSocket intake and polling
// reconciliation paths instead.
process.env.HELIUS_EVENT_MODE = "websocket";
console.log("[helius-webhook] registration disabled; using WebSocket + polling ingestion");`;
  const after = `// Auto mode first reuses the filtered Helius webhook. WebSocket fallback is
// separately opt-in so a rejected Helius socket cannot enter a rapid reconnect loop.`;

  if (source.includes(before)) {
    source = source.replace(before, after);
    fs.writeFileSync(managerFile, source);
    console.log("[build] Restored filtered-webhook-first Helius intake.");
    return;
  }

  if (!source.includes(after)) {
    throw new Error("Helius webhook-mode patch target not found");
  }
  console.log("[build] Helius webhook-first intake already patched.");
}

function patchMonitor() {
  let source = fs.readFileSync(monitorFile, "utf8");

  const modeBefore = `const HELIUS_EVENT_MODE = (
  process.env.HELIUS_EVENT_MODE ?? "auto"
).toLowerCase();`;
  const modeAfter = `${modeBefore}
const PROVIDER_NEUTRAL_RPC_ACTIVE = Boolean(
  process.env.SOLANA_RPC_URL?.trim() || process.env.ALCHEMY_RPC_URL?.trim()
);
const HELIUS_WEBSOCKET_FALLBACK_ENABLED =
  PROVIDER_NEUTRAL_RPC_ACTIVE ||
  ["1", "true", "yes", "on"].includes(
    (process.env.ENABLE_HELIUS_WEBSOCKET_FALLBACK ?? "false").trim().toLowerCase()
  );`;

  if (source.includes(modeBefore) && !source.includes("PROVIDER_NEUTRAL_RPC_ACTIVE")) {
    source = source.replace(modeBefore, modeAfter);
  } else if (
    source.includes("ENABLE_HELIUS_WEBSOCKET_FALLBACK") &&
    !source.includes("PROVIDER_NEUTRAL_RPC_ACTIVE")
  ) {
    const oldBlock = `const HELIUS_WEBSOCKET_FALLBACK_ENABLED = ["1", "true", "yes", "on"].includes(
  (process.env.ENABLE_HELIUS_WEBSOCKET_FALLBACK ?? "false").trim().toLowerCase()
);`;
    const newBlock = `const PROVIDER_NEUTRAL_RPC_ACTIVE = Boolean(
  process.env.SOLANA_RPC_URL?.trim() || process.env.ALCHEMY_RPC_URL?.trim()
);
const HELIUS_WEBSOCKET_FALLBACK_ENABLED =
  PROVIDER_NEUTRAL_RPC_ACTIVE ||
  ["1", "true", "yes", "on"].includes(
    (process.env.ENABLE_HELIUS_WEBSOCKET_FALLBACK ?? "false").trim().toLowerCase()
  );`;
    if (source.includes(oldBlock)) source = source.replace(oldBlock, newBlock);
  }

  const syncAnchor = `async function syncHeliusWebhook(addresses: string[]): Promise<boolean> {`;
  const providerBypass = `${syncAnchor}
  // Alchemy/provider-neutral RPC uses standard Solana WebSockets directly.
  // Never call Helius webhook APIs when this path is active.
  if (PROVIDER_NEUTRAL_RPC_ACTIVE) {
    webhookMode = false;
    return false;
  }`;
  if (source.includes(syncAnchor) && !source.includes("Never call Helius webhook APIs")) {
    source = source.replace(syncAnchor, providerBypass);
  }

  const explicitWsBefore = `  if (HELIUS_EVENT_MODE === "websocket") {
    webhookMode = false;
    return false;
  }`;
  const explicitWsAfter = `  if (HELIUS_EVENT_MODE === "polling") {
    webhookMode = false;
    return false;
  }
  if (HELIUS_EVENT_MODE === "websocket" && HELIUS_WEBSOCKET_FALLBACK_ENABLED) {
    webhookMode = false;
    return false;
  }`;
  if (source.includes(explicitWsBefore)) {
    source = source.replace(explicitWsBefore, explicitWsAfter);
  }

  const fallbackAnchor = `    console.log("[helius-webhook] WebSocket fallback is idle");
    return;
  }

  for (const [address, subscriptionId] of walletSubscriptions) {`;
  const fallbackReplacement = `    console.log("[helius-webhook] WebSocket fallback is idle");
    return;
  }

  if (!HELIUS_WEBSOCKET_FALLBACK_ENABLED) {
    for (const [address, subscriptionId] of walletSubscriptions) {
      try {
        await connection.removeOnLogsListener(subscriptionId);
      } catch (error) {
        console.warn(
          \`[websocket] Failed to close rate-limited subscription \${address.slice(0, 6)}…:\`,
          error
        );
      } finally {
        walletSubscriptions.delete(address);
      }
    }
    console.warn(
      "[helius-intake] filtered webhook unavailable; WebSocket fallback disabled; " +
        "using paced reconciliation only"
    );
    return;
  }

  for (const [address, subscriptionId] of walletSubscriptions) {`;
  if (source.includes(fallbackAnchor)) {
    source = source.replace(fallbackAnchor, fallbackReplacement);
  }

  const requiredMarkers = [
    "PROVIDER_NEUTRAL_RPC_ACTIVE",
    "Never call Helius webhook APIs",
    "ENABLE_HELIUS_WEBSOCKET_FALLBACK",
    "filtered webhook unavailable; WebSocket fallback disabled",
    `HELIUS_EVENT_MODE === "polling"`,
  ];
  for (const marker of requiredMarkers) {
    if (!source.includes(marker)) {
      throw new Error(`Helius intake patch incomplete: missing ${marker}`);
    }
  }

  fs.writeFileSync(monitorFile, source);
  console.log(
    PROVIDER_NEUTRAL_RPC_ACTIVE
      ? "[build] Provider-neutral WebSocket intake preserved; Helius APIs bypassed."
      : "[build] Added Helius WebSocket rate-limit circuit breaker."
  );
}

patchManager();
patchMonitor();
