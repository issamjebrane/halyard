"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";

// Keeps a server-rendered page current without a manual reload. Two mechanisms,
// belt-and-suspenders:
//   • realtime — subscribe to the given tables and refresh on any change
//     (instant; RLS gates which rows reach this client).
//   • poll — call router.refresh() on an interval as a fallback for when
//     realtime is unavailable (e.g. the anon public page) or drops.
// router.refresh() re-runs the (force-dynamic) server component and reconciles
// in place — no full reload, scroll/inputs preserved. Renders nothing.
export default function LiveData({
  tables = [],
  pollMs = 20000,
}: {
  tables?: string[];
  pollMs?: number;
}) {
  const router = useRouter();
  const tkey = tables.join(",");

  useEffect(() => {
    // coalesce bursts of events into a single refresh
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = null;
        router.refresh();
      }, 400);
    };

    const poll = setInterval(() => router.refresh(), pollMs);

    const sb = supabaseBrowser();
    const list = tkey ? tkey.split(",") : [];
    const channel = list.length ? sb.channel(`live:${tkey}`) : null;
    if (channel) {
      for (const table of list) {
        channel.on(
          "postgres_changes",
          { event: "*", schema: "public", table },
          refresh,
        );
      }
      channel.subscribe();
    }

    return () => {
      clearInterval(poll);
      if (debounce) clearTimeout(debounce);
      if (channel) sb.removeChannel(channel);
    };
  }, [router, pollMs, tkey]);

  return null;
}
