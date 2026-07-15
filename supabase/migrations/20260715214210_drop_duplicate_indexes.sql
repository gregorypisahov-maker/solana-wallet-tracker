-- These indexes are exact duplicates of the retained *_idx indexes. Removing
-- them lowers write amplification without changing query coverage.
drop index if exists public.idx_alert_participants_wallet;
drop index if exists public.idx_paper_trades_position_id;
drop index if exists public.idx_wallet_performance_trust;
