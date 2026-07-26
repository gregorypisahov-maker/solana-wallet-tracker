import fs from "node:fs";

function replaceOnce(path, from, to, marker) {
  let text = fs.readFileSync(path, "utf8");
  if (marker && text.includes(marker)) return;
  if (!text.includes(from)) {
    console.warn(`[patch-daily-usd-profit] pattern missing in ${path}: ${from.slice(0, 120)}`);
    return;
  }
  text = text.replace(from, to);
  fs.writeFileSync(path, text);
}

const apiPath = "app/api/compact-dashboard/route.ts";

replaceOnce(
  apiPath,
  `type Row = Record<string, any>;`,
  `type Row = Record<string, any>;

const DAY_MS = 86_400_000;

function daily24hStats(trades: Row[]) {
  const timed = trades
    .map((trade) => ({
      trade,
      time: Date.parse(trade.opened_at ?? trade.happenedAt ?? trade.closed_at ?? trade.happened_at ?? 0),
      closeTime: Date.parse(trade.happenedAt ?? trade.closed_at ?? trade.happened_at ?? trade.opened_at ?? 0),
    }))
    .filter((item) => Number.isFinite(item.time) && Number.isFinite(item.closeTime))
    .sort((a, b) => a.time - b.time);

  if (!timed.length) return [];
  const startedAtMs = timed[0].time;
  const finalPeriod = Math.max(0, Math.floor((Date.now() - startedAtMs) / DAY_MS));
  const buckets = Array.from({ length: finalPeriod + 1 }, (_, index) => ({
    day: index + 1,
    startedAt: new Date(startedAtMs + index * DAY_MS).toISOString(),
    endedAt: new Date(startedAtMs + (index + 1) * DAY_MS).toISOString(),
    complete: Date.now() >= startedAtMs + (index + 1) * DAY_MS,
    trades: 0,
    pnlSol: 0,
  }));

  for (const item of timed) {
    const index = Math.max(0, Math.floor((item.closeTime - startedAtMs) / DAY_MS));
    if (!buckets[index]) continue;
    buckets[index].trades += 1;
    buckets[index].pnlSol += Number(item.trade.pnl ?? item.trade.pnl_sol ?? 0);
  }

  return buckets.reverse();
}

async function fetchSolUsdPrice(): Promise<number | null> {
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
  "function daily24hStats"
);

replaceOnce(
  apiPath,
  `    recentTrades: trades.slice(0, 100),`,
  `    recentTrades: trades.slice(0, 100),
    daily24h: daily24hStats(trades),`,
  "daily24h: daily24hStats(trades)"
);

replaceOnce(
  apiPath,
  `  const supabase = getSupabaseAdmin({ noStore: true });`,
  `  const supabase = getSupabaseAdmin({ noStore: true });
  const solUsdPricePromise = fetchSolUsdPrice();`,
  "const solUsdPricePromise = fetchSolUsdPrice();"
);

replaceOnce(
  apiPath,
  `  const bots = [`,
  `  const solUsdPrice = await solUsdPricePromise;

  const bots = [`,
  "const solUsdPrice = await solUsdPricePromise;"
);

replaceOnce(
  apiPath,
  `  ].map((bot) => ({
    ...bot,`,
  `  ].map((bot) => ({
    ...bot,
    solUsdPrice,`,
  "    solUsdPrice,"
);

const pagePath = "app/page.tsx";

replaceOnce(
  pagePath,
  `  recent24h: any;
  recent48h: any;`,
  `  recent24h: any;
  daily24h: Array<{ day: number; startedAt: string; endedAt: string; complete: boolean; trades: number; pnlSol: number }>;
  solUsdPrice: number | null;
  recent48h: any;`,
  "daily24h: Array<{ day: number;"
);

replaceOnce(
  pagePath,
  `const pct = (v: number) => \`${"${(v * 100).toFixed(1)}%"}\`;`,
  `const pct = (v: number) => \`${"${(v * 100).toFixed(1)}%"}\`;
const usd = (v: number) => new Intl.NumberFormat("en-IL", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);`,
  "const usd = (v: number)"
);

replaceOnce(
  pagePath,
  `function OpenPositions({ bot, now }: { bot: Bot; now: number }) {`,
  `function Daily24hProfit({ bot }: { bot: Bot }) {
  const rows = Array.isArray(bot.daily24h) ? bot.daily24h : [];
  const price = Number(bot.solUsdPrice ?? 0);
  return (
    <section className="v2Panel">
      <Title
        title="Profit by each 24 hours"
        sub={price > 0 ? \`Realized PnL since this bot started · USD at current SOL price (\${usd(price)})\` : "Realized PnL since this bot started · SOL/USD price temporarily unavailable"}
      />
      {rows.length === 0 ? (
        <div className="v2Toast">No completed trades yet.</div>
      ) : (
        <div className="v2Trades v2DailyProfit">
          <div className="head"><span>Period</span><span>Time</span><span>Trades</span><span>Profit</span></div>
          {rows.map((row) => {
            const pnlSol = Number(row.pnlSol ?? 0);
            return (
              <div className="row" key={row.day}>
                <span><b>Day {row.day}</b><small>{row.complete ? "Complete 24h" : "Current 24h · live"}</small></span>
                <span><b>{exactIsraelTime(row.startedAt)}</b><small>to {row.complete ? exactIsraelTime(row.endedAt) : "now"}</small></span>
                <span>{row.trades} closed</span>
                <strong className={pnlSol >= 0 ? "positive" : "negative"}>{price > 0 ? usd(pnlSol * price) : "—"}<small>{sol(pnlSol)}</small></strong>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function OpenPositions({ bot, now }: { bot: Bot; now: number }) {`,
  "function Daily24hProfit({ bot }"
);

replaceOnce(
  pagePath,
  `      <OpenPositions bot={bot} now={now} />`,
  `      <Daily24hProfit bot={bot} />
      <OpenPositions bot={bot} now={now} />`,
  "<Daily24hProfit bot={bot} />"
);

replaceOnce(
  "app/platform-v2.css",
  `.v2Trades .row strong{font-size:14px;text-align:right}`,
  `.v2Trades .row strong{font-size:14px;text-align:right}.v2DailyProfit .row strong small{display:block;margin-top:4px;font-size:11px;font-weight:500;color:var(--muted)}`,
  ".v2DailyProfit .row strong small"
);

console.log("[patch-daily-usd-profit] applied");
