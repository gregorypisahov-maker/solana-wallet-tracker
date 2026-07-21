create or replace function public.preserve_wallet_lab_terminal_status()
returns trigger
language plpgsql
as $$
begin
  if old.status in ('qualified','rejected','trial','disabled')
     and new.status = 'observing' then
    new.status := old.status;
  end if;
  return new;
end;
$$;

drop trigger if exists preserve_wallet_lab_terminal_status_trigger
  on public.wallet_lab_candidates;

create trigger preserve_wallet_lab_terminal_status_trigger
before update on public.wallet_lab_candidates
for each row execute function public.preserve_wallet_lab_terminal_status();
