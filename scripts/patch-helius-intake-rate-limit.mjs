import fs from "node:fs";

const monitorFile = "worker/monitor.ts";

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) {
    throw new Error(`${label} patch target not found`);
  }
  return source.replace(before, after);
}

function patchMonitor() {
  let source = fs.readFileSync(monitorFile, "utf8");

  const modeBefore = `const HELIUS_EVENT_MODE = (
  process.env.HELIUS_EVENT_MODE ?? "auto"
).toLowerCase();`;
  const modeAfter = `${modeBefore}
const PROVIDER_HTTP_POLLING_ACTIVE =
  Boolean(process.env.SOLANA_RPC_URL?.trim() || process.env.ALCHEMY_RPC_URL?.trim()) &&
  ["1", "true", "yes", "on"].includes(
    (process.env.ENABLE_PROVIDER_HTTP_POLLING ?? "true").trim().toLowerCase()
  );`;
  source = replaceOnce(
    source,
    modeBefore,
    modeAfter,
    "provider HTTP polling mode"
  );

  const webhookAnchor = `async function syncHeliusWebhook(addresses: string[]): Promise<boolean> {`;
  const webhookAfter = `${webhookAnchor}
  // Provider polling is HTTP-only. Never touch Helius management APIs or
  // attempt a Solana logsSubscribe fallback on this path.
  if (PROVIDER_HTTP_POLLING_ACTIVE || HELIUS_EVENT_MODE === "polling") {
    webhookMode = false;
    return false;
  }`;
  source = replaceOnce(
    source,
    webhookAnchor,
    webhookAfter,
    "Helius webhook bypass"
  );

  const subscriptionBefore = `async function syncWalletSubscriptions(): Promise<void> {
  const { data: wallets, error } = await supabase`;
  const subscriptionAfter = `async function syncWalletSubscriptions(): Promise<void> {
  if (PROVIDER_HTTP_POLLING_ACTIVE) {
    webhookMode = false;
    for (const [address, subscriptionId] of walletSubscriptions) {
      try {
        await connection.removeOnLogsListener(subscriptionId);
      } catch (error) {
        console.warn(
          \`[provider-polling] failed to close old subscription \${address.slice(0, 6)}…:\`,
          error
        );
      } finally {
        walletSubscriptions.delete(address);
      }
    }
    console.log(
      "[provider-polling] HTTP reconciliation active; WebSockets and Helius intake are disabled"
    );
    return;
  }

  const { data: wallets, error } = await supabase`;
  source = replaceOnce(
    source,
    subscriptionBefore,
    subscriptionAfter,
    "WebSocket subscription bypass"
  );

  const usageBefore = `async function persistHeliusUsageInner(): Promise<void> {
  const snapshot = usage.snapshot();`;
  const usageAfter = `async function persistHeliusUsageInner(): Promise<void> {
  // Provider HTTP requests belong to Alchemy/the configured neutral RPC and
  // must never be reported as Helius credit consumption.
  if (PROVIDER_HTTP_POLLING_ACTIVE) return;

  const snapshot = usage.snapshot();`;
  source = replaceOnce(
    source,
    usageBefore,
    usageAfter,
    "Helius usage reporting bypass"
  );

  const startupBefore = `      \`✅ Solana wallet tracker started in credit-saving \${
        webhookMode ? "filtered webhook" : "WebSocket fallback"
      } mode. Telegram alerts are working.\``;
  const startupAfter = `      \`✅ Solana wallet tracker started in \${
        PROVIDER_HTTP_POLLING_ACTIVE
          ? "Alchemy HTTP polling (Helius disabled)"
          : webhookMode
            ? "filtered webhook"
            : "WebSocket fallback"
      } mode. Telegram alerts are working.\``;
  source = replaceOnce(
    source,
    startupBefore,
    startupAfter,
    "startup status message"
  );

  const requiredMarkers = [
    "PROVIDER_HTTP_POLLING_ACTIVE",
    "HTTP reconciliation active; WebSockets and Helius intake are disabled",
    "must never be reported as Helius credit consumption",
    "Alchemy HTTP polling (Helius disabled)",
  ];
  for (const marker of requiredMarkers) {
    if (!source.includes(marker)) {
      throw new Error(`Provider polling patch incomplete: missing ${marker}`);
    }
  }

  fs.writeFileSync(monitorFile, source);
  console.log(
    "[build] Enabled provider HTTP polling; Helius and logsSubscribe paths remain disabled."
  );
}

patchMonitor();
