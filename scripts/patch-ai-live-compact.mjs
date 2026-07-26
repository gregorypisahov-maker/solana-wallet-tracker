import fs from "node:fs";

function patchFile(path, transform) {
  if (!fs.existsSync(path)) return;
  const before = fs.readFileSync(path, "utf8");
  const after = transform(before);
  if (after !== before) fs.writeFileSync(path, after);
}

patchFile("app/page.tsx", (source) => {
  let text = source;

  text = text.replace(
    "const timer = setInterval(() => void load(), 5_000);",
    "const timer = setInterval(() => void load(), 2_000);"
  );

  text = text.replace(
    'sub={`Updates every 5 seconds · ${live.priceSource}`}',
    'sub={`Fast 2-second refresh · ${live.priceSource}`}'
  );

  text = text.replace(
    /\n\s*<div className="v2PriceChartWrap">[\s\S]*?<\/div>\n\n\s*<div className="v2RuleGrid">/,
    `

      <div className="v2SignalGrid">
        <div><small>Gross move</small><strong className={Number(live.grossReturnPct) >= 0 ? "positive" : "negative"}>{Number(live.grossReturnPct) >= 0 ? "+" : ""}{Number(live.grossReturnPct).toFixed(2)}%</strong><span>Before paper friction</span></div>
        <div><small>To take profit</small><strong>{Math.max(0, Number(live.rules?.takeProfitPct ?? 10) - Number(live.grossReturnPct ?? 0)).toFixed(2)}%</strong><span>Remaining gross move</span></div>
        <div><small>To hard stop</small><strong>{Math.max(0, Number(live.grossReturnPct ?? 0) - Number(live.rules?.hardStopPct ?? -6)).toFixed(2)}%</strong><span>Safety distance remaining</span></div>
        <div><small>Liquidity</small><strong>{Number(live.liquidityUsd ?? 0) > 0 ? `$${Math.round(Number(live.liquidityUsd)).toLocaleString("en-IL")}` : "—"}</strong><span>{Number(live.priceChangeM5 ?? 0) >= 0 ? "Positive" : "Negative"} 5-minute momentum</span></div>
      </div>

      <div className="v2RuleGrid">`
  );

  text = text.replace("Entry marker on chart", "Original paper entry price");
  return text;
});

patchFile("app/api/ai-position-live/route.ts", (source) => {
  return source.replace(
    /\n\s*const \{ data: rows, error: sampleError \} = await supabase[\s\S]*?\n\s*history\.push\([\s\S]*?\n\s*\}\);/,
    "\n\n  // The embedded chart was removed. Skip the historical sample query so the live panel responds faster and uses less Supabase egress.\n  const history: any[] = [];"
  );
});

patchFile("app/platform-v2.css", (source) => {
  if (source.includes(".v2SignalGrid{")) return source;
  return `${source}\n.v2SignalGrid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;margin-top:14px}.v2SignalGrid>div{border:1px solid var(--line);border-radius:11px;background:#0d141c;padding:11px}.v2SignalGrid small{display:block;color:var(--muted);font-size:8px;text-transform:uppercase;letter-spacing:.04em}.v2SignalGrid strong{display:block;margin-top:6px;font-size:14px}.v2SignalGrid span{display:block;margin-top:4px;color:var(--muted);font-size:8px;line-height:1.35}@media(max-width:760px){.v2SignalGrid{grid-template-columns:1fr 1fr}}\n`;
});

console.log("[patch-ai-live-compact] chart removed; fast metrics panel enabled");
