// Added resume scalper command to telegramCommands.ts - insert this handler into the COMMAND_HANDLERS

export async function handleScalpResume(): Promise<string> {
  const { resumeScalper } = await import('./scalpResume'); // Import from new file
  const result = await resumeScalper();
  
  if (!result.success) {
    return `❌ Resume failed: ${result.message}`;
  }

  const state = result.state as any;
  return [
    '✅ <b>SCALPER RESUMED</b>',
    '',
    `Status: ${state?.enabled && !state?.halted ? '🟢 ACTIVE' : '🔴 PAUSED'}`,
    `Bankroll: ${(state?.bankroll_sol ?? 0).toFixed(4)} SOL`,
    `Entries today: ${state?.entries_today ?? 0}/12`,
    `Consecutive losses: ${state?.consecutive_losses ?? 0}/3`,
    '',
    'Ready to scan for the next entry opportunity.',
  ].join('\n');
}
