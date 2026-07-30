begin;

-- Repair only the executor state disabled by the parity migration.
-- Other halt reasons remain untouched so genuine risk controls still work.
update public.live_executor_state
set enabled = true,
    halted = false,
    halt_reason = null,
    max_position_sol = 0.1,
    updated_at = now()
where id = 1
  and halt_reason = 'real_readiness_validation_required';

commit;
