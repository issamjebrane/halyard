import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/supabase/session";
import LoginForm from "./form";

export default async function LoginPage() {
  const user = await getSessionUser();
  if (user) redirect("/");
  return <LoginForm />;
}
