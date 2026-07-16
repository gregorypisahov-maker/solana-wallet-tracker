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
    // Score existing wallets first so weak wallets are deactivated and trial
    // capacity is freed before discovery looks for replacements.
    const intelligence = await runWalletIntelligence();
    const discovery = await discoverTrialWallets();

    const lines = [
      '🔎 <b>WALLET SCAN COMPLETE</b>',
      '',
      `<b>Existing wallets scored:</b> ${intelligence.walletsScored}`,
      `<b>Promoted to proven:</b> ${intelligence.promoted.length}`,
      `<b>Bad wallets deactivated:</b> ${intelligence.disabled.length}`,
      `<b>Eligible GMGN candidates:</b> ${discovery.eligible}`,
      `<b>New trial wallets added:</b> ${discovery.added.length}`,
    ];

    if (intelligence.promoted.length > 0) {
      lines.push(
        '',
        '<b>Promoted</b>',
        ...intelligence.promoted.map((address) => `✅ <code>${shortAddress(address)}</code>`)
      );
    }

    if (intelligence.disabled.length > 0) {
      lines.push(
        '',
        '<b>Deactivated</b>',
        ...intelligence.disabled.map((address) => `🛑 <code>${shortAddress(address)}</code>`)
      );
    }

    if (discovery.added.length > 0) {
      lines.push(
        '',
        '<b>Added for trial</b>',
        ...discovery.added.map((address) => `➕ <code>${shortAddress(address)}</code>`)
      );
    }

    lines.push(
      '',
      'Bad wallets are deactivated rather than permanently deleted, preserving their trade history and preventing accidental re-adding.'
    );

    return lines.join('\n');
  } finally {
    scanRunning = false;
  }
}
