import fs from "node:fs";

const file = "app/platform/binance/page.tsx";
let source = fs.readFileSync(file, "utf8");

function replaceOnce(before, after, label) {
  if (source.includes(after)) return;
  if (!source.includes(before)) throw new Error(`Binance bidirectional dashboard patch target missing: ${label}`);
  source = source.replace(before, after);
}

replaceOnce(
  `    status: string;\n    currentPrice: number;`,
  `    status: string;\n    signalSide: "SHORT" | "LONG";\n    currentPrice: number;`,
  "derived signal side"
);

replaceOnce(
  `function statusText(status: string, threshold: number) {\n  if (status === "position_open") return "SHORT POSITION OPEN";\n  if (status === "signal_pending") return "SIGNAL HIT · FILL PENDING";\n  if (status === "halted") return "RISK HALTED";\n  if (status === "disabled") return "BOT DISABLED";\n  return \`WAITING FOR +\${threshold.toFixed(2)}% PUMP\`;\n}`,
  `function statusText(status: string, threshold: number, side: "SHORT" | "LONG") {\n  if (status === "position_open") return \`\${side} POSITION OPEN\`;\n  if (status === "signal_pending") return \`\${side} SIGNAL HIT · FILL PENDING\`;\n  if (status === "halted") return "RISK HALTED";\n  if (status === "disabled") return "BOT DISABLED";\n  return \`WAITING FOR ±\${threshold.toFixed(2)}% BTC MOVE\`;\n}`,
  "status copy"
);

replaceOnce(
  `<h1>BTC Pump-Fade Paper Trader</h1>\n              <p>Live movement, entry trigger and simulated short management</p>`,
  `<h1>BTC Two-Way Fade Paper Trader</h1>\n              <p>Fast pump shorts and fast drop rebound longs · paper only</p>`,
  "page heading"
);

replaceOnce(
  `{statusText(derived.status, derived.triggerThresholdPct)}`,
  `{statusText(derived.status, derived.triggerThresholdPct, derived.signalSide)}`,
  "status invocation"
);

replaceOnce(
  `<h3>Short after a fast BTC pump</h3>\n               <p>\n                 The bot waits for BTC to rise at least {config.pumpThresholdPct}% from the rolling low\n                 across {config.lookbackCandles} completed one-minute candles, then fills a simulated short.\n               </p>`,
  `<h3>{derived.signalSide === "LONG" ? "Long after a fast BTC drop" : "Short after a fast BTC pump"}</h3>\n               <p>\n                 The bot watches both directions across {config.lookbackCandles} completed one-minute candles.\n                 A fast rise opens a simulated short; an equally strong drop opens a simulated rebound long.\n               </p>`,
  "entry plan description"
);

replaceOnce(
  `<div className={styles.level}><span>Trigger</span><strong>+{config.pumpThresholdPct.toFixed(2)}% / {config.lookbackCandles}m</strong></div>`,
  `<div className={styles.level}><span>Trigger</span><strong>±{config.pumpThresholdPct.toFixed(2)}% / {config.lookbackCandles}m</strong></div>`,
  "trigger display"
);

replaceOnce(
  `<div className={\`${styles.level} ${styles.stop}\`}><span>Stop loss</span><strong>{usd(display?.stop)} · +{config.stopLossPct}%</strong></div>\n                 <div className={\`${styles.level} ${styles.target}\`}><span>Take profit</span><strong>{usd(display?.target)} · −{config.takeProfitPct}%</strong></div>`,
  `<div className={\`${styles.level} ${styles.stop}\`}><span>Stop loss</span><strong>{usd(display?.stop)} · {derived.signalSide === "LONG" ? "−" : "+"}{config.stopLossPct}%</strong></div>\n                 <div className={\`${styles.level} ${styles.target}\`}><span>Take profit</span><strong>{usd(display?.target)} · {derived.signalSide === "LONG" ? "+" : "−"}{config.takeProfitPct}%</strong></div>`,
  "directional levels"
);

replaceOnce(
  `<article className={\`${styles.card} ${styles.kpi}\`}><span>Trigger movement</span><strong className={currentTone}>{pct(derived.currentMovePct)}</strong><small>Needs +{derived.triggerThresholdPct.toFixed(2)}%</small></article>`,
  `<article className={\`${styles.card} ${styles.kpi}\`}><span>Trigger movement</span><strong className={currentTone}>{pct(derived.currentMovePct)}</strong><small>Needs ±{derived.triggerThresholdPct.toFixed(2)}%</small></article>`,
  "trigger KPI"
);

replaceOnce(
  `<h3>SHORT {position.symbol} · {position.leverage}×</h3>`,
  `<h3>{position.side} {position.symbol} · {position.leverage}×</h3>`,
  "open position side"
);

replaceOnce(
  `No completed Binance paper trades yet. The engine is waiting for its first valid +{config.pumpThresholdPct}% pump.`,
  `No completed Binance paper trades yet. The engine is waiting for its first valid ±{config.pumpThresholdPct}% move.`,
  "empty trade copy"
);

fs.writeFileSync(file, source);
console.log("[build] Binance dashboard patched for LONG and SHORT paper trades.");
