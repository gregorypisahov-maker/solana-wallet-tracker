-- This table is written by the server-side discovery worker. No browser or
-- authenticated-user client is allowed to read or mutate rejection records.
ALTER TABLE public.wallet_discovery_rejections ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.wallet_discovery_rejections
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON SEQUENCE public.wallet_discovery_rejections_id_seq
  FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.wallet_discovery_rejections TO service_role;
GRANT USAGE, SELECT
  ON SEQUENCE public.wallet_discovery_rejections_id_seq TO service_role;

DROP POLICY IF EXISTS wallet_discovery_rejections_service_role_only
  ON public.wallet_discovery_rejections;
CREATE POLICY wallet_discovery_rejections_service_role_only
  ON public.wallet_discovery_rejections
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
