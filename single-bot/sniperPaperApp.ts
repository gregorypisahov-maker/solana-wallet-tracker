import express, { type Request, type Response } from "express";
import { getSupabaseAdmin } from "../lib/supabase";
import { CHAMPION_PAPER_VERSION } from "../paper-trader/championPaper";
import {
  getJijoCopyStatus,
  JIJO_COPY_VERSION,
} from "../copy-trader/jijoCopyTrader";

const PORT = Number(process.env.PORT ?? 3000);
const supabase = getSupabaseAdmin();
const SERVICE_VERSION =
  `champion_dashboard_2026_08_06:${CHAMPION_PAPER_VERSION}:${JIJO_COPY_VERSION}`;

function n(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function performance(state: any, positions: any[], trades: any[]) {
  const wins = trades.filter((trade) => n(trade.pnl_sol) > 0);
  const losses = trades.filter((trade) => n(trade.pnl_sol) < 0);
  const grossWins = wins.reduce((sum, trade) => sum + n(trade.pnl_sol), 0);
  const grossLosses = Math.abs(
    losses.reduce((sum, trade) => sum + n(trade.pnl_sol), 0)
  );
  const openValue = positions.reduce((sum, position) => {
    const entry = n(position.entry_price_usd);
    const last = n(position.last_price_usd, entry);
    const size = n(position.size_sol);
    return sum + (entry > 0 ? (size * last) / entry : size);
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
  const [
    stateResult,
    positionsResult,
    tradesResult,
    researchResult,
    candidatesResult,
    jijo,
  ] = await Promise.all([
    supabase.from("champion_paper_state").select("*").eq("id", 1).single(),
    supabase
      .from("champion_paper_positions")
      .select("*")
      .order("opened_at", { ascending: true }),
    supabase
      .from("champion_paper_trades")
      .select("*")
      .order("closed_at", { ascending: false })
      .limit(100),
    supabase.from("champion_strategy_state").select("*").eq("id", 1).single(),
    supabase
      .from("champion_candidates")
      .select(
        "candidate_id,token_symbol,mint,decision,score,detected_at,decision_reasons"
      )
      .order("detected_at", { ascending: false })
      .limit(30),
    getJijoCopyStatus(),
  ]);

  for (const result of [
    stateResult,
    positionsResult,
    tradesResult,
    researchResult,
    candidatesResult,
  ]) {
    if (result.error) throw result.error;
  }

  const state = stateResult.data;
  const positions = positionsResult.data ?? [];
  const trades = tradesResult.data ?? [];

  return {
    service: "champion-and-jijo-copy-bot",
    version: SERVICE_VERSION,
    mode: "champion-paper+jijo-live-capable",
    state,
    positions,
    trades,
    performance: performance(state, positions, trades),
    research: researchResult.data,
    candidates: candidatesResult.data ?? [],
    jijo,
  };
}

const app = express();
app.disable("x-powered-by");

app.get("/health", async (_req: Request, res: Response) => {
  try {
    const payload = await statusPayload();
    res.json({
      ok: true,
      service: payload.service,
      version: payload.version,
      state: payload.state,
      research: payload.research,
      jijo: {
        runtimeArmed: (payload.jijo as any)?.runtimeArmed,
        state: (payload.jijo as any)?.state,
      },
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get("/api/status", async (_req: Request, res: Response) => {
  try {
    res.setHeader("cache-control", "no-store, no-cache, must-revalidate");
    res.json(await statusPayload());
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get("/api/jijo-copy", async (_req: Request, res: Response) => {
  try {
    res.setHeader("cache-control", "no-store, no-cache, must-revalidate");
    res.json(await getJijoCopyStatus());
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get("/", (_req: Request, res: Response) => {
  res.setHeader("cache-control", "no-store, no-cache, must-revalidate");
  res.type("html").send(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Champion + Jijo Copy Bot</title>
<style>
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#071019;color:#eef6ff;margin:0;padding:14px}
.wrap{max-width:1180px;margin:auto}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px}
.card{background:#111d2a;border:1px solid #2d455d;border-radius:18px;padding:16px;margin:12px 0}
.v{font-size:23px;font-weight:780}.muted{color:#9eb2c8}.on{color:#62e79a}.bad{color:#ff7d7d}.warn{color:#ffd06b}
.item{border:1px solid #2b4055;border-radius:14px;padding:13px;margin:9px 0;background:#0d1722}
.head{display:flex;justify-content:space-between;gap:10px}.title{font-size:18px;font-weight:760}
.badge{font-size:12px;padding:4px 8px;border-radius:999px;background:#1d3042}
.row{display:flex;justify-content:space-between;gap:12px;padding-top:7px}.break{overflow-wrap:anywhere;word-break:break-word}
h1{margin:4px 0}h2{margin:2px 0 12px}.section{margin-top:24px;border-top:1px solid #294158;padding-top:20px}
a{color:#8bc8ff}
@media(max-width:650px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.v{font-size:20px}}
</style>
</head>
<body>
<div class="wrap">
<h1>🏆 Champion + 👤 Jijo Copy Bot</h1>
<div class="muted">Champion paper strategy remains frozen · Jijo watcher accepts signer-verified transactions only · refreshes every 5 seconds</div>
<div id="app">Loading…</div>
</div>
<script>
const f=v=>Number(v||0),num=v=>f(v).toFixed(3),pct=v=>f(v).toFixed(1)+'%',
esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
when=v=>v?new Date(v).toLocaleString():'—',
short=v=>String(v||'').length>16?String(v).slice(0,7)+'…'+String(v).slice(-5):String(v||'—');
const metric=(k,v,c='')=>'<div class="card"><div class="muted">'+k+'</div><div class="v '+c+'">'+v+'</div></div>';

function championItems(rows,kind){
  if(!rows.length)return '<div class="muted">None yet</div>';
  return rows.map(q=>{
    if(kind==='position')return '<div class="item"><div class="head"><div class="title">'+esc(q.token_symbol)+'</div><div class="badge">'+num(q.size_sol)+' SOL</div></div><div class="row"><span class="muted">Entry</span><span>$'+f(q.entry_price_usd).toFixed(8)+'</span></div><div class="row"><span class="muted">Last</span><span>$'+f(q.last_price_usd).toFixed(8)+'</span></div><div class="row"><span class="muted">Opened</span><span>'+when(q.opened_at)+'</span></div></div>';
    if(kind==='trade')return '<div class="item"><div class="head"><div class="title">'+esc(q.token_symbol)+'</div><div class="badge '+(f(q.pnl_sol)>=0?'on':'bad')+'">'+(f(q.pnl_sol)>=0?'+':'')+num(q.pnl_sol)+' SOL</div></div><div class="row"><span class="muted">Net</span><span class="'+(f(q.net_return_pct)>=0?'on':'bad')+'">'+f(q.net_return_pct).toFixed(2)+'%</span></div><div class="row"><span class="muted">Exit</span><span>'+esc(q.exit_reason)+'</span></div><div class="row"><span class="muted">Closed</span><span>'+when(q.closed_at)+'</span></div></div>';
    return '<div class="item"><div class="head"><div class="title">'+esc(q.token_symbol||short(q.mint))+'</div><div class="badge">'+f(q.score).toFixed(0)+'</div></div><div class="row"><span class="muted">Decision</span><span>'+esc(q.decision)+'</span></div><div class="row"><span class="muted">Time</span><span>'+when(q.detected_at)+'</span></div></div>';
  }).join('');
}

function jijoPositions(rows){
  if(!rows.length)return '<div class="muted">No copied positions</div>';
  return rows.map(q=>'<div class="item"><div class="head"><div class="title">'+esc(q.token_symbol||short(q.mint))+'</div><div class="badge '+(q.status==='open'?'on':q.status==='closed'?'':'bad')+'">'+esc(q.status)+'</div></div><div class="row"><span class="muted">Cost remaining</span><span>'+num(q.spent_sol)+' SOL</span></div><div class="row"><span class="muted">Realized PnL</span><span class="'+(f(q.realized_pnl_sol)>=0?'on':'bad')+'">'+(f(q.realized_pnl_sol)>=0?'+':'')+num(q.realized_pnl_sol)+' SOL</span></div><div class="row"><span class="muted">Tokens</span><span class="break">'+esc(q.token_amount)+'</span></div><div class="row"><span class="muted">Updated</span><span>'+when(q.updated_at)+'</span></div></div>').join('');
}

function jijoEvents(rows){
  if(!rows.length)return '<div class="muted">No signer-verified Jijo trades detected since deployment</div>';
  return rows.slice(0,30).map(q=>{
    const cls=q.status==='confirmed'?'on':q.status==='failed'||q.status==='blocked'?'bad':'warn';
    return '<div class="item"><div class="head"><div class="title">'+(q.side==='buy'?'BUY ':'SELL ')+esc(q.token_symbol||short(q.mint))+'</div><div class="badge '+cls+'">'+esc(q.status)+'</div></div><div class="row"><span class="muted">Jijo SOL delta</span><span>'+(f(q.target_sol_delta)>=0?'+':'')+f(q.target_sol_delta).toFixed(4)+' SOL</span></div><div class="row"><span class="muted">Our SOL delta</span><span>'+(f(q.our_actual_sol_delta)>=0?'+':'')+f(q.our_actual_sol_delta).toFixed(6)+' SOL</span></div><div class="row"><span class="muted">Reason</span><span class="break">'+esc(q.reason||'—')+'</span></div><div class="row"><span class="muted">Detected</span><span>'+when(q.detected_at)+'</span></div>'+(q.signature?'<div class="row"><a target="_blank" rel="noreferrer" href="https://solscan.io/tx/'+encodeURIComponent(q.signature)+'">Jijo tx</a>'+(q.our_tx_signature?'<a target="_blank" rel="noreferrer" href="https://solscan.io/tx/'+encodeURIComponent(q.our_tx_signature)+'">Our tx</a>':'')+'</div>':'')+'</div>';
  }).join('');
}

async function refresh(){
  try{
    const x=await fetch('/api/status?ts='+Date.now(),{cache:'no-store'}).then(r=>r.json());
    if(x.error)throw new Error(x.error);
    const s=x.state||{},m=x.performance||{},p=x.positions||[],t=x.trades||[],r=x.research||{},cand=x.candidates||[];
    const j=x.jijo||{},js=j.state||{},jp=j.positions||[],je=j.events||[],jm=j.performance||{};
    const jLive=js.enabled&&!js.halted&&j.runtimeArmed;
    document.getElementById('app').innerHTML=
      '<div class="grid">'+
      metric('Champion',s.enabled&&!s.halted?'ACTIVE':'STOPPED',s.enabled&&!s.halted?'on':'bad')+
      metric('Paper cash',num(s.bankroll_sol)+' SOL')+
      metric('Champion equity',num(m.equitySol)+' SOL')+
      metric('Champion completed',m.completed||0)+
      metric('Champion win rate',pct(m.winRatePct))+
      metric('Champion PnL',(f(m.pnlSol)>=0?'+':'')+num(m.pnlSol)+' SOL',f(m.pnlSol)>=0?'on':'bad')+
      '</div>'+
      '<div class="card"><h2>Champion configuration</h2><div class="break">'+esc(x.version)+'</div><div class="muted">Research: '+esc(r.active_version||'—')+'</div><div class="muted">Paper only · target +10% · hard stop −4% · trailing after +6%</div></div>'+
      '<div class="card"><h2>Open Champion positions</h2>'+championItems(p,'position')+'</div>'+
      '<div class="card"><h2>Recent Champion trades</h2>'+championItems(t,'trade')+'</div>'+
      '<div class="section"><h2>👤 Jijo signer-verified copy trader</h2>'+
      '<div class="grid">'+
      metric('Copy status',jLive?'LIVE ARMED':js.enabled&&!js.halted?'WAITING FOR ARM':'WATCHING',jLive?'on':js.halted?'warn':'')+
      metric('Runtime armed',j.runtimeArmed?'YES':'NO',j.runtimeArmed?'on':'warn')+
      metric('Copy ratio',(f(js.copy_ratio)*100).toFixed(3)+'%')+
      metric('Max position',num(js.max_position_sol)+' SOL')+
      metric('Open copied',jp.filter(q=>q.status==='open').length)+
      metric('Confirmed buys',js.confirmed_buys||0)+
      metric('Confirmed sells',js.confirmed_sells||0)+
      metric('Realized PnL',(f(jm.realizedPnlSol)>=0?'+':'')+num(jm.realizedPnlSol)+' SOL',f(jm.realizedPnlSol)>=0?'on':'bad')+
      '</div>'+
      '<div class="card"><div class="row"><span class="muted">Target wallet</span><span class="break">'+esc(js.target_wallet||'—')+'</span></div><div class="row"><span class="muted">Mode</span><span>'+esc(js.execution_mode||'—')+'</span></div><div class="row"><span class="muted">Halt reason</span><span class="break">'+esc(js.halt_reason||'—')+'</span></div><div class="row"><span class="muted">Last heartbeat</span><span>'+when(js.last_heartbeat_at)+'</span></div><div class="row"><span class="muted">Last source activity</span><span>'+when(js.last_seen_at)+'</span></div></div>'+
      '<div class="card"><h2>Copied positions</h2>'+jijoPositions(jp)+'</div>'+
      '<div class="card"><h2>Latest signer-verified Jijo events</h2>'+jijoEvents(je)+'</div>'+
      '</div>'+
      '<div class="card"><h2>Latest Champion research candidates</h2>'+championItems(cand,'candidate')+'</div>';
  }catch(e){
    document.getElementById('app').innerHTML='<div class="card bad">Dashboard error: '+esc(String(e))+'</div>';
  }
}
refresh();setInterval(refresh,5000);
</script>
</body>
</html>`);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `[champion-dashboard] listening port=${PORT} version=${SERVICE_VERSION}`
  );
});
