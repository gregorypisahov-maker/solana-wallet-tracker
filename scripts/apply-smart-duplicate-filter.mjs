import fs from "node:fs";

const target = new URL("../live-executor/liveExecutor.ts", import.meta.url);
let source = fs.readFileSync(target, "utf8");

const oldFunction = `async function duplicateSymbolCount(signal: Signal): Promise<number> {
  const symbol = signal.token_symbol?.trim();
  if (!symbol) return 1;
  const cutoff = new Date(
    Date.now() - DUPLICATE_SYMBOL_LOOKBACK_HOURS * 60 * 60_000
  ).toISOString();
  const { data, error } = await supabase
    .from("market_opportunities")
    .select("mint")
    .ilike("token_symbol", symbol)
    .gte("last_seen_at", cutoff)
    .limit(100);
  if (error) throw new Error(error.message);
  return new Set((data ?? []).map((row: any) => String(row.mint))).size;
}`;

const newFunction = `async function duplicateSymbolCount(signal: Signal): Promise<{
  activeCredibleMints: number;
  totalRecentMints: number;
}> {
  const symbol = signal.token_symbol?.trim();
  if (!symbol) return { activeCredibleMints: 1, totalRecentMints: 1 };
  const cutoff = new Date(
    Date.now() - DUPLICATE_SYMBOL_LOOKBACK_HOURS * 60 * 60_000
  ).toISOString();
  const { data, error } = await supabase
    .from("market_opportunities")
    .select("mint,status,score,liquidity_usd,last_seen_at")
    .ilike("token_symbol", symbol)
    .gte("last_seen_at", cutoff)
    .limit(100);
  if (error) throw new Error(error.message);

  const rows = data ?? [];
  const totalRecentMints = new Set(
    rows.map((row: any) => String(row.mint))
  ).size;
  const credible = rows.filter((row: any) =>
    row.status === "armed" &&
    n(row.score) >= 78 &&
    n(row.liquidity_usd) >= 75_000
  );
  const activeCredibleMints = new Set(
    credible.map((row: any) => String(row.mint))
  ).size;

  return { activeCredibleMints, totalRecentMints };
}`;

const oldSafety = `  const duplicateMints = await duplicateSymbolCount(signal);
  if (duplicateMints > MAX_DUPLICATE_SYMBOL_MINTS) {
    return {
      reason: "duplicate_brand_cluster",
      details: {
        duplicateSymbolMints: duplicateMints,
        maximumAllowed: MAX_DUPLICATE_SYMBOL_MINTS,
      },
    };
  }`;

const newSafety = `  const duplicateSummary = await duplicateSymbolCount(signal);
  if (duplicateSummary.activeCredibleMints > MAX_DUPLICATE_SYMBOL_MINTS) {
    return {
      reason: "duplicate_brand_cluster",
      details: {
        duplicateSymbolMints: duplicateSummary.activeCredibleMints,
        totalRecentSymbolMints: duplicateSummary.totalRecentMints,
        duplicateFilterMode: "active_armed_score78_liquidity75k",
        maximumAllowed: MAX_DUPLICATE_SYMBOL_MINTS,
      },
    };
  }`;

const oldDetails = `      duplicateSymbolMints: duplicateMints,`;
const newDetails = `      duplicateSymbolMints: duplicateSummary.activeCredibleMints,
      totalRecentSymbolMints: duplicateSummary.totalRecentMints,
      duplicateFilterMode: "active_armed_score78_liquidity75k",`;

if (!source.includes(oldFunction)) {
  console.log("[smart-duplicate-filter] function already patched or source changed; no-op");
  process.exit(0);
}
if (!source.includes(oldSafety) || !source.includes(oldDetails)) {
  throw new Error("smart duplicate filter patch anchors not found");
}

source = source
  .replace(oldFunction, newFunction)
  .replace(oldSafety, newSafety)
  .replace(oldDetails, newDetails);

fs.writeFileSync(target, source);
console.log("[smart-duplicate-filter] active: only credible active same-symbol mints count toward blocking");
