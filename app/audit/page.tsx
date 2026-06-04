import { redirect } from "next/navigation";
import { getProfile } from "@/lib/supabase/session";
import { supabaseServer } from "@/lib/supabase/server";
import { rel } from "@/lib/format";

export const dynamic = "force-dynamic";

type AuditRow = {
  id: number;
  username: string | null;
  action: string;
  details: string | null;
  created_at: string;
};

export default async function AuditPage() {
  const profile = await getProfile();
  if (!profile) redirect("/login");
  if (profile.role !== "admin") redirect("/trader");

  const sb = await supabaseServer();
  const { data } = await sb
    .from("audit_log")
    .select("*")
    .order("id", { ascending: false })
    .limit(500);
  const rows = (data ?? []) as AuditRow[];

  return (
    <section className="space-y-3">
      <h1 className="font-mono text-xs uppercase tracking-wider text-muted">
        audit log
      </h1>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">nothing logged yet.</p>
      ) : (
        <div className="overflow-x-auto border border-border">
          <table className="w-full border-collapse font-mono text-xs">
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border/60 last:border-0">
                  <td className="px-3 py-2 text-muted">{r.username ?? "system"}</td>
                  <td className="px-3 py-2 text-accent">{r.action}</td>
                  <td className="px-3 py-2">{r.details}</td>
                  <td className="px-3 py-2 text-right text-muted">
                    {rel(r.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
