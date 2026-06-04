import { redirect } from "next/navigation";
import { getProfile } from "@/lib/supabase/session";

export const dynamic = "force-dynamic";

export default async function Home() {
  const profile = await getProfile();
  if (!profile) redirect("/login");
  redirect(profile.role === "admin" ? "/admin" : "/trader");
}
