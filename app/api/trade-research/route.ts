import { NextRequest, NextResponse } from "next/server";
import { hasViewerAccess, unauthorized } from "@/lib/dashboardAuth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getResearchWallet, reconstructTrades, scanResearchEvents } from "@/lib/tradeResearch";

export const dynamic="force-dynamic"; export const revalidate=0; export const fetchCache="force-no-store"; export const maxDuration=60;

type ResearchTradeLike={pnlSol:number;roiPct:number|null;holdSeconds:number;entryMarketCapUsd:number|null};

function rowsToEvents(rows:any[]){
  return rows.map(row=>({signature:row.signature,tokenMint:row.token_mint,side:row.side as "buy"|"sell",solAmount:Number(row.sol_amount??0),tokenAmount:Number(row.token_amount??0),txTime:new Date(row.tx_time)}));
}
function avg(items:ResearchTradeLike[],key:keyof ResearchTradeLike){return items.length?items.reduce((s,x)=>s+Number(x[key]??0),0)/items.length:0;}

async function loadEvents(supabase:any,wallet:string){
  const {data,error}=await supabase.from("wallet_transactions").select("wallet_address,signature,token_mint,token_symbol,side,sol_amount,token_amount,tx_time,is_scalp").eq("wallet_address",wallet).order("tx_time",{ascending:true}).limit(10000);
  if(error)throw error; return data??[];
}

export async function GET(request:NextRequest){
  if(!hasViewerAccess(request))return unauthorized();
  const wallet=getResearchWallet(),supabase=getSupabaseAdmin({noStore:true});
  try{
    const rows=await loadEvents(supabase,wallet),events=rowsToEvents(rows),trades=reconstructTrades(wallet,events).filter(t=>t.outcome!=="flat");
    const wins=trades.filter(t=>t.pnlSol>0),losses=trades.filter(t=>t.pnlSol<0);
    const byMc=(max:number|null,min=0)=>{const items=trades.filter(x=>{const mc=Number(x.entryMarketCapUsd);return Number.isFinite(mc)&&mc>=min&&(max==null||mc<max);});return {min,max,trades:items.length,wins:items.filter(x=>x.pnlSol>0).length,winRate:items.length?items.filter(x=>x.pnlSol>0).length/items.length:0,avgRoi:avg(items,"roiPct"),pnlSol:items.reduce((s,x)=>s+x.pnlSol,0)};};
    return NextResponse.json({wallet,count:trades.length,rawEvents:events.length,stats:{wins:wins.length,losses:losses.length,winRate:trades.length?wins.length/trades.length:0,pnlSol:trades.reduce((s,x)=>s+x.pnlSol,0),avgWinRoi:avg(wins,"roiPct"),avgLossRoi:avg(losses,"roiPct"),avgHoldMinutes:avg(trades,"holdSeconds")/60},mcBuckets:[byMc(50000),byMc(100000,50000),byMc(250000,100000),byMc(500000,250000),byMc(1000000,500000),byMc(null,1000000)],trades:trades.slice(0,100).map(t=>({...t,entryTime:t.entryTime.toISOString(),exitTime:t.exitTime.toISOString()}))},{headers:{"Cache-Control":"no-store"}});
  }catch(error){console.error("[trade-research] GET failed",error);return NextResponse.json({error:"Existing wallet transaction data is temporarily unavailable"},{status:500});}
}

export async function POST(request:NextRequest){
  if(!hasViewerAccess(request))return unauthorized();
  const wallet=getResearchWallet(),supabase=getSupabaseAdmin({noStore:true});
  let maxSignatures=Number(process.env.TRADE_RESEARCH_BATCH_SIZE??500);
  try{const body=await request.json();if(Number.isFinite(Number(body?.maxSignatures)))maxSignatures=Math.min(1000,Math.max(50,Number(body.maxSignatures)));}catch{}
  try{
    const {data:oldest}=await supabase.from("wallet_transactions").select("signature,tx_time").eq("wallet_address",wallet).order("tx_time",{ascending:true}).limit(1).maybeSingle();
    const scan=await scanResearchEvents(wallet,maxSignatures,oldest?.signature??null);
    if(scan.events.length){
      const payload=scan.events.map(e=>({wallet_address:wallet,signature:e.signature,token_mint:e.tokenMint,side:e.side,sol_amount:e.solAmount,token_amount:e.tokenAmount,tx_time:e.txTime.toISOString(),is_scalp:false}));
      const {error}=await supabase.from("wallet_transactions").upsert(payload,{onConflict:"wallet_address,signature,token_mint,side"});
      if(error)throw error;
    }
    const rows=await loadEvents(supabase,wallet),events=rowsToEvents(rows),trades=reconstructTrades(wallet,events).filter(t=>t.outcome!=="flat");
    return NextResponse.json({ok:true,wallet,signaturesScanned:scan.signaturesScanned,eventsAdded:scan.events.length,storedEvents:events.length,closedTrades:trades.length,hasMoreHistory:scan.signaturesScanned>=maxSignatures,trades:trades.slice(0,100).map(t=>({...t,entryTime:t.entryTime.toISOString(),exitTime:t.exitTime.toISOString()})),note:"Trade Research reuses the existing wallet_transactions system. No new Supabase tables are required."});
  }catch(error){console.error("[trade-research] POST failed",error);return NextResponse.json({error:error instanceof Error?error.message:"Trade Research scan failed"},{status:500});}
}
