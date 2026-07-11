// paper-trader/dailySummary.ts
// Compatibility wrapper for the daily paper-trading report.
// The worker schedules the report through statsReporter.ts.

import { sendDailyPaperReportIfDue } from "./statsReporter";

export async function runDailySummary(): Promise<void> {
  await sendDailyPaperReportIfDue();
}
