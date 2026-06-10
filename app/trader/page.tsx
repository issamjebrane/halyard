import { redirect } from "next/navigation";
import { getProfile } from "@/lib/supabase/session";
import { supabaseServer } from "@/lib/supabase/server";
import type { Signal, SignalEvent } from "@/lib/types";
import { DAILY_SIGNAL_LIMIT } from "@/lib/constants";
import SignalsTable from "@/components/SignalsTable";
import SignalTape from "@/components/SignalTape";
import EngineTapeInfo from "@/components/EngineTapeInfo";
import PriceTicker from "@/components/PriceTicker";
import GoldChart from "@/components/GoldChart";
import TimezoneSync from "@/components/TimezoneSync";
import TraderForm from "./form";

export const dynamic = "force-dynamic";

export default async function TraderPage() {
  const profile = await getProfile();
  if (!profile) redirect("/login");
  if (profile.role !== "trader") redirect("/admin");

  const sb = await supabaseServer();
  const { data } = await sb
    .from("signals")
    .select("*")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });
  const { data: pc } = await sb
    .from("price_cache")
    .select("price")
    .eq("id", 1)
    .maybeSingle();

  const signals = (data ?? []) as Signal[];
  const featured = signals[0] ?? null;

  // The engine's event tape for the most recent signal (RLS scopes to own).
  let events: SignalEvent[] = [];
  if (featured) {
    const { data: ev } = await sb
      .from("signal_events")
      .select("*")
      .eq("signal_id", featured.id)
      .order("id", { ascending: true });
    events = (ev ?? []) as SignalEvent[];
  }

  // Today's post count in the trader's LOCAL day (computed server-side, tz-aware).
  const { data: usedToday } = await sb.rpc("signals_used_today");
  const remaining = Math.max(
    0,
    DAILY_SIGNAL_LIMIT - ((usedToday as number | null) ?? 0),
  );

  return (
    <div className="space-y-8">
      <TimezoneSync current={profile.timezone} />
      <PriceTicker initial={(pc?.price as number | undefined) ?? null} />
      <GoldChart signal={featured} />
      {featured && (
        <section className="space-y-3">
          <h2 className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-muted">
            <span>engine tape · #{featured.id}</span>
            <EngineTapeInfo />
          </h2>
          <SignalTape events={events} signalId={featured.id} />
        </section>
      )}
      <TraderForm remaining={remaining} />
      <section className="space-y-3">
        <h2 className="font-mono text-xs uppercase tracking-wider text-muted">
          your signals
        </h2>
        <SignalsTable signals={signals} />
      </section>
    </div>
  );
}
