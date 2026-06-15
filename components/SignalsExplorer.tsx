"use client";

import { useMemo, useState } from "react";
import type { Signal, SignalStatus } from "@/lib/types";
import SignalsTable from "./SignalsTable";

const STATUSES: (SignalStatus | "all")[] = ["all", "open", "won", "lost", "breakeven", "pending", "cancelled"];
const DIRS = ["all", "buy", "sell"] as const;
const SORTS = [
  { k: "new", label: "newest" },
  { k: "old", label: "oldest" },
  { k: "rhi", label: "R high→low" },
  { k: "rlo", label: "R low→high" },
] as const;

const srcLabel = (s: string | null) => (s ? s.replace("telegram:", "tg · ") : "manual");

export default function SignalsExplorer({
  signals,
  showTrader = false,
}: {
  signals: Signal[];
  showTrader?: boolean;
}) {
  const [status, setStatus] = useState<string>("all");
  const [dir, setDir] = useState<string>("all");
  const [src, setSrc] = useState<string>("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<string>("new");

  const sources = useMemo(() => {
    const set = new Set<string>();
    for (const s of signals) set.add(s.source ?? "manual");
    return ["all", ...[...set].sort()];
  }, [signals]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = signals.filter((s) => {
      if (status !== "all" && s.status !== status) return false;
      if (dir !== "all" && s.direction !== dir) return false;
      if (src !== "all" && (s.source ?? "manual") !== src) return false;
      if (needle) {
        const hay = `${s.id} ${s.trader_name ?? ""} ${s.symbol}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
    const r = (s: Signal) => s.result_r;
    rows.sort((a, b) => {
      if (sort === "new") return b.id - a.id;
      if (sort === "old") return a.id - b.id;
      const ra = r(a), rb = r(b);
      if (ra == null && rb == null) return b.id - a.id;
      if (ra == null) return 1; // nulls last
      if (rb == null) return -1;
      return sort === "rhi" ? rb - ra : ra - rb;
    });
    return rows;
  }, [signals, status, dir, src, q, sort]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <ChipGroup options={STATUSES} value={status} onChange={setStatus} />
        <span className="text-border">|</span>
        <ChipGroup options={DIRS} value={dir} onChange={setDir} />
        {sources.length > 2 && (
          <>
            <span className="text-border">|</span>
            <ChipGroup options={sources} value={src} onChange={setSrc} render={srcLabel} />
          </>
        )}
        <span className="ml-auto flex items-center gap-3">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="search id / trader…"
            className="w-40 border border-border bg-background px-2 py-1 font-mono text-xs placeholder:text-muted focus:border-foreground focus:outline-none"
          />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            className="border border-border bg-background px-2 py-1 font-mono text-xs focus:border-foreground focus:outline-none"
          >
            {SORTS.map((o) => (
              <option key={o.k} value={o.k}>{o.label}</option>
            ))}
          </select>
        </span>
      </div>

      <SignalsTable signals={filtered} showTrader={showTrader} />

      <p className="font-mono text-[10px] uppercase tracking-wider text-muted">
        showing {filtered.length} of {signals.length}
      </p>
    </div>
  );
}

function ChipGroup({
  options,
  value,
  onChange,
  render = (s: string) => s,
}: {
  options: readonly string[];
  value: string;
  onChange: (v: string) => void;
  render?: (s: string) => string;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => onChange(o)}
          className={`border px-2 py-1 font-mono text-[11px] lowercase transition-colors ${
            value === o
              ? "border-foreground text-foreground"
              : "border-border text-muted hover:border-muted hover:text-foreground"
          }`}
        >
          {render(o)}
        </button>
      ))}
    </div>
  );
}
