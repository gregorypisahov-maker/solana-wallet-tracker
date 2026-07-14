import { createClient } from "@supabase/supabase-js";

type SupabaseAdminOptions = {
  noStore?: boolean;
};

// Server-side client using the service role key. Used by API routes and the worker.
// NEVER import this from client components — it bypasses RLS.
export function getSupabaseAdmin(options: SupabaseAdminOptions = {}) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  const fetchNoStore: typeof fetch = (input, init) =>
    fetch(input, { ...init, cache: "no-store" });

  return createClient(url, key, {
    auth: { persistSession: false },
    ...(options.noStore
      ? { global: { fetch: fetchNoStore } }
      : {}),
  });
}
