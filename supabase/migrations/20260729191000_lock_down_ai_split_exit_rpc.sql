revoke all on function public.apply_ai_discovery_partial_tp(text, text, numeric, numeric, numeric, numeric, numeric, numeric) from public;
revoke all on function public.apply_ai_discovery_partial_tp(text, text, numeric, numeric, numeric, numeric, numeric, numeric) from anon;
revoke all on function public.apply_ai_discovery_partial_tp(text, text, numeric, numeric, numeric, numeric, numeric, numeric) from authenticated;
grant execute on function public.apply_ai_discovery_partial_tp(text, text, numeric, numeric, numeric, numeric, numeric, numeric) to service_role;
