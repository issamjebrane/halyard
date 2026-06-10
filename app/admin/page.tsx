import { redirect } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { getProfile } from "@/lib/supabase/session";
import { supabaseServer } from "@/lib/supabase/server";
import { getShareToken } from "@/lib/share";
import { computeMetrics, computeTrust, buildEquity } from "@/lib/metrics";
import type { Signal, Notification, SignalEvent } from "@/lib/types";
import { fmtR, rel } from "@/lib/format";
import TrustPanel from "@/components/TrustPanel";
import EquityChart from "@/components/EquityChart";
import SignalsTable from "@/components/SignalsTable";
import SignalTape from "@/components/SignalTape";
import EngineTapeInfo from "@/components/EngineTapeInfo";
import { regenerateShare } from "./actions";

export const dynamic = "force-dynamic";

type Row = Omit<Signal, "trader_name"> & { profiles: { username: string } | null };

export default async function AdminPage() {
  const profile = await getProfile();
  if (!profile) redirect("/login");
  if (profile.role !== "admin") redirect("/trader");

  const sb = await supabaseServer();
  const { data } = await sb
    .from("signals")
    .select("*, profiles(username)")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });

  const signals: Signal[] = ((data ?? []) as Row[]).map((r) => ({
    ...r,
    trader_name: r.profiles?.username,
  }));

  const metrics = computeMetrics(signals);
  const trust = computeTrust(signals);
  const equity = buildEquity(signals);

  const { data: notes } = await sb
    .from("notifications")
    .select("*")
    .order("id", { ascending: false })
    .limit(15);
  const notifications = (notes ?? []) as Notification[];

  // Everything the engine ("Simon") has done lately, across every signal.
  const { data: ev } = await sb
    .from("signal_events")
    .select("*")
    .order("id", { ascending: false })
    .limit(50);
  const events = (ev ?? []) as SignalEvent[];

  const token = await getShareToken();
  const h = await headers();
  const base = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
  const shareUrl = `${base}/p/${token}`;

  return (
    <div className="space-y-8">
      <TrustPanel trust={trust} />

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric k="closed" v={String(metrics.total)} />
        <Metric k="open" v={String(metrics.open)} />
        <Metric k="pending" v={String(metrics.pending)} />
        <Metric k="cumulative" v={fmtR(metrics.cum_r)} />
      </section>

      <section className="space-y-3">
        <h2 className="font-mono text-xs uppercase tracking-wider text-muted">
          equity (R)
        </h2>
        <EquityChart equity={equity} />
      </section>

      <section className="space-y-3 border border-border bg-surface p-5">
        <h2 className="font-mono text-xs uppercase tracking-wider text-muted">
          public record
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          <code className="break-all border border-border bg-background px-3 py-2 font-mono text-xs">
            {shareUrl}
          </code>
          <Link
            href={`/p/${token}`}
            className="border border-border px-3 py-2 text-xs hover:border-foreground"
          >
            open
          </Link>
          <a
            href="/api/export.csv"
            className="border border-border px-3 py-2 text-xs hover:border-foreground"
          >
            export csv
          </a>
          <form action={regenerateShare}>
            <button
              type="submit"
              className="border border-border px-3 py-2 text-xs text-sell hover:border-sell"
            >
              rotate link
            </button>
          </form>
        </div>
      </section>

      {notifications.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-mono text-xs uppercase tracking-wider text-muted">
            alerts
          </h2>
          <ul className="border border-border bg-surface font-mono text-xs">
            {notifications.map((n) => (
              <li
                key={n.id}
                className="flex justify-between gap-4 border-b border-border/60 px-4 py-2 last:border-0"
              >
                <span
                  className={n.type === "signal_closed" ? "text-foreground" : "text-muted"}
                >
                  {n.message}
                </span>
                <span className="text-muted">{rel(n.created_at)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {events.length > 0 && (
        <section className="space-y-3">
          <h2 className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-muted">
            <span>engine activity</span>
            <EngineTapeInfo />
          </h2>
          <SignalTape events={events} />
        </section>
      )}

      <section className="space-y-3">
        <h2 className="font-mono text-xs uppercase tracking-wider text-muted">
          all signals
        </h2>
        <SignalsTable signals={signals} showTrader />
      </section>
    </div>
  );
}

function Metric({ k, v }: { k: string; v: string }) {
  return (
    <div className="border border-border bg-surface px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-muted">{k}</div>
      <div className="mt-1 font-mono text-lg tabular-nums">{v}</div>
    </div>
  );
}
