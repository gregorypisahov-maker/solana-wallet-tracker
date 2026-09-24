import { Connection, PublicKey, ParsedTransactionWithMeta } from "@solana/web3.js";

const WSOL = "So11111111111111111111111111111111111111112";
const DEFAULT_WALLET = "xR4kCX6N2MNqxbY78VGxUKmTBwvweHT85bvxYBn32Dx";

export type ResearchEvent = { signature:string; tokenMint:string; side:"buy"|"sell"; solAmount:number; tokenAmount:number; txTime:Date; };
export type ResearchTrade = {
  walletAddress:string; tokenMint:string; entryTime:Date; exitTime:Date; holdSeconds:number;
  entrySol:number; exitSol:number; pnlSol:number; roiPct:number|null; initialPositionUsd:number|null;
  entryMarketCapUsd:number|null; exitMarketCapUsd:number|null; maxDrawdownPct:number|null; maxRunupPct:number|null;
  outcome:"win"|"loss"|"flat"; metadata:Record<string,unknown>;
};

export function getResearchWallet(){ return process.env.TRADE_RESEARCH_WALLET?.trim() || DEFAULT_WALLET; }

function getConnection(){
  const url=process.env.SOLANA_RPC_URL?.trim()||process.env.HELIUS_RPC_URL?.trim()||process.env.ALCHEMY_RPC_URL?.trim();
  if(!url) throw new Error("Missing SOLANA_RPC_URL, HELIUS_RPC_URL, or ALCHEMY_RPC_URL");
  return new Connection(url,{commitment:"confirmed",disableRetryOnRateLimit:true});
}

function tokenDelta(tx:ParsedTransactionWithMeta,wallet:string){
  const pre=(tx.meta?.preTokenBalances??[]).filter(b=>b.owner===wallet&&b.mint!==WSOL);
  const post=(tx.meta?.postTokenBalances??[]).filter(b=>b.owner===wallet&&b.mint!==WSOL);
  const mints=new Set([...pre.map(x=>x.mint),...post.map(x=>x.mint)]);
  let best:{mint:string;delta:number}|null=null;
  for(const mint of mints){
    const a=pre.find(x=>x.mint===mint), b=post.find(x=>x.mint===mint);
    const delta=Number(b?.uiTokenAmount.uiAmount??0)-Number(a?.uiTokenAmount.uiAmount??0);
    if(!best||Math.abs(delta)>Math.abs(best.delta)) best={mint,delta};
  }
  return best;
}

function parseEvent(tx:any,wallet:string,signature:string):ResearchEvent|null{
  if(!tx.meta||!tx.blockTime)return null;
  const keys=tx.transaction.message.accountKeys.map((k:any)=>typeof k.pubkey==="string"?k.pubkey:k.pubkey.toBase58());
  const idx=keys.indexOf(wallet); if(idx<0)return null;
  const solDelta=((tx.meta.postBalances[idx]??0)-(tx.meta.preBalances[idx]??0))/1e9;
  const token=tokenDelta(tx,wallet); if(!token||!token.delta)return null;
  const fee=(tx.meta.fee??0)/1e9;
  if(token.delta>0&&solDelta<-fee)return {signature,tokenMint:token.mint,side:"buy",solAmount:Math.abs(solDelta),tokenAmount:token.delta,txTime:new Date(tx.blockTime*1000)};
  if(token.delta<0&&solDelta>0)return {signature,tokenMint:token.mint,side:"sell",solAmount:Math.abs(solDelta),tokenAmount:Math.abs(token.delta),txTime:new Date(tx.blockTime*1000)};
  return null;
}

async function sleep(ms:number){return new Promise(resolve=>setTimeout(resolve,ms));}

