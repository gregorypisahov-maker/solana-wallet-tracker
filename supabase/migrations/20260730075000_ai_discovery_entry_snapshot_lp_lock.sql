create or replace function public.ensure_ai_discovery_entry_snapshot_lp_lock()
returns trigger
language plpgsql
as $$
declare
  nested_lp_lock jsonb;
begin
  new.entry_snapshot := coalesce(new.entry_snapshot, '{}'::jsonb);
  if not (new.entry_snapshot ? 'lp_lock') then
    nested_lp_lock := new.entry_snapshot #> '{opportunity,entry_safety,lp_lock}';
    new.entry_snapshot := new.entry_snapshot || jsonb_build_object(
      'lp_lock',
      coalesce(nested_lp_lock, 'null'::jsonb)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists ai_discovery_positions_entry_snapshot_lp_lock
  on public.ai_discovery_positions;
create trigger ai_discovery_positions_entry_snapshot_lp_lock
before insert or update of entry_snapshot on public.ai_discovery_positions
for each row execute function public.ensure_ai_discovery_entry_snapshot_lp_lock();

drop trigger if exists ai_discovery_trades_entry_snapshot_lp_lock
  on public.ai_discovery_trades;
create trigger ai_discovery_trades_entry_snapshot_lp_lock
before insert or update of entry_snapshot on public.ai_discovery_trades
for each row execute function public.ensure_ai_discovery_entry_snapshot_lp_lock();

update public.ai_discovery_positions
set entry_snapshot = coalesce(entry_snapshot, '{}'::jsonb) || jsonb_build_object(
  'lp_lock',
  coalesce(entry_snapshot #> '{opportunity,entry_safety,lp_lock}', 'null'::jsonb)
)
where not (coalesce(entry_snapshot, '{}'::jsonb) ? 'lp_lock');

update public.ai_discovery_trades
set entry_snapshot = coalesce(entry_snapshot, '{}'::jsonb) || jsonb_build_object(
  'lp_lock',
  coalesce(entry_snapshot #> '{opportunity,entry_safety,lp_lock}', 'null'::jsonb)
)
where not (coalesce(entry_snapshot, '{}'::jsonb) ? 'lp_lock');
