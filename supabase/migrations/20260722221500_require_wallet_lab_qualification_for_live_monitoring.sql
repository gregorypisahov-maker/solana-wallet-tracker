create or replace function public.auto_disable_bad_wallet_lab_candidate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile jsonb;
  v_matched_exits integer;
  v_qualifies boolean;
  v_quality numeric;
  v_reason text;
begin
  if new.scan_status <> 'complete' or new.final_profile is null then
    return new;
  end if;

  v_profile := new.final_profile;
  v_matched_exits := coalesce((v_profile->>'matched_exits')::integer, 0);
  v_qualifies := coalesce((v_profile->>'qualifies_for_trial')::boolean, false);
  v_quality := coalesce((v_profile->>'lab_quality_percent')::numeric, new.lab_trust_score, 0);

  if v_qualifies then
    return new;
  end if;

  v_reason := case
    when v_matched_exits < 10 then 'wallet_lab_unproven_' || v_matched_exits::text || '_matched_exits'
    else 'wallet_lab_rejected_quality_' || round(v_quality)::text || 'pct'
  end;

  update public.wallets
  set active = false,
      management_status = 'disabled',
      auto_disabled_at = now(),
      auto_disable_reason = v_reason,
      management_updated_at = now(),
      discovery_metrics = coalesce(discovery_metrics, '{}'::jsonb) || jsonb_build_object(
        'wallet_lab_auto_disabled', true,
        'wallet_lab_auto_disabled_at', now(),
        'wallet_lab_auto_disable_reason', v_reason,
        'wallet_lab_profile', v_profile
      )
  where address = new.wallet_address
    and active = true;

  return new;
end;
$$;

update public.wallets w
set active = false,
    management_status = 'disabled',
    auto_disabled_at = now(),
    auto_disable_reason = case
      when coalesce((c.final_profile->>'matched_exits')::integer, 0) < 10
        then 'wallet_lab_unproven_' || coalesce((c.final_profile->>'matched_exits')::integer, 0)::text || '_matched_exits'
      else 'wallet_lab_rejected_quality_' || round(coalesce((c.final_profile->>'lab_quality_percent')::numeric, c.lab_trust_score, 0))::text || 'pct'
    end,
    management_updated_at = now(),
    discovery_metrics = coalesce(w.discovery_metrics, '{}'::jsonb) || jsonb_build_object(
      'wallet_lab_auto_disabled', true,
      'wallet_lab_auto_disabled_at', now(),
      'wallet_lab_profile', c.final_profile
    )
from public.wallet_lab_candidates c
where c.wallet_address = w.address
  and c.scan_status = 'complete'
  and c.final_profile is not null
  and not coalesce((c.final_profile->>'qualifies_for_trial')::boolean, false)
  and w.active = true;
