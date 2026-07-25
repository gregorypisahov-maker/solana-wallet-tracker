-- Prevent duplicate AI discovery positions and duplicate close credits when
-- more than one worker process is running against the same Supabase project.
-- The strategy intentionally allows only one open AI discovery position.

create unique index if not exists ai_discovery_single_open_position_idx
on public.ai_discovery_positions ((1));

-- A position may be closed and credited only once.
create unique index if not exists ai_discovery_trade_position_unique_idx
on public.ai_discovery_trades (position_id);
