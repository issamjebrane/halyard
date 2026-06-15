import { redirect } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { getProfile } from "@/lib/supabase/session";
import { supabaseServer } from "@/lib/supabase/server";
import { getShareToken } from "@/lib/share";
import { computeMetrics, computeTrust, buildEquity } from "@/lib/metrics";
import type { Signal, Notification, SignalEvent, Execution, Mt5Status } from "@/lib/types";
import { fmtR, countWithin, secondsSince } from "@/lib/format";
import TrustPanel from "@/components/TrustPanel";
import EquityChart from "@/components/EquityChart";
import SignalsExplorer from "@/components/SignalsExplorer";
import SignalTape from "@/components/SignalTape";
import OpsPanel from "@/components/OpsPanel";
import SourceBreakdown from "@/components/SourceBreakdown";
import Analysis from "@/components/Analysis";
import EngineTapeInfo from "@/components/EngineTapeInfo";
import SignalsTableInfo from "@/components/SignalsTableInfo";
import InfoTip from "@/components/InfoTip";
import TimeStamp from "@/components/TimeStamp";
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

  // Operations: what the MT5 copier did (executions ledger) + ingest stats.
  const { data: exData } = await sb
    .from("executions")
    .select("*")
    .order("id", { ascending: false })
    .limit(500);
  const executions = (exData ?? []) as Execution[];
  const execCounts: Partial<Record<Execution["status"], number>> = {};
  for (const e of executions) execCounts[e.status] = (execCounts[e.status] ?? 0) + 1;

  const tg = signals.filter((s) => s.source === "telegram:gold_vip");
  const last24h = countWithin(signals.map((s) => s.created_at));
  const ingest = { lastAt: tg[0]?.created_at ?? null, last24h, total: tg.length };
  const exec = { counts: execCounts, total: executions.length, recent: executions.slice(0, 6) };

  const { data: stData } = await sb.from("mt5_status").select("*").eq("id", 1).maybeSingle();
  const ea = (stData ?? null) as Mt5Status | null;
  const eaAgeS = ea ? secondsSince(ea.updated_at) : null;

  const token = await getShareToken();
  const h = await headers();
  const base = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
  const shareUrl = `${base}/p/${token}`;

  return (
    <div className="space-y-8">
      <TrustPanel trust={trust} />

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Metric k="closed" v={String(metrics.total)} />
        <Metric k="open" v={String(metrics.open)} />
        <Metric k="pending" v={String(metrics.pending)} />
        <Metric
          k="cumulative"
          v={fmtR(metrics.cum_r)}
          tone={metrics.cum_r > 0 ? "buy" : metrics.cum_r < 0 ? "sell" : undefined}
        />
        <Metric k="last 24h" v={String(last24h)} />
        <Metric k="win rate" v={metrics.total ? `${metrics.win_rate.toFixed(0)}%` : "—"} />
      </section>

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-muted">
          <span>equity (R)</span>
          <InfoTip label="What the equity curve shows">
            Running total of result (in R) across closed trades, in the order
            they closed. Up and to the right is good; the dashed line is break-even.
          </InfoTip>
        </h2>
        <EquityChart equity={equity} />
      </section>

      <Analysis signals={signals} />

      <OpsPanel ingest={ingest} exec={exec} ea={ea} eaAgeS={eaAgeS} />

      {notifications.length > 0 && (
        <section className="space-y-3">
          <h2 className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-muted">
            <span>alerts</span>
            <InfoTip label="What alerts are">
              Engine notifications: a new signal was posted, or a signal closed
              (won/lost). Newest first.
            </InfoTip>
          </h2>
          <ul className="border border-border bg-surface font-mono text-xs">
            {notifications.map((n) => (
              <li
                key={n.id}
                className="flex justify-between gap-4 border-b border-border/60 px-4 py-2 last:border-0"
              >
                <span className={n.type === "signal_closed" ? "text-foreground" : "text-muted"}>
                  {n.message}
                </span>
                <TimeStamp iso={n.created_at} className="text-muted" />
              </li>
            ))}
          </ul>
        </section>
      )}

      <SourceBreakdown signals={signals} />

      {events.length > 0 && (
        <section className="space-y-3">
          <h2 className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-muted">
            <span>engine activity</span>
            <EngineTapeInfo />
          </h2>
          <SignalTape events={events} />
        </section>
      )}

      <section className="space-y-3 border border-border bg-surface p-5">
        <h2 className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-muted">
          <span>public record</span>
          <InfoTip label="What the public record is">
            A read-only, shareable page of the verified track record. Anyone with
            the link can view it — no login. <span className="text-foreground">rotate link</span>{" "}
            revokes the old URL; <span className="text-foreground">export csv</span>{" "}
            downloads every signal.
          </InfoTip>
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          <code className="break-all border border-border bg-background px-3 py-2 font-mono text-xs">
            {shareUrl}
          </code>
          <Link href={`/p/${token}`} className="border border-border px-3 py-2 text-xs hover:border-foreground">
            open
          </Link>
          <a href="/api/export.csv" className="border border-border px-3 py-2 text-xs hover:border-foreground">
            export csv
          </a>
          <form action={regenerateShare}>
            <button type="submit" className="border border-border px-3 py-2 text-xs text-sell hover:border-sell">
              rotate link
            </button>
          </form>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-muted">
          <span>all signals</span>
          <SignalsTableInfo />
        </h2>
        <SignalsExplorer signals={signals} showTrader />
      </section>
    </div>
  );
}

function Metric({ k, v, tone }: { k: string; v: string; tone?: "buy" | "sell" }) {
  const c = tone === "buy" ? "text-buy" : tone === "sell" ? "text-sell" : "";
  return (
    <div className="border border-border bg-surface px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-muted">{k}</div>
      <div className={`mt-1 font-mono text-lg tabular-nums ${c}`}>{v}</div>
    </div>
  );
}
