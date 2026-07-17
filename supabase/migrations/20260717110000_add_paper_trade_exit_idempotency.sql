-- Prevent duplicate paper-trade exit rows for the same logical exit event.
-- Historical duplicates through id 193 are intentionally preserved for audit/reporting.
-- New exit rows are idempotent across overlapping worker processes.
CREATE UNIQUE INDEX IF NOT EXISTS paper_trades_exit_event_idempotency_idx
ON public.paper_trades (position_id, reason, sold_pct)
WHERE position_id IS NOT NULL
  AND type IN ('sell', 'partial_sell')
  AND id > 193;
