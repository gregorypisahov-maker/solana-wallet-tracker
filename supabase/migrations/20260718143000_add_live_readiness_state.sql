CREATE TABLE IF NOT EXISTS public.live_readiness_state (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  strategy_version text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ready boolean NOT NULL DEFAULT false,
  completed_trades integer NOT NULL DEFAULT 0,
  active_days numeric NOT NULL DEFAULT 0,
  wins integer NOT NULL DEFAULT 0,
  losses integer NOT NULL DEFAULT 0,
  win_rate numeric NOT NULL DEFAULT 0,
  realized_pnl_sol numeric NOT NULL DEFAULT 0,
  profit_factor numeric,
  max_drawdown_pct numeric NOT NULL DEFAULT 0,
  largest_winner_share numeric NOT NULL DEFAULT 1,
  blockers text[] NOT NULL DEFAULT '{}',
  last_evaluated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.live_readiness_state ENABLE ROW LEVEL SECURITY;

INSERT INTO public.live_readiness_state (
  id,
  strategy_version,
  blockers
)
VALUES (
  1,
  'regular_hybrid_v1_2026_07_18',
  ARRAY[
    'minimum_100_forward_trades_not_reached',
    'minimum_45_forward_days_not_reached'
  ]
)
ON CONFLICT (id) DO NOTHING;
