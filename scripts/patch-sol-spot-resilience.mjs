import fs from "node:fs";
import path from "node:path";

const target = path.resolve(process.cwd(), "paper-trader/solSpotPaper.ts");
if (!fs.existsSync(target)) {
  console.log("[patch-sol-spot-resilience] target missing; skipped");
  process.exit(0);
}

let source = fs.readFileSync(target, "utf8");
let changed = false;

function replaceOnce(before, after, label) {
  if (source.includes(after)) return;
  if (!source.includes(before)) {
    throw new Error(`[patch-sol-spot-resilience] anchor missing: ${label}`);
  }
  source = source.replace(before, after);
  changed = true;
}

replaceOnce(
  'restBaseUrl: (process.env.BINANCE_SPOT_REST_URL ?? "https://api.binance.com").replace(/\\/$/, ""),',
  'restBaseUrl: (process.env.BINANCE_SPOT_REST_URL ?? "https://data-api.binance.vision").replace(/\\/$/, ""),',
  "default market-data endpoint"
);

replaceOnce(
`async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(\`Binance spot HTTP \${response.status}\`);
  return response.json();
}`,
`const BINANCE_MARKET_DATA_BASE_URLS = Array.from(
  new Set([
    SOL_SPOT_PAPER_CONFIG.restBaseUrl,
    "https://data-api.binance.vision",
    "https://api.binance.com",
    "https://api-gcp.binance.com",
    "https://api1.binance.com",
    "https://api2.binance.com",
    "https://api3.binance.com",
    "https://api4.binance.com",
  ].map((value) => value.replace(/\\/$/, "")))
);

async function fetchJson(url: string): Promise<any> {
  const parsed = new URL(url);
  const failures: string[] = [];
  for (const baseUrl of BINANCE_MARKET_DATA_BASE_URLS) {
    try {
      const response = await fetch(\`\${baseUrl}\${parsed.pathname}\${parsed.search}\`, {
        cache: "no-store",
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) {
        failures.push(\`\${baseUrl}:HTTP_\${response.status}\`);
        continue;
      }
      return response.json();
    } catch (error) {
      failures.push(\`\${baseUrl}:\${error instanceof Error ? error.message : String(error)}\`);
    }
  }
  throw new Error(\`Binance public market data unavailable (\${failures.join(" | ").slice(0, 900)})\`);
}`,
  "market-data fallback"
);

replaceOnce(
`    await this.loadExchangeRules();
    await this.loadOpenPosition();
    await this.refreshLease();
    this.leaseTimer = setInterval(() => void this.refreshLease(), SOL_SPOT_PAPER_CONFIG.leaseRefreshMs);`,
`    await this.updateHealth("starting", null);
    try {
      await this.loadExchangeRules();
      await this.loadOpenPosition();
      await this.refreshLease();
    } catch (error) {
      console.error("[sol-spot-paper] startup failed; retrying in 30s", error);
      await this.updateHealth("error", error);
      setTimeout(() => void this.start(), 30_000);
      return;
    }
    this.leaseTimer = setInterval(() => void this.refreshLease(), SOL_SPOT_PAPER_CONFIG.leaseRefreshMs);`,
  "startup health and retry"
);

if (changed) {
  fs.writeFileSync(target, source);
  console.log("[patch-sol-spot-resilience] applied");
} else {
  console.log("[patch-sol-spot-resilience] already applied");
}
