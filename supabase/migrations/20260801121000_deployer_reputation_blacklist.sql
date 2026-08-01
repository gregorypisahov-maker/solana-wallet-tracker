create table if not exists public.deployer_by_mint (
  mint text primary key,
  deployer text,
  method text not null,
  resolved_at timestamptz not null default now()
);

create table if not exists public.deployer_reputation (
  deployer text primary key,
  tokens_seen int not null default 0,
  rugs int not null default 0,
  first_seen_at timestamptz not null default now(),
  last_rug_at timestamptz,
  sample_rug_mints text[] not null default '{}',
  updated_at timestamptz not null default now()
);

alter table public.deployer_by_mint enable row level security;
alter table public.deployer_reputation enable row level security;

create or replace function public.refresh_deployer_reputation_for_mint(p_mint text)
returns void language plpgsql security definer set search_path = public as $$
declare v_deployer text;
begin
  select deployer into v_deployer from public.deployer_by_mint where mint = p_mint;
  if v_deployer is null then return; end if;
  insert into public.deployer_reputation(deployer,tokens_seen,rugs,first_seen_at,last_rug_at,sample_rug_mints,updated_at)
  select v_deployer,
    count(distinct t.mint)::int,
    count(distinct t.mint) filter (where t.exit_reason in ('emergency_liquidity_drop','liquidity_gone','quote_unavailable_forced_exit') or t.net_return_pct <= -80)::int,
    min(t.opened_at),
    max(t.closed_at) filter (where t.exit_reason in ('emergency_liquidity_drop','liquidity_gone','quote_unavailable_forced_exit') or t.net_return_pct <= -80),
    coalesce(array_agg(distinct t.mint) filter (where t.exit_reason in ('emergency_liquidity_drop','liquidity_gone','quote_unavailable_forced_exit') or t.net_return_pct <= -80), '{}'), now()
  from public.ai_discovery_trades t join public.deployer_by_mint d on d.mint=t.mint where d.deployer=v_deployer
  on conflict (deployer) do update set tokens_seen=excluded.tokens_seen,rugs=excluded.rugs,first_seen_at=excluded.first_seen_at,last_rug_at=excluded.last_rug_at,sample_rug_mints=excluded.sample_rug_mints,updated_at=now();
end; $$;

create or replace function public.label_deployer_rug_on_ai_trade()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.closed_at is not null and (new.exit_reason in ('emergency_liquidity_drop','liquidity_gone','quote_unavailable_forced_exit') or new.net_return_pct <= -80) then
    perform public.refresh_deployer_reputation_for_mint(new.mint);
  end if;
  return new;
end; $$;

drop trigger if exists trg_label_deployer_rug_on_ai_trade on public.ai_discovery_trades;
create trigger trg_label_deployer_rug_on_ai_trade after insert or update of exit_reason,net_return_pct,closed_at on public.ai_discovery_trades for each row execute function public.label_deployer_rug_on_ai_trade();
