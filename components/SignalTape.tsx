import type { SignalEvent, SignalEventKind } from "@/lib/types";
import { fmt, fmtR, rel } from "@/lib/format";

// How each engine action reads on the tape: label + accent colour.
const KIND: Record<SignalEventKind, { label: string; tone: string }> = {
  activated: { label: "activated", tone: "text-accent" },
  tp1_hit: { label: "tp1 hit", tone: "text-buy" },
  tp2_hit: { label: "tp2 hit", tone: "text-buy" },
  tp3_hit: { label: "tp3 hit", tone: "text-buy" },
  sl_hit: { label: "sl hit", tone: "text-sell" },
  closed: { label: "closed", tone: "text-foreground" },
  settled: { label: "settled", tone: "text-muted" },
  price_extreme: { label: "extreme", tone: "text-muted" },
};

export default function SignalTape({
  events,
  signalId,
}: {
  events: SignalEvent[];
  signalId?: number;
}) {
  if (events.length === 0) {
    return (
      <p className="text-xs text-muted">
        no engine activity{signalId != null ? ` for #${signalId}` : ""} yet.
      </p>
    );
  }
  return (
    <ul className="border border-border bg-surface font-mono text-xs">
      {events.map((e) => {
        const k = KIND[e.kind] ?? { label: e.kind, tone: "text-muted" };
        return (
          <li
            key={e.id}
            className="flex items-baseline gap-4 border-b border-border/60 px-4 py-2 last:border-0"
          >
            {signalId == null && (
              <span className="w-12 shrink-0 text-muted">#{e.signal_id}</span>
            )}
            <span className={`w-20 shrink-0 ${k.tone}`}>{k.label}</span>
            <span className="w-20 shrink-0 tabular-nums">
              {e.price == null ? "—" : fmt(e.price)}
            </span>
            <span
              className={`w-16 shrink-0 tabular-nums ${
                e.r_at_event == null
                  ? "text-muted"
                  : e.r_at_event >= 0
                    ? "text-buy"
                    : "text-sell"
              }`}
            >
              {e.r_at_event == null ? "" : fmtR(e.r_at_event)}
            </span>
            <span className="ml-auto text-muted">{rel(e.created_at)}</span>
          </li>
        );
      })}
    </ul>
  );
}
