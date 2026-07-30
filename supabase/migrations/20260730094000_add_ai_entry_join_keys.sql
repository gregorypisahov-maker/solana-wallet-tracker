alter table public.ai_candidate_observations
  add column if not exists entry_id text,
  add column if not exists entry_ts timestamp with time zone;

create unique index if not exists ai_candidate_observations_entry_id_uidx
  on public.ai_candidate_observations (entry_id)
  where entry_id is not null;

create index if not exists ai_candidate_observations_mint_entry_ts_idx
  on public.ai_candidate_observations (mint, entry_ts desc)
  where entry_ts is not null;

comment on column public.ai_candidate_observations.entry_id is
  'Stable ai_discovery position/entry identifier used to join entry-time features to forward outcomes.';

comment on column public.ai_candidate_observations.entry_ts is
  'UTC paper-entry decision timestamp; outcome horizons remain anchored to observed_at for backward compatibility.';