async function fetchAddressTransactions(url:string,wallet:string,maxSignatures:number){
  const results:any[]=[];
  let paginationToken:string|undefined;
  while(results.length<maxSignatures){
    const limit=Math.min(100,maxSignatures-results.length);
    const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
      jsonrpc:"2.0",
      id:`trade-research-${results.length}`,
      method:"getTransactionsForAddress",
      params:[wallet,{
        transactionDetails:"full",
        sortOrder:"desc",
        limit,
        paginationToken,
        commitment:"confirmed",
        encoding:"jsonParsed",
        maxSupportedTransactionVersion:1,
        filters:{status:"succeeded",tokenAccounts:"balanceChanged"}
      }]
    }),cache:"no-store"});
    if(response.status===429){await sleep(1000);continue;}
    if(!response.ok)throw new Error(`Solana RPC HTTP ${response.status}`);
    const body=await response.json();
    if(body.error)throw new Error(body.error.message||"Solana RPC transaction history error");
    const page=Array.isArray(body.result?.data)?body.result.data:(Array.isArray(body.result?.transactions)?body.result.transactions:[]);
    if(!page.length)break;
    results.push(...page);
    paginationToken=body.result?.paginationToken||undefined;
    if(!paginationToken)break;
  }
  return results.slice(0,maxSignatures);
}

export async function scanResearchEvents(wallet=getResearchWallet(),maxSignatures=Math.min(Number(process.env.TRADE_RESEARCH_MAX_SIGNATURES??1000),1000)){
  const connection=getConnection();
  const url=connection.rpcEndpoint;
  const items=await fetchAddressTransactions(url,wallet,maxSignatures);
  const events:ResearchEvent[]=[];
  for(const item of items){
    const tx=item?.transaction?{transaction:item.transaction,meta:item.meta,blockTime:item.blockTime}:item;
    const signature=item?.transaction?.signatures?.[0]||item?.signature;
    if(!signature)continue;
    const event=parseEvent(tx,wallet,signature);
    if(event)events.push(event);
  }
  return {signaturesScanned:items.length,events,nextBeforeSignature:null};
}

export function reconstructTrades(walletAddress:string,events:ResearchEvent[]){
  const byToken=new Map<string,ResearchEvent[]>();
  for(const event of events){const list=byToken.get(event.tokenMint)??[];list.push(event);byToken.set(event.tokenMint,list);}
  const trades:ResearchTrade[]=[];
  for(const [tokenMint,list] of byToken){
    list.sort((a,b)=>a.txTime.getTime()-b.txTime.getTime());
    const lots:{time:Date;sol:number;tokens:number}[]=[];
    for(const event of list){
      if(event.side==="buy"){lots.push({time:event.txTime,sol:event.solAmount,tokens:event.tokenAmount});continue;}
      let remaining=event.tokenAmount,allocatedSol=0,allocatedTokens=0,firstEntry:Date|null=null;
      while(remaining>0&&lots.length){
        const lot=lots[0],originalTokens=lot.tokens,take=Math.min(remaining,originalTokens);
        allocatedSol+=lot.sol*(take/originalTokens);allocatedTokens+=take;firstEntry=firstEntry??lot.time;
        lot.tokens-=take;lot.sol-=lot.sol*(take/originalTokens);remaining-=take;
        if(lot.tokens<=1e-12)lots.shift();
      }
      if(allocatedTokens<=0||!firstEntry)continue;
      const exitSol=event.solAmount*(allocatedTokens/event.tokenAmount),pnlSol=exitSol-allocatedSol;
      trades.push({
        walletAddress,tokenMint,entryTime:firstEntry,exitTime:event.txTime,
        holdSeconds:Math.max(0,Math.round((event.txTime.getTime()-firstEntry.getTime())/1000)),
        entrySol:allocatedSol,exitSol,pnlSol,roiPct:allocatedSol>0?(pnlSol/allocatedSol)*100:null,
        initialPositionUsd:null,entryMarketCapUsd:null,exitMarketCapUsd:null,maxDrawdownPct:null,maxRunupPct:null,
        outcome:pnlSol>1e-9?"win":pnlSol< -1e-9?"loss":"flat",
        metadata:{allocation:"FIFO",unmatchedTokenAmount:remaining,source:"solana_rpc",sourceSignature:event.signature}
      });
    }
  }
  return trades.sort((a,b)=>b.exitTime.getTime()-a.exitTime.getTime());
}
