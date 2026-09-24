import { NextRequest, NextResponse } from "next/server";
import { hasViewerAccess, unauthorized } from "@/lib/dashboardAuth";
import { getResearchWallet, reconstructTrades, scanResearchEvents } from "@/lib/tradeResearch";
import { sendTelegramAlert } from "@/lib/telegram";


export const dynamic="force-dynamic";
export const revalidate=0;
export const fetchCache="force-no-store";
export const maxDuration=60;

function avg(items:any[], key:string){return items.length?items.reduce((s,x)=>s+Number(x[key]??0),0)/items.length:0;}
function maxDrawdown(trades:any[]){
  let equity=0,peak=0,dd=0;
  for(const t of [...trades].sort((a,b)=>a.exitTime.getTime()-b.exitTime.getTime())){equity+=t.pnlSol;peak=Math.max(peak,equity);dd=Math.max(dd,peak-equity);}
  return dd;
}
function streaks(trades:any[]){
  let win=0,loss=0,maxWin=0,maxLoss=0;
  for(const t of [...trades].sort((a,b)=>a.exitTime.getTime()-b.exitTime.getTime())){
    if(t.pnlSol>0){win++;loss=0;maxWin=Math.max(maxWin,win);} else if(t.pnlSol<0){loss++;win=0;maxLoss=Math.max(maxLoss,loss);}
  }
  return {maxWinStreak:maxWin,maxLossStreak:maxLoss};
}
function holdBuckets(trades:any[]){
  const buckets=[["<1m",0,60],["1–5m",60,300],["5–15m",300,900],["15–60m",900,3600],["1–6h",3600,21600],[">6h",21600,Infinity]];
  return buckets.map(([label,min,max])=>{const items=trades.filter(t=>t.holdSeconds>=Number(min)&&t.holdSeconds<Number(max));return {label,trades:items.length,winRate:items.length?items.filter(t=>t.pnlSol>0).length/items.length:0,pnlSol:items.reduce((s,t)=>s+t.pnlSol,0),avgRoi:avg(items,"roiPct")};});
}
function exitAfterSale(trades:any[]){return {note:"Requires historical token-price candles. On-chain trade reconstruction is enabled now; market-price enrichment is the next layer."};}

async function analyze(wallet:string,maxSignatures:number){
  const scan=await scanResearchEvents(wallet,maxSignatures);
  const trades=reconstructTrades(wallet,scan.events).filter(t=>t.outcome!=="flat");
  const wins=trades.filter(t=>t.pnlSol>0),losses=trades.filter(t=>t.pnlSol<0);
  const grossWin=wins.reduce((s,t)=>s+t.pnlSol,0),grossLoss=Math.abs(losses.reduce((s,t)=>s+t.pnlSol,0));
  const pnl=trades.reduce((s,t)=>s+t.pnlSol,0);
  return {wallet,signaturesScanned:scan.signaturesScanned,rawEvents:scan.events.length,count:trades.length,hasMoreHistory:scan.signaturesScanned>=maxSignatures,stats:{
    wins:wins.length,losses:losses.length,winRate:trades.length?wins.length/trades.length:0,pnlSol:pnl,
    avgWinRoi:avg(wins,"roiPct"),avgLossRoi:avg(losses,"roiPct"),avgHoldMinutes:avg(trades,"holdSeconds")/60,
    profitFactor:grossLoss?grossWin/grossLoss:null,expectancySol:trades.length?pnl/trades.length:0,
    maxDrawdownSol:maxDrawdown(trades),...streaks(trades)
  },holdBuckets:holdBuckets(trades),mcEnrichment:[],priceEnrichment:exitAfterSale(trades),
  trades:trades.slice(0,200).map(t=>({...t,entryTime:t.entryTime.toISOString(),exitTime:t.exitTime.toISOString()}))};
}



