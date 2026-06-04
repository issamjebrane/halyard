"use client";

import { useEffect, useState } from "react";

export default function PriceTicker({ initial }: { initial: number | null }) {
  const [price, setPrice] = useState<number | null>(initial);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const res = await fetch("/api/price", { cache: "no-store" });
        const j = await res.json();
        if (alive && j.ok) {
          setPrice(j.price);
          setStale(false);
        } else if (alive) setStale(true);
      } catch {
        if (alive) setStale(true);
      }
    }
    tick();
    const id = setInterval(tick, 30000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="flex items-baseline gap-3 border border-border bg-surface px-5 py-4">
      <span className="text-xs uppercase tracking-wider text-muted">XAU/USD</span>
      <span className="font-mono text-2xl tabular-nums">
        {price == null ? "—" : price.toFixed(2)}
      </span>
      {stale && <span className="text-xs text-sell">stale</span>}
      <span className="ml-auto text-[10px] uppercase tracking-wider text-muted">
        binance · paxg
      </span>
    </div>
  );
}
