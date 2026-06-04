import type { Equity } from "@/lib/metrics";
import { fmtR } from "@/lib/format";

export default function EquityChart({ equity }: { equity: Equity }) {
  if (!equity.has_data) {
    return <p className="text-sm text-muted">no closed trades yet.</p>;
  }
  return (
    <div className="border border-border bg-surface p-3">
      <svg
        viewBox={`0 0 ${equity.w} ${equity.h}`}
        className="w-full"
        preserveAspectRatio="none"
      >
        <line
          x1={equity.x0}
          y1={equity.zero_y}
          x2={equity.xn}
          y2={equity.zero_y}
          className="stroke-border"
          strokeWidth="1"
          strokeDasharray="3 3"
        />
        <path
          d={equity.path}
          fill="none"
          className={equity.final >= 0 ? "stroke-buy" : "stroke-sell"}
          strokeWidth="1.5"
        />
      </svg>
      <div className="mt-2 text-right font-mono text-xs text-muted">
        cumulative {fmtR(equity.final)}
      </div>
    </div>
  );
}
