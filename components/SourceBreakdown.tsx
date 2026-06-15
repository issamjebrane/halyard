import type { Signal } from "@/lib/types";
import { computeMetrics } from "@/lib/metrics";
import { fmtR } from "@/lib/format";
import InfoTip from "./InfoTip";

const label = (src: string | null) => (src ? src.replace("telegram:", "tg · ") : "manual");

// Split the track record by source so manual signals and each channel feed can
// be compared head-to-head. Reuses the exact same metrics math as the headline.
export default function SourceBreakdown({ signals }: { signals: Signal[] }) {
  const groups = new Map<string | null, Signal[]>();
  for (const s of signals) {
    const key = s.source ?? null;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(s);
  }
  const rows = [...groups.entries()]
    .map(([src, list]) => ({ src, list, m: computeMetrics(list) }))
    .sort((a, b) => b.list.length - a.list.length);

  if (rows.length <= 1) return null; // nothing to compare

  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-muted">
        <span>by source</span>
        <InfoTip label="What by source shows">
          The same metrics, split by where each signal came from — so you can see which
          feed actually performs. Win rate and cumulative R are over closed trades only.
        </InfoTip>
      </h2>
      <div className="overflow-x-auto border border-border">
        <table className="w-full border-collapse font-mono text-xs">
          <thead>
            <tr className="border-b border-border text-left text-muted">
              <Th>source</Th>
              <Th>signals</Th>
              <Th>closed</Th>
              <Th>open</Th>
              <Th>win%</Th>
              <Th>cum R</Th>
              <Th>expectancy</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ src, list, m }) => (
              <tr key={src ?? "manual"} className="border-b border-border/60 last:border-0 hover:bg-background/40">
                <Td className="text-foreground">{label(src)}</Td>
                <Td className="tabular-nums">{list.length}</Td>
                <Td className="tabular-nums text-muted">{m.total}</Td>
                <Td className="tabular-nums text-muted">{m.open}</Td>
                <Td className="tabular-nums">{m.total ? `${m.win_rate.toFixed(0)}%` : "—"}</Td>
                <Td className={m.cum_r > 0 ? "tabular-nums text-buy" : m.cum_r < 0 ? "tabular-nums text-sell" : "tabular-nums text-muted"}>
                  {m.total ? fmtR(m.cum_r) : "—"}
                </Td>
                <Td className="tabular-nums text-muted">{m.total ? fmtR(m.expectancy) : "—"}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 font-normal uppercase tracking-wider">{children}</th>;
}
function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2 ${className}`}>{children}</td>;
}
