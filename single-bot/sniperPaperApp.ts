import express, { type Request, type Response } from "express";
import { getSupabaseAdmin } from "../lib/supabase";
import { CHAMPION_PAPER_VERSION } from "../paper-trader/championPaper";

const PORT = Number(process.env.PORT ?? 3000);
const supabase = getSupabaseAdmin();
const SERVICE_VERSION = `champion_dashboard_2026_08_05:${CHAMPION_PAPER_VERSION}`;

function n(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function performance(state: any, positions: any[], trades: any[]) {
  const wins = trades.filter((trade) => n(trade.pnl_sol) > 0);
  const losses = trades.filter((trade) => n(trade.pnl_sol) < 0);
  const grossWins = wins.reduce((sum, trade) => sum + n(trade.pnl_sol), 0);
  const grossLosses = Math.abs(losses.reduce((sum, trade) => sum + n(trade.pnl_sol), 0));
  const openValue = positions.reduce((sum, position) => {
    const entry = n(position.entry_price_usd);
    const last = n(position.last_price_usd, entry);
    const size = n(position.size_sol);
    return sum + (entry > 0 ? size * last / entry : size);
  }, 0);
  const pnlSol = trades.reduce((sum, trade) => sum + n(trade.pnl_sol), 0);
  return {
    completed: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : 0,
    pnlSol,
    profitFactor: grossLosses > 0 ? grossWins / grossLosses : null,
    equitySol: n(state?.bankroll_sol) + openValue,
    openValueSol: openValue,
  };
}

async function statusPayload() {
  const [stateResult, positionsResult, tradesResult, researchResult, candidatesResult] = await Promise.all([
    supabase.from("champion_paper_state").select("*").eq("id", 1).single(),
    supabase.from("champion_paper_positions").select("*").order("opened_at", { ascending: true }),
    supabase.from("champion_paper_trades").select("*").order("closed_at", { ascending: false }).limit(100),
    supabase.from("champion_strategy_state").select("*").eq("id", 1).single(),
    supabase.from("champion_candidates")
      .select("candidate_id,token_symbol,mint,decision,score,detected_at,decision_reasons")
      .order("detected_at", { ascending: false })
      .limit(30),
  ]);

  for (const result of [stateResult, positionsResult, tradesResult, researchResult, candidatesResult]) {
    if (result.error) throw result.error;
  }

  const state = stateResult.data;
  const positions = positionsResult.data ?? [];
  const trades = tradesResult.data ?? [];

  return {
    service: "champion-paper-bot",
    version: SERVICE_VERSION,
    mode: "paper",
    state,
    positions,
    trades,
    performance: performance(state, positions, trades),
    research: researchResult.data,
    candidates: candidatesResult.data ?? [],
  };
}

const app = express();
app.disable("x-powered-by");

app.get("/health", async (_req: Request, res: Response) => {
  try {
    const payload = await statusPayload();
    res.json({ ok: true, service: payload.service, version: payload.version, state: payload.state, research: payload.research });
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
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Champion Paper Bot</title><style>*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#071019;color:#eef6ff;margin:0;padding:14px}.wrap{max-width:1180px;margin:auto}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px}.card{background:#111d2a;border:1px solid #2d455d;border-radius:18px;padding:16px;margin:12px 0}.v{font-size:23px;font-weight:780}.muted{color:#9eb2c8}.on{color:#62e79a}.bad{color:#ff7d7d}.warn{color:#ffd06b}.item{border:1px solid #2b4055;border-radius:14px;padding:13px;margin:9px 0;background:#0d1722}.head{display:flex;justify-content:space-between;gap:10px}.title{font-size:18px;font-weight:760}.badge{font-size:12px;padding:4px 8px;border-radius:999px;background:#1d3042}.row{display:flex;justify-content:space-between;gap:12px;padding-top:7px}.break{overflow-wrap:anywhere;word-break:break-word}h1{margin:4px 0}h2{margin:2px 0 12px}@media(max-width:650px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.v{font-size:20px}}</style></head><body><div class="wrap"><h1>🏆 Champion Paper Bot</h1><div class="muted">Champion only · paper money · research runs silently · refreshes every 5 seconds</div><div id="app">Loading…</div></div><script>const f=v=>Number(v||0),num=v=>f(v).toFixed(3),pct=v=>f(v).toFixed(1)+'%',esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),when=v=>v?new Date(v).toLocaleString():'—';const metric=(k,v,c='')=>'<div class="card"><div class="muted">'+k+'</div><div class="v '+c+'">'+v+'</div></div>';function items(rows,kind){if(!rows.length)return '<div class="muted">None yet</div>';return rows.map(q=>{if(kind==='position')return '<div class="item"><div class="head"><div class="title">'+esc(q.token_symbol)+'</div><div class="badge">'+num(q.size_sol)+' SOL</div></div><div class="row"><span class="muted">Entry</span><span>$'+f(q.entry_price_usd).toFixed(8)+'</span></div><div class="row"><span class="muted">Last</span><span>$'+f(q.last_price_usd).toFixed(8)+'</span></div><div class="row"><span class="muted">Opened</span><span>'+when(q.opened_at)+'</span></div></div>';if(kind==='trade')return '<div class="item"><div class="head"><div class="title">'+esc(q.token_symbol)+'</div><div class="badge '+(f(q.pnl_sol)>=0?'on':'bad')+'">'+(f(q.pnl_sol)>=0?'+':'')+num(q.pnl_sol)+' SOL</div></div><div class="row"><span class="muted">Net</span><span class="'+(f(q.net_return_pct)>=0?'on':'bad')+'">'+f(q.net_return_pct).toFixed(2)+'%</span></div><div class="row"><span class="muted">Exit</span><span>'+esc(q.exit_reason)+'</span></div><div class="row"><span class="muted">Closed</span><span>'+when(q.closed_at)+'</span></div></div>';return '<div class="item"><div class="head"><div class="title">'+esc(q.token_symbol||q.mint?.slice(0,8))+'</div><div class="badge">'+f(q.score).toFixed(0)+'</div></div><div class="row"><span class="muted">Decision</span><span>'+esc(q.decision)+'</span></div><div class="row"><span class="muted">Time</span><span>'+when(q.detected_at)+'</span></div></div>'}).join('')}async function refresh(){try{const x=await fetch('/api/status?ts='+Date.now(),{cache:'no-store'}).then(r=>r.json());if(x.error)throw new Error(x.error);const s=x.state||{},m=x.performance||{},p=x.positions||[],t=x.trades||[],r=x.research||{},cand=x.candidates||[];document.getElementById('app').innerHTML='<div class="grid">'+metric('Status',s.enabled&&!s.halted?'ACTIVE':'STOPPED',s.enabled&&!s.halted?'on':'bad')+metric('Paper cash',num(s.bankroll_sol)+' SOL')+metric('Equity',num(m.equitySol)+' SOL')+metric('Open',p.length)+metric('Completed',m.completed||0)+metric('Win rate',pct(m.winRatePct))+metric('Paper PnL',(f(m.pnlSol)>=0?'+':'')+num(m.pnlSol)+' SOL',f(m.pnlSol)>=0?'on':'bad')+metric('Research',r.enabled?'ACTIVE':'OFF',r.enabled?'on':'warn')+'</div><div class="card"><h2>Champion configuration</h2><div class="break">'+esc(x.version)+'</div><div class="muted">Research version: '+esc(r.active_version||'—')+'</div><div class="muted">Paper only · target +10% · hard stop −4% · trailing after +6%</div></div><div class="card"><h2>Open Champion positions</h2>'+items(p,'position')+'</div><div class="card"><h2>Recent Champion trades</h2>'+items(t,'trade')+'</div><div class="card"><h2>Latest research candidates</h2>'+items(cand,'candidate')+'</div>'}catch(e){document.getElementById('app').innerHTML='<div class="card bad">Dashboard error: '+esc(String(e))+'</div>'}}refresh();setInterval(refresh,5000);</script></body></html>`);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[champion-dashboard] listening port=${PORT} version=${SERVICE_VERSION}`);
});
