import { notFound } from "next/navigation";
import { supabaseService } from "@/lib/supabase/service";
import { computeTrust, buildEquity } from "@/lib/metrics";
import type { Signal } from "@/lib/types";
import TrustPanel from "@/components/TrustPanel";
import EquityChart from "@/components/EquityChart";
import SignalsTable from "@/components/SignalsTable";

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
        <h2 className="font-mono text-xs uppercase tracking-wider text-muted">
          equity (R)
        </h2>
        <EquityChart equity={equity} />
      </section>
      <section className="space-y-3">
        <h2 className="font-mono text-xs uppercase tracking-wider text-muted">
          signals
        </h2>
        <SignalsTable signals={signals} showTrader />
      </section>
    </div>
  );
}
