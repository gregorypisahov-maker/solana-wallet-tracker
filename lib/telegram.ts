// lib/telegram.ts
//
// Telegram delivery is bounded so a network problem cannot freeze the worker.

const configuredTelegramTimeoutMs = Number(process.env.TELEGRAM_TIMEOUT_MS ?? 10_000);
const TELEGRAM_TIMEOUT_MS = Number.isFinite(configuredTelegramTimeoutMs)
  ? Math.max(3_000, configuredTelegramTimeoutMs)
  : 10_000;

function cleanEnv(value: string | undefined): string {
  return (value ?? '').trim().replace(/^[\'\"]|[\'\"]$/g, '').trim();
}

export async function sendTelegramAlert(message: string): Promise<void> {
  // One shared token for alerts and inbound commands.
  const token = cleanEnv(process.env.TELEGRAM_BOT_TOKEN);
  const chatId = cleanEnv(process.env.TELEGRAM_CHAT_ID);
  if (!token || !chatId) {
    console.log('Telegram not configured. Alert skipped:');
    console.log(message);
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('Telegram send failed:', res.status, text);
    }
  } catch (error) {
    const reason =
      error instanceof Error && error.name === 'AbortError'
        ? `timed out after ${TELEGRAM_TIMEOUT_MS}ms`
        : error instanceof Error
          ? error.message
          : String(error);
    console.error('Telegram send failed:', reason);
  } finally {
    clearTimeout(timeout);
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
  weightedWalletScore?: number;
  averageTrustScore?: number;
  confidenceGrade?: 'A' | 'B' | 'C' | 'D';
  signalSource?: 'wallet_consensus' | 'proven_trader_copy';
  leaderWallet?: string;
  leaderProfile?: {
    closedTrades: number;
    winRate: number;
    realizedPnlSol: number;
    profitFactor: number | null;
  };
}) {
  const dex = `https://dexscreener.com/solana/${data.tokenMint}`;
  const gmgn = `https://gmgn.ai/sol/token/${data.tokenMint}`;

  const lines = [
    data.signalSource === 'proven_trader_copy'
      ? '🎯 <b>Verified Profitable Trader Copy</b>'
      : '🚨 <b>Smart Wallet Consensus</b>',
    '',
    `🪙 <b>${data.symbol ?? 'Unknown'}</b>`,
    '',
    `⭐ Score: <b>${data.score}/100</b>`,
    `👥 Wallets: <b>${data.walletsCount}</b>`,
    `◎ Total Bought: <b>${data.totalSol.toFixed(2)} SOL</b>`,
    `💰 Market Cap: <b>$${Math.round(data.marketCap ?? 0).toLocaleString()}</b>`,
    `💧 Liquidity: <b>$${Math.round(data.liquidityUsd ?? 0).toLocaleString()}</b>`,
  ];

  if (data.signalSource === 'proven_trader_copy' && data.leaderProfile) {
    lines.push(
      '',
      `🧠 Leader: <code>${data.leaderWallet ?? 'verified'}</code>`,
      `Closed swaps: <b>${data.leaderProfile.closedTrades}</b>`,
      `Win rate: <b>${(data.leaderProfile.winRate * 100).toFixed(1)}%</b>`,
      `Profit factor: <b>${data.leaderProfile.profitFactor?.toFixed(2) ?? 'n/a'}</b>`,
      `Realized PnL: <b>${data.leaderProfile.realizedPnlSol.toFixed(2)} SOL</b>`,
      'Paper size: <b>50% of normal</b>',
    );
  }

  const hasTrustData =
    data.weightedWalletScore !== undefined ||
    data.averageTrustScore !== undefined ||
    data.confidenceGrade !== undefined;

  if (hasTrustData) {
    lines.push('');
    if (data.weightedWalletScore !== undefined) {
      lines.push(`⚖️ Weighted Score: <b>${data.weightedWalletScore.toFixed(2)}</b> (raw ${data.walletsCount})`);
    }
    if (data.averageTrustScore !== undefined) {
      lines.push(`🛡️ Avg Wallet Trust: <b>${data.averageTrustScore.toFixed(1)}/100</b>`);
    }
    if (data.confidenceGrade !== undefined) {
      const gradeEmoji = { A: '🟢', B: '🟡', C: '🟠', D: '🔴' }[data.confidenceGrade];
      lines.push(`${gradeEmoji} Confidence Grade: <b>${data.confidenceGrade}</b>`);
    }
  }

  lines.push(
    '',
    '🧬 Mint',
    `<code>${data.tokenMint}</code>`,
    '',
    `📈 DexScreener\n${dex}`,
    '',
    `⚡ GMGN\n${gmgn}`,
  );

  return lines.join('\n');
}
