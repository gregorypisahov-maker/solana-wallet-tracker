alter table public.wallet_lab_candidates
  add column if not exists scan_status text not null default 'idle',
  add column if not exists scan_requested_at timestamptz,
  add column if not exists scan_started_at timestamptz,
  add column if not exists scan_completed_at timestamptz,
  add column if not exists scan_error text,
  add column if not exists scan_limit integer not null default 80;

alter table public.wallet_lab_candidates
  drop constraint if exists wallet_lab_candidates_scan_status_check;

alter table public.wallet_lab_candidates
  add constraint wallet_lab_candidates_scan_status_check
  check (scan_status in ('idle','queued','running','complete','error'));

alter table public.wallet_lab_candidates
  drop constraint if exists wallet_lab_candidates_scan_limit_check;

alter table public.wallet_lab_candidates
  add constraint wallet_lab_candidates_scan_limit_check
  check (scan_limit between 20 and 200);

create index if not exists wallet_lab_candidates_scan_queue_idx
  on public.wallet_lab_candidates(scan_status, leaderboard_score desc, scan_requested_at asc);

update public.wallet_lab_candidates
set scan_status = 'queued',
    scan_requested_at = coalesce(scan_requested_at, now()),
    scan_error = null,
    updated_at = now()
where source = 'gmgn_manual_top_wallet'
  and profiled_at is null
  and scan_status in ('idle','error');
