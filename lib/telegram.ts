export function formatConsensusAlert(data: {
  symbol?: string |null;
  tokenMint: string;
  walletsCount: number;
  totalSol: number;
  marketCap?: number |null;
  liquidityUsd?: number |null;
  score: number;
}) {
  const dex = `https://dexscreener.com/solana/${data.tokenMint}`;
  const gmgn = `https://gmgn.ai/sol/token/${data.tokenMint}`;

  return [
    "🚨 <b>Smart Wallet Consensus</b>",
    "",
    `🪙 <b>${data.symbol ?? "Unknown"}</b>`,
    "",
    `⭐ Score: <b>${data.score}/100</b>`,
    `👥 Wallets: <b>${data.walletsCount}</b>`,
    `◎ Total Bought: <b>${data.totalSol.toFixed(2)} SOL</b>`,
    `💰 Market Cap: <b>$${Math.round(data.marketCap ?? 0).toLocaleString()}</b>`,
    `💧 Liquidity: <b>$${Math.round(data.liquidityUsd ?? 0).toLocaleString()}</b>`,
    "",
    `🧬 Mint`,
    `<code>${data.tokenMint}</code>`,
    "",
    `📈 DexScreener`,
    dex,
    "",
    `⚡ GMGN`,
    gmgn,
  ].join("\n");
}
