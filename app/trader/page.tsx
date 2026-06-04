import { redirect } from "next/navigation";
import { getProfile } from "@/lib/supabase/session";
import { supabaseServer } from "@/lib/supabase/server";
import type { Signal } from "@/lib/types";
import { DAILY_SIGNAL_LIMIT } from "@/lib/constants";
import SignalsTable from "@/components/SignalsTable";
import PriceTicker from "@/components/PriceTicker";
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

  // Signals posted since UTC midnight count against the daily cap.
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const usedToday = signals.filter(
    (s) => new Date(s.created_at) >= dayStart,
  ).length;
  const remaining = Math.max(0, DAILY_SIGNAL_LIMIT - usedToday);

  return (
    <div className="space-y-8">
      <PriceTicker initial={(pc?.price as number | undefined) ?? null} />
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
