import { NextRequest, NextResponse } from "next/server";
import { hasViewerAccess, unauthorized } from "@/lib/dashboardAuth";
import { getResearchWallet, reconstructTrades, scanResearchEvents } from "@/lib/tradeResearch";

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

export async function GET(request:NextRequest){
  if(!hasViewerAccess(request))return unauthorized();
  try{
    const url=new URL(request.url);
    const max=Math.min(100,Math.max(10,Number(url.searchParams.get("signatures")||100)));
    return NextResponse.json(await analyze(getResearchWallet(),max),{headers:{"Cache-Control":"no-store"}});
  }catch(error){console.error("[trade-research] direct analysis failed",error);return NextResponse.json({error:error instanceof Error?error.message:"Wallet analysis failed"},{status:500});}
}

export async function POST(request:NextRequest){
  if(!hasViewerAccess(request))return unauthorized();
  try{
    const body=await request.json().catch(()=>({}));
    const max=Math.min(100,Math.max(10,Number(body?.maxSignatures||100)));
    return NextResponse.json(await analyze(getResearchWallet(),max),{headers:{"Cache-Control":"no-store"}});
  }catch(error){console.error("[trade-research] direct analysis failed",error);return NextResponse.json({error:error instanceof Error?error.message:"Wallet analysis failed"},{status:500});}
}
