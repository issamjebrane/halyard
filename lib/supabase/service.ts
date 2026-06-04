import "server-only";
import { createClient } from "@supabase/supabase-js";

// Service-role client — bypasses RLS. Use ONLY in trusted server code for
// privileged reads/writes (token-gated public report, settings, seeding).
export function supabaseService() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
