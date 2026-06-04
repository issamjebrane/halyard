"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";

type SignInState = { error?: string } | undefined;

export async function signIn(
  _prev: SignInState,
  formData: FormData
): Promise<SignInState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) return { error: "email and passphrase required" };

  const sb = await supabaseServer();
  const { error } = await sb.auth.signInWithPassword({ email, password });

  if (error) return { error: error.message.toLowerCase() };

  revalidatePath("/", "layout");
  redirect("/");
}

export async function signOut() {
  const sb = await supabaseServer();
  await sb.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/login");
}
