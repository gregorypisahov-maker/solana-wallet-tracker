begin;

create table if not exists public.wallet_copier_history as
select * from public.tiered_trades
with data;

comment on table public.wallet_copier_history is
  'Read-only historical outcomes retained for wallet-quality analysis after removal of the Tiered bot.';

alter table public.wallet_copier_history enable row level security;

revoke insert, update, delete, truncate, references, trigger
on table public.wallet_copier_history
from anon, authenticated;

do $$
declare
  routine record;
begin
  for routine in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname like 'tiered_%'
  loop
    execute format('drop function if exists %s cascade', routine.signature);
  end loop;
end
$$;

drop table if exists public.tiered_positions cascade;
drop table if exists public.tiered_processed_signals cascade;
drop table if exists public.tiered_state cascade;
drop table if exists public.tiered_trades cascade;

create view public.tiered_trades as
select * from public.wallet_copier_history
union all
select * from public.wallet_copier_history where false;

comment on view public.tiered_trades is
  'Non-updatable compatibility view over archived wallet-quality history. The Tiered bot runtime is removed.';

revoke all on table public.tiered_trades from anon, authenticated;
grant select on table public.tiered_trades to anon, authenticated;

commit;
