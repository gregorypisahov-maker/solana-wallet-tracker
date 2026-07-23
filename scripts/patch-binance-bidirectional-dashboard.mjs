import fs from "node:fs";

const file = "app/platform/binance/page.tsx";
const cssFile = "app/platform/binance/binance-live.module.css";
let source = fs.readFileSync(file, "utf8");
let cssSource = fs.readFileSync(cssFile, "utf8");

function replaceText(before, after, label) {
  if (source.includes(after)) return;
  if (!source.includes(before)) throw new Error(`Binance bidirectional dashboard patch target missing: ${label}`);
  source = source.replace(before, after);
}

function replacePattern(pattern, after, marker, label) {
  if (source.includes(marker)) return;
  if (!pattern.test(source)) throw new Error(`Binance bidirectional dashboard patch target missing: ${label}`);
  source = source.replace(pattern, after);
}

replaceText(
  `    status: string;\n    currentPrice: number;`,
  `    status: string;\n    signalSide: "SHORT" | "LONG";\n    currentPrice: number;`,
  "derived signal side"
);

replaceText(
  `function statusText(status: string, threshold: number) {\n  if (status === "position_open") return "SHORT POSITION OPEN";\n  if (status === "signal_pending") return "SIGNAL HIT · FILL PENDING";\n  if (status === "halted") return "RISK HALTED";\n  if (status === "disabled") return "BOT DISABLED";\n  return \`WAITING FOR +\${threshold.toFixed(2)}% PUMP\`;\n}`,
  `function statusText(status: string, threshold: number, side: "SHORT" | "LONG") {\n  if (status === "position_open") return \`\${side} POSITION OPEN\`;\n  if (status === "signal_pending") return \`\${side} SIGNAL HIT · FILL PENDING\`;\n  if (status === "halted") return "RISK HALTED";\n  if (status === "disabled") return "BOT DISABLED";\n  return \`WAITING FOR ±\${threshold.toFixed(2)}% BTC MOVE\`;\n}`,
  "status copy"
);

replaceText(`<h1>BTC Pump-Fade Paper Trader</h1>`, `<h1>BTC Two-Way Fade Paper Trader</h1>`, "page heading");
replaceText(
  `<p>Live movement, entry trigger and simulated short management</p>`,
  `<p>Fast pump shorts and fast drop rebound longs · paper only</p>`,
  "page subtitle"
);
replaceText(
  `{statusText(derived.status, derived.triggerThresholdPct)}`,
  `{statusText(derived.status, derived.triggerThresholdPct, derived.signalSide)}`,
  "status invocation"
);
replaceText(
  `<h3>Short after a fast BTC pump</h3>`,
  `<h3>{derived.signalSide === "LONG" ? "Long after a fast BTC drop" : "Short after a fast BTC pump"}</h3>`,
  "entry plan heading"
);
replacePattern(
  /The bot waits for BTC to rise at least \{config\.pumpThresholdPct\}% from the rolling low\s+across \{config\.lookbackCandles\} completed one-minute candles, then fills a simulated short\./,
  `The bot watches both directions across {config.lookbackCandles} completed one-minute candles.\n                 A fast rise opens a simulated short; an equally strong drop opens a simulated rebound long.`,
  "A fast rise opens a simulated short",
  "entry plan description"
);
replaceText(
  `<div className={styles.level}><span>Trigger</span><strong>+{config.pumpThresholdPct.toFixed(2)}% / {config.lookbackCandles}m</strong></div>`,
  `<div className={styles.level}><span>Trigger</span><strong>±{config.pumpThresholdPct.toFixed(2)}% / {config.lookbackCandles}m</strong></div>`,
  "trigger display"
);
replaceText(
  `<span>Stop loss</span><strong>{usd(display?.stop)} · +{config.stopLossPct}%</strong>`,
  `<span>Stop loss</span><strong>{usd(display?.stop)} · {derived.signalSide === "LONG" ? "−" : "+"}{config.stopLossPct}%</strong>`,
  "directional stop"
);
replaceText(
  `<span>Take profit</span><strong>{usd(display?.target)} · −{config.takeProfitPct}%</strong>`,
  `<span>Take profit</span><strong>{usd(display?.target)} · {derived.signalSide === "LONG" ? "+" : "−"}{config.takeProfitPct}%</strong>`,
  "directional target"
);
replaceText(
  `<small>Needs +{derived.triggerThresholdPct.toFixed(2)}%</small>`,
  `<small>Needs ±{derived.triggerThresholdPct.toFixed(2)}%</small>`,
  "trigger KPI"
);
replaceText(
  `<h3>SHORT {position.symbol} · {position.leverage}×</h3>`,
  `<h3>{position.side} {position.symbol} · {position.leverage}×</h3>`,
  "open position side"
);
replaceText(
  `No completed Binance paper trades yet. The engine is waiting for its first valid +{config.pumpThresholdPct}% pump.`,
  `No completed Binance paper trades yet. The engine is waiting for its first valid ±{config.pumpThresholdPct}% move.`,
  "empty trade copy"
);
replacePattern(
  /<div className=\{`\$\{styles\.tradeRow\} \$\{styles\.head\}`\}><span>Closed<\/span><span>Reason<\/span><span>Entry<\/span><span>Exit<\/span><strong>Net PnL<\/strong><\/div>/,
  `<div className={\`\${styles.tradeRow} \${styles.head}\`}><span>Closed</span><span>Side</span><span>Reason</span><span>Entry</span><span>Exit</span><strong>Net PnL</strong></div>`,
  "<span>Side</span><span>Reason</span>",
  "completed trade side header"
);
replaceText(
  `                      <span>{israelTime(trade.closed_at)}</span>\n                      <span>{String(trade.exit_reason).replaceAll("_", " ")}</span>`,
  `                      <span>{israelTime(trade.closed_at)}</span>\n                      <span>{String(trade.side ?? "—")}</span>\n                      <span>{String(trade.exit_reason).replaceAll("_", " ")}</span>`,
  "completed trade side value"
);

const oldTradeGrid = ".tradeRow{min-width:580px;display:grid;grid-template-columns:90px 80px 1fr 1fr 95px;";
const newTradeGrid = ".tradeRow{min-width:640px;display:grid;grid-template-columns:90px 55px 80px 1fr 1fr 95px;";
if (!cssSource.includes(newTradeGrid)) {
  if (!cssSource.includes(oldTradeGrid)) {
    throw new Error("Binance bidirectional dashboard patch target missing: completed trade grid");
  }
  cssSource = cssSource.replace(oldTradeGrid, newTradeGrid);
}

fs.writeFileSync(file, source);
fs.writeFileSync(cssFile, cssSource);
console.log("[build] Binance dashboard patched for LONG and SHORT paper trades, including trade direction history.");
