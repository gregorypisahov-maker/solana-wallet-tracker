import fs from "node:fs";

const path = "single-bot/marketBot.ts";
let source = fs.readFileSync(path, "utf8");

// Newer dashboard builds already use canonical booked PnL and reconcile it
// against account equity. Do not rewrite or scale those values again.
if (source.includes("const bookedPnlUsdc = closed.reduce") && source.includes("accountPnlUsdc")) {
  fs.writeFileSync(path, source);
  console.log("[patch-single-market-bot-v3-normalized-stats] canonical accounting already applied");
  process.exit(0);
}

const beforeSelect = '.select("id,pnl_usdc,pnl_pct,status")';
const afterSelect = '.select("id,pnl_usdc,pnl_pct,status,updated_at,metadata")';
if (source.includes(beforeSelect)) {
  source = source.replace(beforeSelect, afterSelect);
} else if (!source.includes(afterSelect)) {
  throw new Error("[v3-normalized-stats] status query anchor missing");
}

const beforeStats = `  const closed = rows ?? [];
  const wins = closed.filter((row: any) => n(row.pnl_usdc) > 0);
  const losses = closed.filter((row: any) => n(row.pnl_usdc) < 0);
  const grossWin = wins.reduce((sum: number, row: any) => sum + n(row.pnl_usdc), 0);
  const grossLoss = Math.abs(losses.reduce((sum: number, row: any) => sum + n(row.pnl_usdc), 0));`;
const afterStats = `  const closed = rows ?? [];
  const bookedPnl = (row: any): number => n(row.pnl_usdc);
  const wins = closed.filter((row: any) => bookedPnl(row) > 0);
  const losses = closed.filter((row: any) => bookedPnl(row) < 0);
  const grossWin = wins.reduce((sum: number, row: any) => sum + bookedPnl(row), 0);
  const grossLoss = Math.abs(losses.reduce((sum: number, row: any) => sum + bookedPnl(row), 0));`;
if (source.includes(beforeStats)) {
  source = source.replace(beforeStats, afterStats);
} else if (!source.includes("const bookedPnl = (row: any): number => n(row.pnl_usdc);")) {
  throw new Error("[v3-normalized-stats] performance block anchor missing");
}

const beforeNet = '      netPnlUsdc: closed.reduce((sum: number, row: any) => sum + n(row.pnl_usdc), 0),';
const afterNet = '      netPnlUsdc: closed.reduce((sum: number, row: any) => sum + bookedPnl(row), 0),';
if (source.includes(beforeNet)) {
  source = source.replace(beforeNet, afterNet);
} else if (!source.includes(afterNet)) {
  throw new Error("[v3-normalized-stats] net PnL anchor missing");
}

fs.writeFileSync(path, source);
console.log("[patch-single-market-bot-v3-normalized-stats] applied");
