create or replace function public.set_ai_observation_start_price()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.entry_price_usd is null then
    select mo.price_usd
      into new.entry_price_usd
      from public.market_opportunities mo
     where mo.mint = new.mint
     limit 1;
  end if;
  return new;
end;
$$;

drop trigger if exists set_ai_observation_start_price on public.ai_candidate_observations;
create trigger set_ai_observation_start_price
before insert on public.ai_candidate_observations
for each row execute function public.set_ai_observation_start_price();
