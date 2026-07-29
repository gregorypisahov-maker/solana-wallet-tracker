alter table public.ai_candidate_observations
  add column if not exists observed_price_usd numeric,
  add column if not exists observed_price_at timestamptz,
  add column if not exists price_5m_at timestamptz,
  add column if not exists price_15m_at timestamptz,
  add column if not exists price_30m_at timestamptz,
  add column if not exists price_45m_at timestamptz,
  add column if not exists outcome_tracked boolean not null default false,
  add column if not exists outcome_sample_source text,
  add column if not exists outcome_quality text,
  add column if not exists horizon_misses text[] not null default '{}',
  add column if not exists outcome_fetch_attempts integer not null default 0,
  add column if not exists last_outcome_attempt_at timestamptz,
  add column if not exists last_outcome_error text;

update public.ai_candidate_observations
set outcome_quality = 'unusable_legacy',
    outcome_tracked = false
where outcome_complete = true
  and outcome_quality is null;

create index if not exists ai_candidate_obs_tracking_idx
  on public.ai_candidate_observations (outcome_tracked, outcome_complete, observed_at)
  where outcome_tracked = true and outcome_complete = false;
