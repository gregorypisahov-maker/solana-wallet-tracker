ALTER TABLE public.shadow_processed_alerts
  ADD COLUMN IF NOT EXISTS entered boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS skip_reasons text[] DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS filter_snapshot jsonb DEFAULT NULL;
