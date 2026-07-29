create or replace function public.guard_ai_candidate_outcome_writes()
returns trigger
language plpgsql
as $$
begin
  if new.price_5m_usd is distinct from old.price_5m_usd and new.price_5m_at is null then
    raise exception 'price_5m_usd requires price_5m_at';
  end if;
  if new.price_15m_usd is distinct from old.price_15m_usd and new.price_15m_at is null then
    raise exception 'price_15m_usd requires price_15m_at';
  end if;
  if new.price_30m_usd is distinct from old.price_30m_usd and new.price_30m_at is null then
    raise exception 'price_30m_usd requires price_30m_at';
  end if;
  if new.price_45m_usd is distinct from old.price_45m_usd and new.price_45m_at is null then
    raise exception 'price_45m_usd requires price_45m_at';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_ai_candidate_outcome_writes on public.ai_candidate_observations;
create trigger guard_ai_candidate_outcome_writes
before update on public.ai_candidate_observations
for each row execute function public.guard_ai_candidate_outcome_writes();
