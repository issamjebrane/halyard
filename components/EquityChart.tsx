import type { Equity } from "@/lib/metrics";
import { fmtR } from "@/lib/format";

export default function EquityChart({ equity }: { equity: Equity }) {
  if (!equity.has_data) {
    return <p className="text-sm text-muted">no closed trades yet.</p>;
  }
  const { w, h, pad, zero_y, lo, hi, trades, final, path, x0, xn } = equity;
  const pct = (yPx: number) => `${(yPx / h) * 100}%`;

  return (
    <div className="border border-border bg-surface p-3">
      <div className="flex">
        {/* y-axis — R scale (peak / break-even / low), aligned to the plot */}
        <div className="relative w-12 shrink-0 font-mono text-[10px] tabular-nums text-muted">
          <span className="absolute right-2 -translate-y-1/2" style={{ top: pct(pad) }}>{fmtR(hi)}</span>
          <span className="absolute right-2 -translate-y-1/2 text-foreground/40" style={{ top: pct(parseFloat(zero_y)) }}>0R</span>
          <span className="absolute right-2 -translate-y-1/2" style={{ top: pct(h - pad) }}>{fmtR(lo)}</span>
        </div>

        {/* chart */}
        <svg viewBox={`0 0 ${w} ${h}`} className="w-full" preserveAspectRatio="none">
          <line
            x1={x0}
            y1={zero_y}
            x2={xn}
            y2={zero_y}
            className="stroke-border"
            strokeWidth="1"
            strokeDasharray="3 3"
          />
          <path
            d={path}
            fill="none"
            className={final >= 0 ? "stroke-buy" : "stroke-sell"}
            strokeWidth="1.5"
          />
        </svg>
      </div>

      {/* numbers */}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 font-mono text-xs text-muted">
        <span>
          {trades} trade{trades === 1 ? "" : "s"} · peak{" "}
          <span className="tabular-nums text-buy">{fmtR(hi)}</span> · low{" "}
          <span className="tabular-nums text-sell">{fmtR(lo)}</span>
        </span>
        <span>
          cumulative{" "}
          <span className={`tabular-nums ${final >= 0 ? "text-buy" : "text-sell"}`}>{fmtR(final)}</span>
        </span>
      </div>
    </div>
  );
}
