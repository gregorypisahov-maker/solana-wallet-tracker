import fs from "node:fs";

const cssFile = "app/platform/binance/binance-live.module.css";
let cssSource = fs.readFileSync(cssFile, "utf8");

const oldTradeGrid = ".tradeRow{min-width:580px;display:grid;grid-template-columns:90px 80px 1fr 1fr 95px;";
const newTradeGrid = ".tradeRow{min-width:640px;display:grid;grid-template-columns:90px 55px 80px 1fr 1fr 95px;";

if (!cssSource.includes(newTradeGrid)) {
  if (!cssSource.includes(oldTradeGrid)) {
    throw new Error("Binance dual dashboard patch target missing: completed trade grid");
  }
  cssSource = cssSource.replace(oldTradeGrid, newTradeGrid);
  fs.writeFileSync(cssFile, cssSource);
}

console.log("[build] Binance dashboard already contains independent LONG and SHORT panels.");
