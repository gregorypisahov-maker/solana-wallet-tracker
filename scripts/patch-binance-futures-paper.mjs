import fs from "node:fs";

const file = "paper-trader/binanceFuturesPaperRest.ts";
let source = fs.readFileSync(file, "utf8");

const before = `    const quantityFilter =
      filters.find((row: any) => row.filterType === "MARKET_LOT_SIZE") ??
      filters.find((row: any) => row.filterType === "LOT_SIZE");`;

const after = `    const marketQuantityFilter = filters.find((row: any) => row.filterType === "MARKET_LOT_SIZE");
    const lotQuantityFilter = filters.find((row: any) => row.filterType === "LOT_SIZE");
    const quantityFilter =
      marketQuantityFilter &&
      finite(marketQuantityFilter.stepSize) > 0 &&
      finite(marketQuantityFilter.minQty) > 0
        ? marketQuantityFilter
        : lotQuantityFilter;`;

if (!source.includes(before) && !source.includes(after)) {
  throw new Error("Binance futures quantity-filter patch target not found");
}

if (source.includes(before)) {
  source = source.replace(before, after);
  fs.writeFileSync(file, source);
  console.log("[build] Patched Binance spot quantity-filter fallback.");
} else {
  console.log("[build] Binance quantity-filter fallback already patched.");
}
