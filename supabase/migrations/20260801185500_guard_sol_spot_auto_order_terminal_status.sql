create or replace function public.guard_sol_spot_auto_order_terminal_status()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status in ('confirmed', 'reconciliation_required')
     and new.status is distinct from old.status then
    new.status := old.status;
    new.signature := coalesce(old.signature, new.signature);
    new.output_amount_atomic := coalesce(old.output_amount_atomic, new.output_amount_atomic);
    new.completed_at := coalesce(old.completed_at, new.completed_at);
    if old.status = 'reconciliation_required' then
      new.error := coalesce(old.error, new.error);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists sol_spot_auto_order_terminal_status_guard
  on public.sol_spot_auto_orders;

create trigger sol_spot_auto_order_terminal_status_guard
before update on public.sol_spot_auto_orders
for each row
execute function public.guard_sol_spot_auto_order_terminal_status();

revoke all on function public.guard_sol_spot_auto_order_terminal_status() from public, anon, authenticated;
