export async function sendTelegramAlert(message: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log("Telegram not configured. Alert skipped:");
    console.log(message);
    return;
  }

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
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
  return [
    `🚨 Wallet consensus alert`,
    ``,
    `Token: ${data.symbol ?? "Unknown"}`,
    `Mint: ${data.tokenMint}`,
    `Wallets buying: ${data.walletsCount}`,
    `Total SOL bought: ${data.totalSol.toFixed(2)}`,
    `Market cap: ${data.marketCap ?? "N/A"}`,
    `Liquidity: ${data.liquidityUsd ?? "N/A"}`,
    `Score: ${data.score}`,
  ].join("\n");
}
