"use server";

import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { randomToken } from "@/lib/share";

async function requireAdmin() {
  const sb = await supabaseServer();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return null;
  const { data } = await sb
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  return data?.role === "admin" ? user : null;
}

export async function regenerateShare() {
  const user = await requireAdmin();
  if (!user) return;
  const svc = supabaseService();
  await svc
    .from("settings")
    .upsert({ key: "share_token", value: randomToken() });
  await svc.from("audit_log").insert({
    user_id: user.id,
    username: null,
    action: "share_link_regenerated",
    details: "",
  });
  revalidatePath("/admin");
}
