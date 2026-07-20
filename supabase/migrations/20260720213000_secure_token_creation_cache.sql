-- The token creation cache is written and read only by server-side wallet
-- discovery through the Supabase service-role client. Keep it inaccessible to
-- browser clients even when the public anon key is known.
alter table public.token_creation_cache enable row level security;

revoke all on table public.token_creation_cache from anon, authenticated;

grant all on table public.token_creation_cache to service_role;
