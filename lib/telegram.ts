export async function sendTelegramAlert(message: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log("Telegram not configured. Alert skipped:");
    console.log(message);
    return;
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Telegram send failed:", res.status, text);
  }
}

export function formatConsensusAlert(data: {
  symbol?: string | null;
  tokenMint: string;
  walletsCount: number;
  totalSol: number;
  marketCap?: number | null;
  liquidityUsd?: number | null;
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
    "🧬 Mint",
    `<code>${data.tokenMint}</code>`,
    "",
    `📈 DexScreener\n${dex}`,
    "",
    `⚡ GMGN\n${gmgn}`,
  ].join("\n");
}
