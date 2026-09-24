"use client";

import { useCallback, useEffect, useState } from "react";

type Data = {
  wallet: string; count: number;
  stats: { wins:number; losses:number; winRate:number; pnlSol:number; avgWinRoi:number; avgLossRoi:number; avgHoldMinutes:number };
  mcBuckets: {min:number; max:number|null; trades:number; wins:number; winRate:number; avgRoi:number; pnlSol:number}[];
  trades: any[];
};

const money = (n:any) => Number(n ?? 0).toFixed(3);
const pct = (n:any) => Number(n ?? 0).toFixed(1);
const time = (v:any) => v ? new Date(v).toLocaleString("en-IL",{dateStyle:"short",timeStyle:"short"}) : "—";

export default function TradeResearchPage() {
  const [data,setData] = useState<Data|null>(null);
  const [error,setError] = useState("");
  const [busy,setBusy] = useState(false);

  const load = useCallback(async()=>{
    const r=await fetch("/api/trade-research",{cache:"no-store"});
    if(r.status===401){setError("Open the main dashboard and log in first.");return;}
    const j=await r.json();
    if(!r.ok){setError(j.error||"Failed to load");return;}
    setData(j);
  },[]);

  useEffect(()=>{void load();},[load]);

  async function scan() {
    setBusy(true); setError("");
    try {
      const r=await fetch("/api/trade-research",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({maxSignatures:500})});
      const j=await r.json();
      if(!r.ok) throw new Error(j.error||"Scan failed");
      await load();
    } catch(e) { setError(e instanceof Error?e.message:String(e)); }
    finally { setBusy(false); }
  }

  return <main style={s.page}><div style={s.wrap}>
    <header style={s.header}>
      <div><div style={s.kicker}>SOLANA TRADE LAB</div><h1 style={s.h1}>Your Trading History</h1>
      <p style={s.muted}>On-chain first. Social + narrative enrichment comes after the raw history is reconstructed.</p></div>
      <button style={s.button} onClick={scan} disabled={busy}>{busy?"SCANNING…":"SCAN 500 TRANSACTIONS"}</button>
    </header>

    {error && <div style={s.error}>{error}</div>}
    {data && <>
      <div style={s.wallet}><b>Wallet</b><code>{data.wallet}</code><span>{data.count} closed trades stored</span></div>
      <section style={s.grid}>
        <Card t="Win rate" v={pct(data.stats.winRate*100)+"%"} />
        <Card t="Realized P&L" v={money(data.stats.pnlSol)+" SOL"} />
        <Card t="Wins" v={String(data.stats.wins)} />
        <Card t="Losses" v={String(data.stats.losses)} />
        <Card t="Avg winning ROI" v={pct(data.stats.avgWinRoi)+"%"} />
        <Card t="Avg losing ROI" v={pct(data.stats.avgLossRoi)+"%"} />
        <Card t="Avg hold" v={pct(data.stats.avgHoldMinutes)+" min"} />
      </section>

      <section style={s.card}><h2>Entry market-cap buckets</h2><p style={s.muted}>These will populate after historical market-cap enrichment. The raw on-chain trades are already being collected.</p>
        <table><thead><tr><th>Entry MC</th><th>Trades</th><th>Win rate</th><th>Avg ROI</th><th>P&L SOL</th></tr></thead>
        <tbody>{data.mcBuckets.map((b,i)=><tr key={i}><td>{b.max==null ? "> $1M" : "$"+b.min/1000+"K–$"+b.max/1000+"K"}</td><td>{b.trades}</td><td>{pct(b.winRate*100)}%</td><td>{pct(b.avgRoi)}%</td><td>{money(b.pnlSol)}</td></tr>)}</tbody></table>
      </section>

      <section style={s.card}><h2>Recent reconstructed trades</h2>
        <div style={s.scroll}><table><thead><tr><th>Token</th><th>Entry</th><th>Exit</th><th>Hold</th><th>Entry SOL</th><th>P&L</th><th>ROI</th><th>Result</th></tr></thead>
        <tbody>{data.trades.slice(0,100).map(t=><tr key={t.id}><td><code>{String(t.token_mint).slice(0,8)}…</code></td><td>{time(t.entry_time)}</td><td>{time(t.exit_time)}</td><td>{Math.round(Number(t.hold_seconds)/60)}m</td><td>{money(t.entry_sol)}</td><td>{money(t.pnl_sol)}</td><td>{pct(t.roi_pct)}%</td><td>{t.outcome}</td></tr>)}</tbody></table></div>
      </section>

      <section style={s.card}><h2>Next enrichment</h2><div style={s.next}>Narrative → creator → follower tier → social lead time → community traction → drawdown → realized outcome.</div></section>
    </>}
  </div></main>
}

function Card({t,v}:{t:string;v:string}){return <div style={s.card}><small style={s.muted}>{t}</small><strong style={{fontSize:25}}>{v}</strong></div>}

const s:Record<string,React.CSSProperties>={
 page:{minHeight:"100vh",background:"#080d15",color:"#f4f7fb",padding:"24px 14px 60px",fontFamily:"Inter,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif"},
 wrap:{maxWidth:1150,margin:"0 auto"},header:{display:"flex",justifyContent:"space-between",gap:16,flexWrap:"wrap",alignItems:"flex-start"},
 kicker:{color:"#8290a5",fontWeight:800,letterSpacing:".12em"},h1:{fontSize:"clamp(32px,7vw,50px)",margin:"6px 0",letterSpacing:"-.04em"},muted:{color:"#8997aa"},
 button:{border:0,borderRadius:12,padding:"13px 16px",fontWeight:900,background:"#f4f7fb",color:"#080d15"},error:{margin:"16px 0",padding:13,borderRadius:12,border:"1px solid #6b2b38",color:"#ff7b8d"},
 wallet:{margin:"18px 0",padding:14,borderRadius:14,border:"1px solid #223149",background:"#111a27",display:"flex",gap:12,flexWrap:"wrap",alignItems:"center"},grid:{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(145px,1fr))",gap:10},
 card:{margin:"14px 0",padding:18,borderRadius:18,border:"1px solid #223149",background:"#111a27",display:"grid",gap:8},scroll:{overflowX:"auto"},next:{fontSize:18,lineHeight:1.5},
};
