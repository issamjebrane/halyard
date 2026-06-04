import "server-only";
import { supabaseService } from "./supabase/service";

export function randomToken(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

// Read the public-report share token, creating it on first use.
export async function getShareToken(): Promise<string> {
  const svc = supabaseService();
  const { data } = await svc
    .from("settings")
    .select("value")
    .eq("key", "share_token")
    .maybeSingle();
  if (data?.value) return data.value as string;
  const token = randomToken();
  await svc.from("settings").insert({ key: "share_token", value: token });
  return token;
}
