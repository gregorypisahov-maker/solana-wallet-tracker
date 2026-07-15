create table if not exists public.monitor_usage_samples (
  id bigint generated always as identity primary key,
  instance_id uuid not null,
  period_started_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  signature_requests integer not null default 0 check (signature_requests >= 0),
  transaction_requests integer not null default 0 check (transaction_requests >= 0),
  websocket_notifications integer not null default 0 check (websocket_notifications >= 0),
  websocket_bytes bigint not null default 0 check (websocket_bytes >= 0),
  rate_limit_errors integer not null default 0 check (rate_limit_errors >= 0),
  rpc_failures integer not null default 0 check (rpc_failures >= 0),
  stored_trades integer not null default 0 check (stored_trades >= 0),
  duplicate_events integer not null default 0 check (duplicate_events >= 0),
  max_queue_depth integer not null default 0 check (max_queue_depth >= 0),
  unique (instance_id, period_started_at)
);

create index if not exists monitor_usage_samples_recorded_at_idx
  on public.monitor_usage_samples (recorded_at desc);

alter table public.monitor_usage_samples enable row level security;

-- Only trusted server processes use this operational table. The service-role
-- client bypasses RLS; browser roles should not see its schema or rows.
revoke all on table public.monitor_usage_samples from anon, authenticated;
revoke all on sequence public.monitor_usage_samples_id_seq from anon, authenticated;

comment on table public.monitor_usage_samples is
  'Server-only Helius usage telemetry emitted by the wallet monitor.';
