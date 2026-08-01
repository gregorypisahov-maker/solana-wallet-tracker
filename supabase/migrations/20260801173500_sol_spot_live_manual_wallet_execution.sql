create table if not exists public.sol_spot_live_settings (
  id smallint primary key default 1 check (id = 1),
  wallet_public_key text,
  execution_mode text not null default 'manual_approval' check (execution_mode = 'manual_approval'),
  armed boolean not null default false,
  armed_until timestamptz,
  max_position_usdt numeric(18,6) not null default 25 check (max_position_usdt between 10 and 200),
  max_price_impact_pct numeric(8,4) not null default 0.30 check (max_price_impact_pct between 0.01 and 2),
  last_action_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into public.sol_spot_live_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.sol_spot_live_orders (
  order_id uuid primary key default gen_random_uuid(),
  request_id text not null unique,
  wallet_public_key text not null,
  side text not null check (side in ('buy','sell')),
  status text not null default 'pending_signature' check (status in ('pending_signature','success','failed','expired')),
  input_mint text not null,
  output_mint text not null,
  input_amount_atomic numeric(40,0) not null,
  quoted_output_amount_atomic numeric(40,0),
  actual_input_amount_atomic numeric(40,0),
  actual_output_amount_atomic numeric(40,0),
  price_impact_pct numeric(12,8),
  paper_position_id uuid,
  signature text,
  error text,
  result jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  executed_at timestamptz
);
create index if not exists sol_spot_live_orders_created_idx on public.sol_spot_live_orders (created_at desc);

create table if not exists public.sol_spot_live_positions (
  id smallint primary key default 1 check (id = 1),
  position_id uuid not null default gen_random_uuid() unique,
  wallet_public_key text not null,
  quantity_sol numeric(24,9) not null check (quantity_sol > 0),
  cost_usdt numeric(24,6) not null check (cost_usdt > 0),
  entry_signature text not null,
  entry_order_id uuid not null references public.sol_spot_live_orders(order_id),
  paper_position_id uuid,
  opened_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sol_spot_live_trades (
  trade_id uuid primary key default gen_random_uuid(),
  position_id uuid not null,
  wallet_public_key text not null,
  quantity_sol numeric(24,9) not null,
  cost_usdt numeric(24,6) not null,
  proceeds_usdt numeric(24,6) not null,
  pnl_usdt numeric(24,6) not null,
  return_pct numeric(18,8) not null,
  entry_signature text not null,
  exit_signature text not null,
  entry_order_id uuid not null references public.sol_spot_live_orders(order_id),
  exit_order_id uuid not null references public.sol_spot_live_orders(order_id),
  opened_at timestamptz not null,
  closed_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists sol_spot_live_trades_closed_idx on public.sol_spot_live_trades (closed_at desc);

alter table public.sol_spot_live_settings enable row level security;
alter table public.sol_spot_live_orders enable row level security;
alter table public.sol_spot_live_positions enable row level security;
alter table public.sol_spot_live_trades enable row level security;

create or replace function public.sol_spot_apply_live_execution(
  p_order_id uuid,
  p_signature text,
  p_actual_input_amount_atomic numeric,
  p_actual_output_amount_atomic numeric,
  p_result jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_order public.sol_spot_live_orders%rowtype;
  v_position public.sol_spot_live_positions%rowtype;
  v_quantity_sol numeric;
  v_cost_usdt numeric;
  v_proceeds_usdt numeric;
  v_pnl_usdt numeric;
  v_return_pct numeric;
begin
  select * into v_order from public.sol_spot_live_orders where order_id = p_order_id for update;
  if not found then raise exception 'live_order_not_found'; end if;
  if v_order.status = 'success' then
    return jsonb_build_object('ok', true, 'idempotent', true, 'side', v_order.side);
  end if;
  if v_order.status <> 'pending_signature' then raise exception 'live_order_not_pending'; end if;
  if v_order.expires_at <= now() then
    update public.sol_spot_live_orders set status='expired', error='order_expired', executed_at=now() where order_id=p_order_id;
    raise exception 'live_order_expired';
  end if;

  if v_order.side = 'buy' then
    if exists (select 1 from public.sol_spot_live_positions where id=1) then raise exception 'live_position_already_open'; end if;
    v_cost_usdt := p_actual_input_amount_atomic / 1000000.0;
    v_quantity_sol := p_actual_output_amount_atomic / 1000000000.0;
    if v_cost_usdt <= 0 or v_quantity_sol <= 0 then raise exception 'invalid_buy_execution_amounts'; end if;
    insert into public.sol_spot_live_positions (
      id, wallet_public_key, quantity_sol, cost_usdt, entry_signature, entry_order_id, paper_position_id, opened_at, updated_at
    ) values (
      1, v_order.wallet_public_key, v_quantity_sol, v_cost_usdt, p_signature, v_order.order_id, v_order.paper_position_id, now(), now()
    );
  else
    select * into v_position from public.sol_spot_live_positions where id=1 for update;
    if not found then raise exception 'live_position_not_found'; end if;
    if v_position.wallet_public_key <> v_order.wallet_public_key then raise exception 'live_position_wallet_mismatch'; end if;
    v_quantity_sol := p_actual_input_amount_atomic / 1000000000.0;
    v_proceeds_usdt := p_actual_output_amount_atomic / 1000000.0;
    if v_quantity_sol <= 0 or v_proceeds_usdt <= 0 then raise exception 'invalid_sell_execution_amounts'; end if;
    v_cost_usdt := v_position.cost_usdt;
    v_pnl_usdt := v_proceeds_usdt - v_cost_usdt;
    v_return_pct := case when v_cost_usdt > 0 then (v_pnl_usdt/v_cost_usdt)*100 else 0 end;
    insert into public.sol_spot_live_trades (
      position_id,wallet_public_key,quantity_sol,cost_usdt,proceeds_usdt,pnl_usdt,return_pct,
      entry_signature,exit_signature,entry_order_id,exit_order_id,opened_at,closed_at,metadata
    ) values (
      v_position.position_id,v_position.wallet_public_key,v_quantity_sol,v_cost_usdt,v_proceeds_usdt,v_pnl_usdt,v_return_pct,
      v_position.entry_signature,p_signature,v_position.entry_order_id,v_order.order_id,v_position.opened_at,now(),p_result
    );
    delete from public.sol_spot_live_positions where id=1;
    update public.sol_spot_live_settings set armed=false, armed_until=null, last_action_at=now(), updated_at=now() where id=1;
  end if;

  update public.sol_spot_live_orders set
    status='success', signature=p_signature,
    actual_input_amount_atomic=p_actual_input_amount_atomic,
    actual_output_amount_atomic=p_actual_output_amount_atomic,
    result=coalesce(p_result,'{}'::jsonb), executed_at=now()
  where order_id=p_order_id;
  update public.sol_spot_live_settings set last_action_at=now(), updated_at=now() where id=1;
  return jsonb_build_object('ok',true,'side',v_order.side,'inputAmountAtomic',p_actual_input_amount_atomic,'outputAmountAtomic',p_actual_output_amount_atomic);
end;
$$;
revoke all on function public.sol_spot_apply_live_execution(uuid,text,numeric,numeric,jsonb) from public;
revoke all on function public.sol_spot_apply_live_execution(uuid,text,numeric,numeric,jsonb) from anon;
revoke all on function public.sol_spot_apply_live_execution(uuid,text,numeric,numeric,jsonb) from authenticated;
grant execute on function public.sol_spot_apply_live_execution(uuid,text,numeric,numeric,jsonb) to service_role;
