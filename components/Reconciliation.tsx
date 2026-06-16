import type { Signal, Execution } from "@/lib/types";
import { fmt, fmtR } from "@/lib/format";
import InfoTip from "./InfoTip";

const TRADED = new Set<Execution["status"]>(["placed", "closed", "breakeven"]);

// Side-by-side: what the SIGNAL did (verifier's theoretical R, on the price feed)
// vs what the EA actually did on the broker (fill, slippage, realized money).
// The two can diverge — this is where you see by how much.
export default function Reconciliation({
  signals,
  executions,
}: {
  signals: Signal[];
  executions: Execution[];
}) {
  const byId = new Map(signals.map((s) => [s.id, s]));
  const rows = executions
    .filter((e) => TRADED.has(e.status))
    .map((e) => ({ e, s: byId.get(e.signal_id) }))
    .filter((r): r is { e: Execution; s: Signal } => !!r.s)
    .sort((a, b) => b.e.id - a.e.id);

  if (rows.length === 0) {
    return (
      <section className="space-y-3">
        <Heading />
        <p className="text-sm text-muted">no EA trades yet — fills appear here as the copier places them.</p>
      </section>
    );
  }

  // direction-aware entry slippage: positive = filled worse than the signal entry
  const slip = (s: Signal, e: Execution) =>
    e.entry_fill == null ? null : s.direction === "buy" ? e.entry_fill - s.entry_price : s.entry_price - e.entry_fill;
  const realized = rows.reduce((a, r) => a + (r.e.profit ?? 0), 0);
  const settled = rows.filter((r) => r.e.profit != null).length;

  return (
    <section className="space-y-3">
      <Heading />
      <div className="overflow-x-auto border border-border">
        <table className="w-full border-collapse font-mono text-xs">
          <thead>
            <tr className="border-b border-border bg-surface text-left text-muted">
              <Th>#</Th><Th>acct</Th><Th>dir</Th><Th>lots</Th><Th>entry → fill</Th><Th>slip</Th>
              <Th>signal R</Th><Th>ea result</Th><Th>real €</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ e, s }) => {
              const sl = slip(s, e);
              return (
                <tr key={e.id} className="border-b border-border/60 last:border-0">
                  <Td className="text-muted">{e.signal_id}</Td>
                  <Td className="tabular-nums text-muted">{e.account ?? "—"}</Td>
                  <Td className={s.direction === "buy" ? "text-buy" : "text-sell"}>{s.direction}</Td>
                  <Td>{fmt(e.lots)}</Td>
                  <Td className="text-muted">{fmt(s.entry_price)} → {fmt(e.entry_fill)}</Td>
                  <Td className={sl == null ? "text-muted" : sl > 0.05 ? "text-sell" : "text-muted"}>
                    {sl == null ? "—" : `${sl >= 0 ? "+" : ""}${fmt(sl)}`}
                  </Td>
                  <Td className={s.result_r == null ? "text-muted" : s.result_r >= 0 ? "text-buy" : "text-sell"}>
                    {s.result_r == null ? "—" : fmtR(s.result_r)}
                  </Td>
                  <Td className={e.status === "closed" ? "text-foreground" : e.status === "breakeven" ? "text-accent" : "text-muted"}>
                    {e.status === "placed" ? "open" : e.status}
                  </Td>
                  <Td className={e.profit == null ? "text-muted" : e.profit > 0 ? "text-buy" : e.profit < 0 ? "text-sell" : "text-muted"}>
                    {e.profit == null ? "—" : `${e.profit >= 0 ? "+" : ""}${fmt(e.profit)}`}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="font-mono text-[11px] text-muted">
        realized over {settled} closed trade{settled === 1 ? "" : "s"}:{" "}
        <span className={realized >= 0 ? "text-buy" : "text-sell"}>{realized >= 0 ? "+" : ""}{fmt(realized)}</span>{" "}
        (account €) · <span className="text-foreground">signal R</span> is the verifier&apos;s theoretical grade, <span className="text-foreground">real €</span> is the broker truth.
      </p>
    </section>
  );
}

function Heading() {
  return (
    <h2 className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-muted">
      <span>reconciliation · signal vs broker</span>
      <InfoTip label="What reconciliation shows" width="w-80">
        <span className="mb-2 block text-foreground">Per EA trade: the signal&apos;s theoretical result vs what really happened on the broker.</span>
        <span className="mt-1 block"><span className="font-mono text-foreground">entry → fill</span> — signal entry vs the EA&apos;s actual fill</span>
        <span className="mt-1 block"><span className="font-mono text-foreground">slip</span> — how much worse the fill was ($); red if it cost you</span>
        <span className="mt-1 block"><span className="font-mono text-foreground">signal R</span> — verifier&apos;s grade on the gold feed (theoretical)</span>
        <span className="mt-1 block"><span className="font-mono text-foreground">ea result / real €</span> — the broker outcome + realized money (filled in by the EA on close)</span>
      </InfoTip>
    </h2>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 font-normal uppercase tracking-wider">{children}</th>;
}
function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2 ${className}`}>{children}</td>;
}
