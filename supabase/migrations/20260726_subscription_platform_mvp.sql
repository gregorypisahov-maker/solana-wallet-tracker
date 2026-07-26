-- Subscription platform MVP
-- Apply through the Supabase SQL editor before enabling paid access.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  role text not null default 'member' check (role in ('member','admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.subscription_plans (
  id text primary key,
  name text not null,
  description text not null,
  price_usd integer not null check (price_usd >= 0),
  stripe_price_id text unique,
  features jsonb not null default '[]'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.subscription_plans (id, name, description, price_usd, features)
values
  ('signals', 'Signals', 'AI trade alerts and member dashboard access.', 29, '["AI trade alerts","Telegram access","Performance dashboard"]'::jsonb),
  ('pro', 'Pro', 'Live signals with advanced statistics and faster delivery.', 79, '["Everything in Signals","Advanced analytics","Priority alerts"]'::jsonb),
  ('premium', 'Premium', 'Full platform access and future automation tools.', 149, '["Everything in Pro","Full strategy dashboard","Priority support"]'::jsonb)
on conflict (id) do update set
  name = excluded.name,
  description = excluded.description,
  price_usd = excluded.price_usd,
  features = excluded.features;

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan_id text not null references public.subscription_plans(id),
  stripe_customer_id text,
  stripe_subscription_id text unique,
  status text not null default 'inactive' check (status in ('inactive','trialing','active','past_due','canceled','unpaid')),
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id)
);

create table if not exists public.telegram_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  telegram_user_id bigint unique,
  telegram_username text,
  connection_code text unique not null default upper(substr(encode(gen_random_bytes(8), 'hex'), 1, 8)),
  connected_at timestamptz,
  created_at timestamptz not null default now(),
  unique(user_id)
);

create table if not exists public.notification_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  telegram_enabled boolean not null default true,
  email_enabled boolean not null default false,
  trade_opened boolean not null default true,
  trade_closed boolean not null default true,
  daily_summary boolean not null default true,
  updated_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;

  insert into public.notification_preferences (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  insert into public.telegram_connections (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.subscriptions enable row level security;
alter table public.telegram_connections enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.subscription_plans enable row level security;

create policy "plans are publicly readable" on public.subscription_plans
for select using (is_active = true);

create policy "users read own profile" on public.profiles
for select using (auth.uid() = id);
create policy "users update own profile" on public.profiles
for update using (auth.uid() = id);

create policy "users read own subscription" on public.subscriptions
for select using (auth.uid() = user_id);

create policy "users read own telegram connection" on public.telegram_connections
for select using (auth.uid() = user_id);

create policy "users read own notification preferences" on public.notification_preferences
for select using (auth.uid() = user_id);
create policy "users update own notification preferences" on public.notification_preferences
for update using (auth.uid() = user_id);
