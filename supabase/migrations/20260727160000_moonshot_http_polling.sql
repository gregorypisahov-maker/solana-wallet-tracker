-- Moonshot Phase 1 HTTP polling state. Observation-only; no trading paths.

alter table public.moonshot_scanner_state
  add column if not exists intake_mode text not null default 'websocket',
  add column if not exists active_programs integer not null default 0,
  add column if not exists program_cursors jsonb not null default '{}'::jsonb,
  add column if not exists polls_completed bigint not null default 0,
  add column if not exists signature_fetch_failures bigint not null default 0,
  add column if not exists last_poll_at timestamptz;

comment on column public.moonshot_scanner_state.intake_mode is
  'Moonshot intake transport. v2 uses provider-neutral HTTP polling.';
comment on column public.moonshot_scanner_state.program_cursors is
  'Per-program getSignaturesForAddress cursor; first activation starts at now.';

update public.moonshot_scanner_state
set active_subscriptions = 0
where id = 1;
