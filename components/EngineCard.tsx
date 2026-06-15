"use client";

import { useEffect, useMemo, useState } from "react";
import type { Mt5Status } from "@/lib/types";
import { supabaseBrowser } from "@/lib/supabase/client";
import { fmt } from "@/lib/format";
import TimeStamp from "./TimeStamp";
import InfoTip from "./InfoTip";

// The engine heartbeat, live. It shows the newest of two sources without ever
// reloading the page:
//   • `initial` — the server snapshot, refreshed in place by <LiveData> polling
//     (fallback for when realtime is RLS-blocked or drops), and
//   • realtime — mt5_status row changes streamed straight to this client.
// The age ticks every second so live / lagging / down stays true to the moment.
export default function EngineCard({ initial }: { initial: Mt5Status | null }) {
  const [live, setLive] = useState<Mt5Status | null>(null);
  const [ageS, setAgeS] = useState<number | null>(null);

  // realtime: capture the newest heartbeat as it streams in
  useEffect(() => {
    const sb = supabaseBrowser();
    const ch = sb
      .channel("engine:mt5_status")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "mt5_status" },
        (p) => {
          const row = p.new as Mt5Status | undefined;
          if (row && row.id != null) setLive(row);
        },
      )
      .subscribe();
    return () => {
      sb.removeChannel(ch);
    };
  }, []);

  // whichever heartbeat is newer wins — no prop→state syncing needed.
  // compare parsed instants: the realtime payload sends timestamptz as the raw
  // PG string ("… 09:00:00+00", space-separated) while the server snapshot is
  // ISO ("…T09:00:00+00:00"), so a lexicographic compare would be wrong.
  const ea = useMemo(() => {
    if (!initial) return live;
    if (!live) return initial;
    return new Date(live.updated_at).getTime() >= new Date(initial.updated_at).getTime()
      ? live
      : initial;
  }, [initial, live]);

  // tick the age client-side (Date.now() lives in the callback, never in render)
  const stamp = ea?.updated_at ?? null;
  useEffect(() => {
    const tick = () =>
      setAgeS(stamp ? (Date.now() - new Date(stamp).getTime()) / 1000 : null);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [stamp]);

  const dot =
    ageS == null ? "bg-muted" : ageS < 30 ? "bg-buy" : ageS < 120 ? "bg-accent" : "bg-sell";
  const label =
    ageS == null ? "offline" : ageS < 30 ? "live" : ageS < 120 ? "lagging" : "down";

  return (
    <div className="border border-border bg-surface p-4">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted">
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${dot} ${
            label === "live" ? "animate-pulse" : ""
          }`}
        />
        <span>engine · mt5 {label}</span>
        <InfoTip label="What the engine status means" width="w-72">
          <span className="mb-2 block text-foreground">The MT5 copier checks in every few seconds with its broker price, equity and open trades. This is live — it updates on its own.</span>
          <span className="mt-1 block"><span className="text-buy">live</span> — checked in under 30s ago (all good)</span>
          <span className="mt-1 block"><span className="text-accent">lagging</span> — 30s–2min (slow, but alive)</span>
          <span className="mt-1 block"><span className="text-sell">down</span> — over 2min (the copier likely stopped)</span>
        </InfoTip>
      </div>
      {ea ? (
        <dl className="mt-3 space-y-2 font-mono text-xs">
          <Row k="heartbeat"><TimeStamp iso={ea.updated_at} /></Row>
          <Row k="price"><span className="tabular-nums">{fmt(ea.bid)}</span></Row>
          <Row k="equity"><span className="tabular-nums">{fmt(ea.equity)} / {fmt(ea.balance)}</span></Row>
          <Row k="open"><span className="tabular-nums">{ea.open_positions ?? 0}</span></Row>
        </dl>
      ) : (
        <p className="mt-3 font-mono text-xs text-muted">no heartbeat yet.</p>
      )}
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-muted">{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}
