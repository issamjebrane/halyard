import "server-only";
import { supabaseServer } from "./server";
import type { Profile } from "@/lib/types";

// Resilient: if the auth backend is briefly unreachable, treat as logged-out
// rather than throwing (which would 500 every route, including /login).
export async function getSessionUser() {
  try {
    const sb = await supabaseServer();
    const {
      data: { user },
    } = await sb.auth.getUser();
    return user;
  } catch {
    return null;
  }
}

export type SessionProfile = Profile & { email: string | null };

export async function getProfile(): Promise<SessionProfile | null> {
  try {
    const sb = await supabaseServer();
    const {
      data: { user },
    } = await sb.auth.getUser();
    if (!user) return null;
    const { data } = await sb
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .maybeSingle();
    if (!data) return null;
    return { ...(data as Profile), email: user.email ?? null };
  } catch {
    return null;
  }
}