async function enrichWinner(tokenMint:string){
  try{
    const r=await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`,{cache:"no-store"});
    if(!r.ok)return null;
    const j=await r.json();
    const pair=(j.pairs??[]).filter((p:any)=>p.chainId==="solana").sort((a:any,b:any)=>Number(b.liquidity?.usd??0)-Number(a.liquidity?.usd??0))[0];
    if(!pair)return null;
    return {
      symbol:pair.baseToken?.symbol??null,
      marketCapUsd:Number(pair.marketCap??pair.fdv??0)||null,
      liquidityUsd:Number(pair.liquidity?.usd??0)||null,
      volume24hUsd:Number(pair.volume?.h24??0)||null,
      priceChange24h:Number(pair.priceChange?.h24??0)||null,
      socials:Array.isArray(pair.info?.socials)?pair.info.socials.map((x:any)=>({type:x.type,url:x.url})).slice(0,5):[],
      websites:Array.isArray(pair.info?.websites)?pair.info.websites.map((x:any)=>x.url).slice(0,3):[]
    };
  }catch{return null;}
}

async function analyzeBigWinners(wallet:string,maxSignatures:number){
  const scan=await scanResearchEvents(wallet,maxSignatures);
  const trades=reconstructTrades(wallet,scan.events).filter(t=>t.pnlSol>0);
  const winners=trades.sort((a,b)=>Number(b.pnlSol)-Number(a.pnlSol)).slice(0,5);
  const enriched=[];
  for(const t of winners){
    enriched.push({...t,context:await enrichWinner(t.tokenMint)});
  }
  const lines=["🏆 <b>BIG WINNERS — TRADE RESEARCH</b>","",`Wallet: <code>${wallet}</code>`,`Analyzed: <b>${scan.signaturesScanned}</b> transactions`,`Top winners analyzed: <b>${enriched.length}</b>`,""];
  for(let i=0;i<enriched.length;i++){
    const t:any=enriched[i], c=t.context;
    lines.push(`<b>#${i+1} ${c?.symbol??"Unknown token"}</b>`,
      `P&L: <b>+${Number(t.pnlSol).toFixed(4)} SOL</b> | ROI: <b>${Number(t.roiPct??0).toFixed(1)}%</b>`,
      `Hold: <b>${Math.round(Number(t.holdSeconds)/60)} min</b> | Entry: ${Number(t.entrySol).toFixed(4)} SOL`,
      `Mint: <code>${t.tokenMint}</code>`);
    if(c){
      lines.push(`Current liquidity: <b>${Math.round(c.liquidityUsd??0).toLocaleString()}</b> | MC: <b>${Math.round(c.marketCapUsd??0).toLocaleString()}</b>`);
      lines.push(`Current 24h volume: <b>${Math.round(c.volume24hUsd??0).toLocaleString()}</b> | 24h move: <b>${Number(c.priceChange24h??0).toFixed(1)}%</b>`);
      lines.push(`Socials currently listed: <b>${c.socials.length}</b>${c.socials.length?\` — ${c.socials.map((s:any)=>s.type).join(", ")}\`:""}`);
    }
    lines.push(`📈 https://dexscreener.com/solana/${t.tokenMint}`,"");
  }
  lines.push("🧠 <b>What this tells us:</b> the next dashboard step should compare these big winners against your losing trades using entry conditions, holding time, liquidity/market-cap context and historical social activity. Current DexScreener social links are context only — they do not prove why a trade won.");
  await sendTelegramAlert(lines.join("\n"),{forceOperational:true});
  return {wallet,signaturesScanned:scan.signaturesScanned,winners:enriched.map((t:any)=>({...t,entryTime:t.entryTime.toISOString(),exitTime:t.exitTime.toISOString()}))};
}

export async function GET(request:NextRequest){
  if(!hasViewerAccess(request))return unauthorized();
  try{
    const url=new URL(request.url);
    const max=Math.min(1000,Math.max(10,Number(url.searchParams.get("signatures")||1000)));
    return NextResponse.json(await analyze(getResearchWallet(),max),{headers:{"Cache-Control":"no-store"}});
  }catch(error){console.error("[trade-research] direct analysis failed",error);return NextResponse.json({error:error instanceof Error?error.message:"Wallet analysis failed"},{status:500});}
}

export async function POST(request:NextRequest){
  if(!hasViewerAccess(request))return unauthorized();
  try{
    const body=await request.json().catch(()=>({}));
    const max=Math.min(1000,Math.max(10,Number(body?.maxSignatures||1000)));
    return NextResponse.json(await analyze(getResearchWallet(),max),{headers:{"Cache-Control":"no-store"}});
  }catch(error){console.error("[trade-research] direct analysis failed",error);return NextResponse.json({error:error instanceof Error?error.message:"Wallet analysis failed"},{status:500});}
}
