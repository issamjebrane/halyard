"use server";

import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";

// Persist the browser-detected IANA timezone for the current user. Called
// silently from the client on load — the user is never prompted.
export async function syncTimezone(tz: string) {
  if (!tz || typeof tz !== "string") return;
  const sb = await supabaseServer();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return;
  await sb.rpc("set_timezone", { p_tz: tz });
  revalidatePath("/trader");
}
