import fs from "node:fs";

const apiPath = "app/api/compact-dashboard/route.ts";
const pagePath = "app/page.tsx";

function replaceOnce(path, from, to, marker) {
  let text = fs.readFileSync(path, "utf8");
  if (marker && text.includes(marker)) return;
  if (!text.includes(from)) {
    console.warn(`[patch-dashboard-sol-price-fallback] pattern missing in ${path}: ${from.slice(0, 100)}`);
    return;
  }
  text = text.replace(from, to);
  fs.writeFileSync(path, text);
}

replaceOnce(
  apiPath,
  `async function fetchSolUsdPrice(): Promise<number | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT", {
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const price = Number(payload?.price);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}`,
  `async function fetchSolUsdPrice(): Promise<number | null> {
  const sources = [
    {
      url: "https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT",
      read: (payload: any) => Number(payload?.price),
    },
    {
      url: "https://api.coinbase.com/v2/prices/SOL-USD/spot",
      read: (payload: any) => Number(payload?.data?.amount),
    },
    {
      url: "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      read: (payload: any) => Number(payload?.solana?.usd),
    },
  ];

  for (const source of sources) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4_000);
    try {
      const response = await fetch(source.url, {
        cache: "no-store",
        signal: controller.signal,
        headers: { Accept: "application/json", "User-Agent": "solana-wallet-tracker-dashboard/1.0" },
      });
      if (!response.ok) continue;
      const payload = await response.json();
      const price = source.read(payload);
      if (Number.isFinite(price) && price > 0) return price;
    } catch {
      // Try the next independent provider.
    } finally {
      clearTimeout(timeout);
    }
  }

  return null;
}`,
  "api.coinbase.com/v2/prices/SOL-USD/spot"
);

replaceOnce(
  pagePath,
  `sub={price > 0 ? \`Realized PnL since this bot started · USD at current SOL price (\${usd(price)})\` : "Realized PnL since this bot started · SOL/USD price temporarily unavailable"}`,
  `sub={price > 0 ? \`Exact 24-hour cycles from the first opened trade · USD at current SOL price (\${usd(price)})\` : "Exact 24-hour cycles from the first opened trade · SOL/USD temporarily unavailable"}`,
  "Exact 24-hour cycles from the first opened trade"
);

console.log("[patch-dashboard-sol-price-fallback] applied");
