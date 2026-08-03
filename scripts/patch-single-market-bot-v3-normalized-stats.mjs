import fs from "node:fs";

const path = "single-bot/marketBot.ts";
let source = fs.readFileSync(path, "utf8");

const beforeSelect = '.select("id,pnl_usdc,pnl_pct,status")';
const afterSelect = '.select("id,pnl_usdc,pnl_pct,status,updated_at")';
if (!source.includes(beforeSelect)) throw new Error("[v3-normalized-stats] status query anchor missing");
source = source.replace(beforeSelect, afterSelect);

const beforeStats = `  const closed = rows ?? [];
  const wins = closed.filter((row: any) => n(row.pnl_usdc) > 0);
  const losses = closed.filter((row: any) => n(row.pnl_usdc) < 0);
  const grossWin = wins.reduce((sum: number, row: any) => sum + n(row.pnl_usdc), 0);
  const grossLoss = Math.abs(losses.reduce((sum: number, row: any) => sum + n(row.pnl_usdc), 0));`;
const afterStats = `  const closed = rows ?? [];
  const scaleAppliedAt = state.scale_applied_at ? Date.parse(String(state.scale_applied_at)) : 0;
  const historicalScale = Math.max(1, n(state.scale_factor, 1));
  const normalizedPnl = (row: any): number => {
    const closedAt = Date.parse(String(row.updated_at ?? ""));
    return n(row.pnl_usdc) * (scaleAppliedAt > 0 && closedAt > 0 && closedAt < scaleAppliedAt ? historicalScale : 1);
  };
  const wins = closed.filter((row: any) => normalizedPnl(row) > 0);
  const losses = closed.filter((row: any) => normalizedPnl(row) < 0);
  const grossWin = wins.reduce((sum: number, row: any) => sum + normalizedPnl(row), 0);
  const grossLoss = Math.abs(losses.reduce((sum: number, row: any) => sum + normalizedPnl(row), 0));`;
if (!source.includes(beforeStats)) throw new Error("[v3-normalized-stats] performance block anchor missing");
source = source.replace(beforeStats, afterStats);

const beforeNet = '      netPnlUsdc: closed.reduce((sum: number, row: any) => sum + n(row.pnl_usdc), 0),';
const afterNet = '      netPnlUsdc: closed.reduce((sum: number, row: any) => sum + normalizedPnl(row), 0),';
if (!source.includes(beforeNet)) throw new Error("[v3-normalized-stats] net PnL anchor missing");
source = source.replace(beforeNet, afterNet);

fs.writeFileSync(path, source);
console.log("[patch-single-market-bot-v3-normalized-stats] applied");
