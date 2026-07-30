create or replace function public.guard_ai_candidate_outcome_horizons()
returns trigger
language plpgsql
as $$
declare
  misses text[] := coalesce(new.horizon_misses, '{}'::text[]);
begin
  if new.price_5m_usd is distinct from old.price_5m_usd then
    if new.price_5m_at is null
       or abs(extract(epoch from (new.price_5m_at - (new.observed_at + interval '5 minutes')))) > 90 then
      new.price_5m_usd := old.price_5m_usd;
      new.return_5m_pct := old.return_5m_pct;
      new.price_5m_at := old.price_5m_at;
      if not ('5m' = any(misses)) then misses := array_append(misses, '5m'); end if;
    end if;
  end if;

  if new.price_15m_usd is distinct from old.price_15m_usd then
    if new.price_15m_at is null
       or abs(extract(epoch from (new.price_15m_at - (new.observed_at + interval '15 minutes')))) > 120 then
      new.price_15m_usd := old.price_15m_usd;
      new.return_15m_pct := old.return_15m_pct;
      new.price_15m_at := old.price_15m_at;
      if not ('15m' = any(misses)) then misses := array_append(misses, '15m'); end if;
    end if;
  end if;

  if new.price_30m_usd is distinct from old.price_30m_usd then
    if new.price_30m_at is null
       or abs(extract(epoch from (new.price_30m_at - (new.observed_at + interval '30 minutes')))) > 180 then
      new.price_30m_usd := old.price_30m_usd;
      new.return_30m_pct := old.return_30m_pct;
      new.price_30m_at := old.price_30m_at;
      if not ('30m' = any(misses)) then misses := array_append(misses, '30m'); end if;
    end if;
  end if;

  if new.price_45m_usd is distinct from old.price_45m_usd then
    if new.price_45m_at is null
       or abs(extract(epoch from (new.price_45m_at - (new.observed_at + interval '45 minutes')))) > 180 then
      new.price_45m_usd := old.price_45m_usd;
      new.return_45m_pct := old.return_45m_pct;
      new.price_45m_at := old.price_45m_at;
      if not ('45m' = any(misses)) then misses := array_append(misses, '45m'); end if;
    end if;
  end if;

  new.horizon_misses := misses;

  if new.outcome_complete = true and not (
    (new.price_5m_usd is not null or '5m' = any(misses)) and
    (new.price_15m_usd is not null or '15m' = any(misses)) and
    (new.price_30m_usd is not null or '30m' = any(misses)) and
    (new.price_45m_usd is not null or '45m' = any(misses))
  ) then
    new.outcome_complete := false;
    new.outcome_quality := null;
  end if;

  return new;
end;
$$;

drop trigger if exists guard_ai_candidate_outcome_horizons_trg
  on public.ai_candidate_observations;

create trigger guard_ai_candidate_outcome_horizons_trg
before update on public.ai_candidate_observations
for each row
execute function public.guard_ai_candidate_outcome_horizons();

comment on function public.guard_ai_candidate_outcome_horizons() is
  'Rejects timestamp-free or late AI outcome backfills and prevents premature outcome completion.';
