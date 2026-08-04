import express, { type Request, type Response } from "express";
import { getSupabaseAdmin } from "../lib/supabase";
import { startMomentumScalperScheduler, STRATEGY_VERSION } from "../paper-trader/momentumScalper";

const PORT = Number(process.env.PORT ?? 3000);
const supabase = getSupabaseAdmin();
const SERVICE_VERSION = `sniper_paper_dashboard_2026_08_04:${STRATEGY_VERSION}`;

function n(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function statusPayload() {
  const [stateResult, positionsResult, tradesResult, scansResult] = await Promise.all([
    supabase.from("scalp_state").select("*").eq("id", 1).single(),
    supabase.from("scalp_positions").select("*").order("entry_time", { ascending: true }),
    supabase.from("scalp_trades").select("*").order("closed_at", { ascending: false }).limit(50),
    supabase.from("scalp_scan_runs").select("*").order("created_at", { ascending: false }).limit(25),
  ]);
  if (stateResult.error) throw stateResult.error;
  if (positionsResult.error) throw positionsResult.error;
  if (tradesResult.error) throw tradesResult.error;
  if (scansResult.error) throw scansResult.error;

  const state = stateResult.data;
  const positions = positionsResult.data ?? [];
  const trades = tradesResult.data ?? [];
  const scans = scansResult.data ?? [];
  const wins = trades.filter((trade: any) => n(trade.pnl_sol) > 0);
  const losses = trades.filter((trade: any) => n(trade.pnl_sol) < 0);
  const grossWins = wins.reduce((sum: number, trade: any) => sum + n(trade.pnl_sol), 0);
  const grossLosses = Math.abs(losses.reduce((sum: number, trade: any) => sum + n(trade.pnl_sol), 0));
  const openValue = positions.reduce((sum: number, position: any) => {
    const entry = n(position.entry_price_usd);
    const last = n(position.last_price_usd, entry);
    const size = n(position.size_sol);
    return sum + (entry > 0 ? size * (last / entry) : size);
  }, 0);
  const closedPnl = trades.reduce((sum: number, trade: any) => sum + n(trade.pnl_sol), 0);

  return {
    service: "paper-sniper-bot",
    version: SERVICE_VERSION,
    mode: "paper",
    state,
    positions,
    trades,
    scans,
    performance: {
      completed: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRatePct: trades.length ? (wins.length / trades.length) * 100 : 0,
      pnlSol: closedPnl,
      profitFactor: grossLosses > 0 ? grossWins / grossLosses : null,
      equitySol: n(state.bankroll_sol) + openValue,
      openValueSol: openValue,
    },
  };
}

const app = express();
app.disable("x-powered-by");
app.get("/health", async (_req: Request, res: Response) => {
  try {
    const payload = await statusPayload();
    res.json({ ok: true, service: payload.service, version: payload.version, mode: payload.mode, state: payload.state });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/status", async (_req: Request, res: Response) => {
  try {
    res.setHeader("cache-control", "no-store, no-cache, must-revalidate");
    res.json(await statusPayload());
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/", (_req: Request, res: Response) => {
  res.setHeader("cache-control", "no-store, no-cache, must-revalidate");
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Paper Sniper Bot</title><style>body{font-family:system-ui;background:#071019;color:#eef6ff;margin:0;padding:16px}.wrap{max-width:1180px;margin:auto}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px}.card{background:#111d2a;border:1px solid #273b50;border-radius:14px;padding:14px;margin:10px 0}.v{font-size:22px;font-weight:760}.muted{color:#9eb2c8}.on{color:#62e79a}.bad{color:#ff7d7d}.warn{color:#ffd06b}.small{font-size:12px}table{width:100%;border-collapse:collapse;display:block;overflow-x:auto}thead,tbody{display:table;width:100%;table-layout:fixed}th,td{padding:8px;border-bottom:1px solid #273b50;text-align:left;font-size:12px;white-space:nowrap}</style></head><body><div class="wrap"><h1>Paper Sniper Bot</h1><div class="muted">Paper money only · momentum sniper · live refreshing dashboard</div><div id="app">Loading…</div></div><script>const f=v=>Number(v||0),num=v=>f(v).toFixed(3),pct=v=>f(v).toFixed(1)+'%';async function refresh(){try{const x=await fetch('/api/status?ts='+Date.now(),{cache:'no-store'}).then(r=>r.json());if(x.error)throw new Error(x.error);const s=x.state||{},m=x.performance||{},p=x.positions||[],t=x.trades||[],r=x.scans||[];document.getElementById('app').innerHTML='<div class="grid"><div class="card"><div class="muted">Mode</div><div class="v on">PAPER</div></div><div class="card"><div class="muted">Status</div><div class="v '+(s.enabled&&!s.halted?'on':'bad')+'">'+(s.enabled&&!s.halted?'ACTIVE':s.halted?'HALTED':'DISABLED')+'</div></div><div class="card"><div class="muted">Bankroll</div><div class="v">'+num(s.bankroll_sol)+' SOL</div></div><div class="card"><div class="muted">Equity</div><div class="v">'+num(m.equitySol)+' SOL</div></div><div class="card"><div class="muted">Open positions</div><div class="v">'+p.length+'</div></div><div class="card"><div class="muted">Completed</div><div class="v">'+f(m.completed)+'</div></div><div class="card"><div class="muted">Win rate</div><div class="v">'+pct(m.winRatePct)+'</div><div class="small muted">'+f(m.wins)+'W / '+f(m.losses)+'L</div></div><div class="card"><div class="muted">Paper PnL</div><div class="v '+(f(m.pnlSol)<0?'bad':'on')+'">'+num(m.pnlSol)+' SOL</div></div><div class="card"><div class="muted">Profit factor</div><div class="v">'+(m.profitFactor==null?'—':f(m.profitFactor).toFixed(2))+'</div></div><div class="card"><div class="muted">Last scan</div><div class="small">'+(s.last_scan_at?new Date(s.last_scan_at).toLocaleString():'None')+'</div></div></div><div class="card"><div class="muted">Strategy</div><div>'+x.version+'</div><div class="muted" style="margin-top:8px">Risk status</div><div>'+(s.halt_reason||'No halt')+'</div><div class="muted" style="margin-top:8px">Armed candidate</div><div>'+(s.armed_token_symbol||'None')+(s.armed_mint?' · '+s.armed_mint:'')+'</div></div><div class="card"><h2>Open paper positions</h2><table><thead><tr><th>Token</th><th>Size</th><th>Entry</th><th>Last</th><th>Peak</th><th>Opened</th></tr></thead><tbody>'+p.map(q=>'<tr><td>'+q.token_symbol+'</td><td>'+num(q.size_sol)+' SOL</td><td>$'+f(q.entry_price_usd).toFixed(8)+'</td><td>$'+f(q.last_price_usd).toFixed(8)+'</td><td>$'+f(q.peak_price_usd).toFixed(8)+'</td><td>'+new Date(q.entry_time).toLocaleString()+'</td></tr>').join('')+'</tbody></table></div><div class="card"><h2>Latest scans</h2><table><thead><tr><th>Time</th><th>Status</th><th>Scanned</th><th>Qualified</th><th>Top</th><th>Selected</th><th>Message</th></tr></thead><tbody>'+r.map(q=>'<tr><td>'+new Date(q.created_at).toLocaleString()+'</td><td>'+q.status+'</td><td>'+f(q.scanned_count)+'</td><td>'+f(q.qualified_count)+'</td><td>'+(q.top_symbol||'—')+' '+(q.top_score==null?'':f(q.top_score).toFixed(1))+'</td><td>'+(q.selected_mint?'YES':'—')+'</td><td>'+(q.message||'')+'</td></tr>').join('')+'</tbody></table></div><div class="card"><h2>Recent paper trades</h2><table><thead><tr><th>Closed</th><th>Token</th><th>Size</th><th>Net return</th><th>PnL</th><th>Exit</th></tr></thead><tbody>'+t.map(q=>'<tr><td>'+new Date(q.closed_at).toLocaleString()+'</td><td>'+q.token_symbol+'</td><td>'+num(q.size_sol)+'</td><td class="'+(f(q.net_return_pct)<0?'bad':'on')+'">'+f(q.net_return_pct).toFixed(2)+'%</td><td class="'+(f(q.pnl_sol)<0?'bad':'on')+'">'+num(q.pnl_sol)+'</td><td>'+q.exit_reason+'</td></tr>').join('')+'</tbody></table></div>';}catch(e){document.getElementById('app').innerHTML='<div class="card bad">Dashboard error: '+String(e)+'</div>';}}refresh();setInterval(refresh,5000);</script></body></html>`);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[paper-sniper] dashboard listening port=${PORT} version=${SERVICE_VERSION}`);
});

startMomentumScalperScheduler();
