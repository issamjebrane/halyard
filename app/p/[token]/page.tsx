import { notFound } from "next/navigation";
import { supabaseService } from "@/lib/supabase/service";
import { computeTrust, buildEquity } from "@/lib/metrics";
import type { Signal, SignalEvent } from "@/lib/types";
import TrustPanel from "@/components/TrustPanel";
import EquityChart from "@/components/EquityChart";
import SignalsTable from "@/components/SignalsTable";
import SignalTape from "@/components/SignalTape";
import EngineTapeInfo from "@/components/EngineTapeInfo";
import SignalsTableInfo from "@/components/SignalsTableInfo";
import InfoTip from "@/components/InfoTip";
import GoldChart from "@/components/GoldChart";

export const dynamic = "force-dynamic";

type Row = Omit<Signal, "trader_name"> & { profiles: { username: string } | null };

export default async function PublicReport({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const svc = supabaseService();

  const { data: setting } = await svc
    .from("settings")
    .select("value")
    .eq("key", "share_token")
    .maybeSingle();

  if (!setting?.value || setting.value !== token) notFound();

  const { data } = await svc
    .from("signals")
    .select("*, profiles(username)")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });

  const signals: Signal[] = ((data ?? []) as Row[]).map((r) => ({
    ...r,
    trader_name: r.profiles?.username,
  }));

  const featured = signals[0] ?? null;
  let events: SignalEvent[] = [];
  if (featured) {
    const { data: ev } = await svc
      .from("signal_events")
      .select("*")
      .eq("signal_id", featured.id)
      .order("id", { ascending: true });
    events = (ev ?? []) as SignalEvent[];
  }

  const trust = computeTrust(signals);
  const equity = buildEquity(signals);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-mono text-sm">verified track record · XAU/USD</h1>
        <p className="mt-1 text-xs text-muted">
          read-only. outcomes are decided by the real gold price — a trade
          closes only when it hits take profit (win) or stop loss (loss).
        </p>
      </div>
      <TrustPanel trust={trust} />
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
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-muted">
          <span>live market</span>
          <InfoTip label="About this chart" width="w-72">
            Real-time XAU/USD candles (Binance PAX Gold). The latest signal&apos;s
            entry, stop loss and TP1–TP3 are drawn on top so you can follow it live.
          </InfoTip>
        </h2>
        <GoldChart signal={featured} />
      </section>
      {featured && (
        <section className="space-y-3">
          <h2 className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-muted">
            <span>engine tape · #{featured.id}</span>
            <EngineTapeInfo />
          </h2>
          <SignalTape events={events} signalId={featured.id} />
        </section>
      )}
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-muted">
          <span>signals</span>
          <SignalsTableInfo />
        </h2>
        <SignalsTable signals={signals} showTrader />
      </section>
    </div>
  );
}
