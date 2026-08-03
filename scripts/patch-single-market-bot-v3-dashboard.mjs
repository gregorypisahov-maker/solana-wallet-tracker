import fs from "node:fs";

const path = "single-bot/marketBot.ts";
let source = fs.readFileSync(path, "utf8");
function replaceBlock(startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`[v3-dashboard] missing ${label}`);
  source = source.slice(0, start) + replacement + source.slice(end);
}

const status = `app.get("/api/status", async (_req: Request, res: Response) => {
  let state = await loadState();
  state = await maybeScalePaperBankroll(state);
  const [{ data: trades }, { data: rows }, { count: rollbackCount }] = await Promise.all([
    supabase.from("single_market_bot_trades").select("*").order("created_at", { ascending: false }).limit(50),
    supabase.from("single_market_bot_trades").select("id,pnl_usdc,pnl_pct,status").in("status", ["paper_closed", "closed"]).gte("id", STATS_START_TRADE_ID).order("id", { ascending: true }),
    supabase.from("single_market_bot_rollbacks").select("id", { count: "exact", head: true }),
  ]);
  const closed = rows ?? [];
  const wins = closed.filter((row: any) => n(row.pnl_usdc) > 0);
  const losses = closed.filter((row: any) => n(row.pnl_usdc) < 0);
  const grossWin = wins.reduce((sum: number, row: any) => sum + n(row.pnl_usdc), 0);
  const grossLoss = Math.abs(losses.reduce((sum: number, row: any) => sum + n(row.pnl_usdc), 0));
  const position = state.open_position as Position | null;
  const openValueUsdc = position ? n(position.currentExitUsdc, n(position.highWaterExitUsdc, position.sizeUsdc)) : 0;
  const unrealizedPnlUsdc = position ? openValueUsdc - n(position.sizeUsdc) : 0;
  res.setHeader("cache-control", "no-store, no-cache, must-revalidate");
  res.json({
    service: "single-market-bot",
    wallet: getWalletPublicKey(),
    config: {
      enabled: ENABLED,
      mode: MODE,
      strategyVersion: STRATEGY_VERSION,
      tradeSizeUsdc: TRADE_SIZE_USDC,
      paperScaleTargetUsdc: PAPER_SCALE_TARGET_USDC,
      maxConfidenceMultiplier: MAX_CONFIDENCE_MULTIPLIER,
      maxPositionPct: MAX_POSITION_PCT,
      lossBlockCount: LOSS_BLOCK_COUNT,
      maxDailyLossUsdc: MAX_DAILY_LOSS_USDC,
    },
    performance: {
      trades: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRatePct: closed.length ? wins.length / closed.length * 100 : 0,
      netPnlUsdc: closed.reduce((sum: number, row: any) => sum + n(row.pnl_usdc), 0),
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    },
    account: {
      equityUsdc: n(state.cash_usdc) + openValueUsdc,
      openValueUsdc,
      unrealizedPnlUsdc,
      rollbackSnapshots: Number(rollbackCount ?? 0),
    },
    state,
    trades: trades ?? [],
  });
});`;
replaceBlock('app.get("/api/status"', '\napp.get("/",', status, 'status route');

