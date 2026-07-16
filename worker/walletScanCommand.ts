import { discoverTrialWallets } from './walletDiscovery';
import { runWalletIntelligence } from './walletIntelligence';

let scanRunning = false;

function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export async function handleWalletScan(): Promise<string> {
  if (scanRunning) {
    return [
      '⏳ <b>WALLET SCAN ALREADY RUNNING</b>',
      '',
      'The current scan must finish before another one can start.',
    ].join('\n');
  }

  scanRunning = true;

  try {
    const intelligence = await runWalletIntelligence();

    let discovery: Awaited<ReturnType<typeof discoverTrialWallets>> | null = null;
    let discoveryError: string | null = null;

    try {
      discovery = await discoverTrialWallets();
    } catch (error) {
      discoveryError = error instanceof Error ? error.message : String(error);
      console.error('[wallet-scan] discovery failed safely:', error);
    }

    const lines = [
      discoveryError ? '⚠️ <b>WALLET SCAN PARTIALLY COMPLETE</b>' : '🔎 <b>WALLET SCAN COMPLETE</b>',
      '',
      `<b>Existing wallets scored:</b> ${intelligence.walletsScored}`,
      `<b>Promoted to proven:</b> ${intelligence.promoted.length}`,
      `<b>Bad wallets deactivated:</b> ${intelligence.disabled.length}`,
      `<b>Eligible new candidates:</b> ${discovery?.eligible ?? 0}`,
      `<b>New trial wallets added:</b> ${discovery?.added.length ?? 0}`,
    ];

    if (intelligence.promoted.length > 0) {
      lines.push('', '<b>Promoted</b>', ...intelligence.promoted.map((address) => `✅ <code>${shortAddress(address)}</code>`));
    }

    if (intelligence.disabled.length > 0) {
      lines.push('', '<b>Deactivated</b>', ...intelligence.disabled.map((address) => `🛑 <code>${shortAddress(address)}</code>`));
    }

    if (discovery?.added.length) {
      lines.push('', '<b>Added for trial</b>', ...discovery.added.map((address) => `➕ <code>${shortAddress(address)}</code>`));
    }

    if (discoveryError) {
      lines.push(
        '',
        '⚠️ <b>New-wallet discovery unavailable</b>',
        `The existing-wallet cleanup completed, but the external candidate source rejected the request: ${discoveryError}`,
        'No unverified wallet was added.'
      );
    }

    lines.push('', 'Bad wallets are deactivated rather than permanently deleted, preserving their trade history.');

    return lines.join('\n');
  } finally {
    scanRunning = false;
  }
}