const dashboard = `app.get("/", (_req: Request, res: Response) => {
  res.setHeader("cache-control", "no-store, no-cache, must-revalidate");
  res.type("html").send(\`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Solana Market Bot</title><style>body{font-family:system-ui;background:#081019;color:#edf5ff;margin:0;padding:18px}.wrap{max-width:1180px;margin:auto}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px}.card{background:#111c29;border:1px solid #26384d;border-radius:14px;padding:14px;margin:11px 0}.v{font-size:22px;font-weight:750}.muted{color:#9fb2c9}.small{font-size:12px}.on{color:#6ce89a}.bad{color:#ff7e7e}table{width:100%;border-collapse:collapse;display:block;overflow-x:auto}tbody,thead{display:table;width:100%;table-layout:fixed}td,th{padding:8px;border-bottom:1px solid #26384d;text-align:left;font-size:12px;white-space:nowrap}code{word-break:break-all;color:#b9d8ff}</style></head><body><div class="wrap"><h1>Solana Market Bot</h1><div class="muted">Same bot · timing v3 · proportional bankroll scale · rollback protected</div><div id="app">Loading…</div></div><script>
const f=n=>Number(n||0), money=n=>f(n).toFixed(2), pct=n=>f(n).toFixed(1)+'%';
async function refresh(){try{const x=await fetch('/api/status?ts='+Date.now(),{cache:'no-store'}).then(r=>r.json()),s=x.state||{},p=s.open_position,a=x.account||{},m=x.performance||{},top=s.scanner_snapshot?.top||[],tr=x.trades||[];const pending=x.config.mode==='paper'&&f(s.starting_cash_usdc)<f(x.config.paperScaleTargetUsdc);document.getElementById('app').innerHTML=
'<div class="grid">'+
'<div class="card"><div class="muted">Mode</div><div class="v on">'+(x.config.enabled?x.config.mode.toUpperCase():'DISABLED')+'</div></div>'+
'<div class="card"><div class="muted">Equity</div><div class="v">'+money(a.equityUsdc)+'</div></div>'+
'<div class="card"><div class="muted">Cash</div><div class="v">'+money(s.cash_usdc)+'</div></div>'+
'<div class="card"><div class="muted">Open value</div><div class="v">'+money(a.openValueUsdc)+'</div></div>'+
'<div class="card"><div class="muted">Unrealized</div><div class="v '+(f(a.unrealizedPnlUsdc)<0?'bad':'on')+'">'+money(a.unrealizedPnlUsdc)+'</div></div>'+
'<div class="card"><div class="muted">Win rate</div><div class="v">'+pct(m.winRatePct)+'</div><div class="small muted">'+f(m.wins)+'W / '+f(m.losses)+'L</div></div>'+
'<div class="card"><div class="muted">Profit factor</div><div class="v">'+(m.profitFactor==null?'—':f(m.profitFactor).toFixed(2))+'</div></div>'+
'<div class="card"><div class="muted">Strategy PnL</div><div class="v '+(f(m.netPnlUsdc)<0?'bad':'on')+'">'+money(m.netPnlUsdc)+'</div></div>'+
'<div class="card"><div class="muted">Completed</div><div class="v">'+f(m.trades)+'</div></div>'+
'<div class="card"><div class="muted">Scanned</div><div class="v">'+f(s.scanner_snapshot?.scanned)+'</div></div></div>'+
'<div class="card"><div class="muted">Strategy</div><div>'+x.config.strategyVersion+'</div><div class="muted" style="margin-top:8px">Bankroll</div><div>'+(pending?'Scale pending until current position closes · then current values are multiplied proportionally to a '+money(x.config.paperScaleTargetUsdc)+' starting bankroll':'Starting bankroll '+money(s.starting_cash_usdc)+' · scale factor '+f(s.scale_factor||1).toFixed(2)+'x')+'</div><div class="muted" style="margin-top:8px">Trade sizing</div><div>'+money(x.config.tradeSizeUsdc)+' base · exceptional paper setups can request up to '+f(x.config.maxConfidenceMultiplier).toFixed(0)+'x · hard cap '+f(x.config.maxPositionPct).toFixed(0)+'% of cash</div><div class="muted" style="margin-top:8px">Open position</div><div>'+(p?p.symbol+' · '+money(p.sizeUsdc)+' · '+(p.confidenceTier||'legacy')+' · '+f(p.sizeMultiplier||1).toFixed(2)+'x':'None')+'</div><div class="muted" style="margin-top:8px">Rollback snapshots</div><div>'+f(a.rollbackSnapshots)+'</div><div class="muted" style="margin-top:8px">Last error</div><div>'+(s.last_error||'None')+'</div><div class="muted" style="margin-top:8px">Wallet</div><code>'+x.wallet+'</code></div>'+
'<div class="card"><h2>Top market candidates</h2><table><thead><tr><th>Token</th><th>Score</th><th>5m</th><th>1h</th><th>Traders</th><th>Buy vol.</th><th>Liquidity</th></tr></thead><tbody>'+top.map(t=>'<tr><td>'+t.symbol+'</td><td>'+t.score+'</td><td>'+f(t.priceChange5m).toFixed(2)+'%</td><td>'+f(t.priceChange).toFixed(2)+'%</td><td>'+f(t.traders5m)+'</td><td>'+f(t.buyVolumeRatio5m).toFixed(2)+'x</td><td>$'+Math.round(f(t.liquidity)).toLocaleString()+'</td></tr>').join('')+'</tbody></table></div>'+
'<div class="card"><h2>Recent trades</h2><table><thead><tr><th>Time</th><th>Token</th><th>Status</th><th>Size</th><th>PnL</th><th>PnL %</th><th>Exit</th></tr></thead><tbody>'+tr.map(t=>'<tr><td>'+new Date(t.created_at).toLocaleString()+'</td><td>'+t.symbol+'</td><td>'+t.status+'</td><td>'+money(t.size_usdc)+'</td><td>'+(t.pnl_usdc==null?'—':money(t.pnl_usdc))+'</td><td>'+(t.pnl_pct==null?'—':f(t.pnl_pct).toFixed(2)+'%')+'</td><td>'+(t.exit_reason??'—')+'</td></tr>').join('')+'</tbody></table></div>'; }catch(e){document.getElementById('app').innerHTML='<div class="card bad">Dashboard error: '+String(e)+'</div>';}}
refresh();setInterval(refresh,5000);
</script></body></html>\`);
});`;
replaceBlock('app.get("/",', '\n\napp.listen', dashboard, 'dashboard route');

fs.writeFileSync(path, source);
console.log('[patch-single-market-bot-v3-dashboard] applied');
