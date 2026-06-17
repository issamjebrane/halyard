import { fmt, fmtR } from "@/lib/format";
import InfoTip from "./InfoTip";

// The record at a glance — the headline ledger numbers so the full track record
// reads in one row before the dense tables below. Surfaces the duality the rest
// of the ledger exists to reconcile: theoretical `cum R` (verifier grade on the
// gold feed) next to `realized €` (the broker truth on the demo account).
export default function LedgerSummary({
  signals,
  closed,
  open,
  winRate,
  cumR,
  realized,
  settled,
}: {
  signals: number;
  closed: number;
  open: number;
  winRate: number;
  cumR: number;
  realized: number;
  settled: number;
}) {
  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-muted">
        <span>record</span>
        <InfoTip label="What the record shows" width="w-80">
          The verified track record at a glance. <span className="font-mono text-foreground">cum R</span> is the
          verifier&apos;s theoretical grade on the gold feed; <span className="font-mono text-foreground">realized €</span> is
          the broker truth — money actually realized on the demo account. They can diverge; the tables below show where.
        </InfoTip>
      </h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Tile k="signals" v={String(signals)} />
        <Tile k="closed" v={String(closed)} />
        <Tile k="open" v={String(open)} />
        <Tile k="win rate" v={closed ? `${winRate.toFixed(0)}%` : "—"} />
        <Tile
          k="cum R"
          v={closed ? fmtR(cumR) : "—"}
          tone={closed ? (cumR > 0 ? "buy" : cumR < 0 ? "sell" : undefined) : undefined}
        />
        <Tile
          k="realized €"
          v={settled ? fmt(realized) : "—"}
          sub={settled ? `${settled} settled` : undefined}
          tone={settled ? (realized > 0 ? "buy" : realized < 0 ? "sell" : undefined) : undefined}
        />
      </div>
    </section>
  );
}

function Tile({ k, v, sub, tone }: { k: string; v: string; sub?: string; tone?: "buy" | "sell" }) {
  const c = tone === "buy" ? "text-buy" : tone === "sell" ? "text-sell" : "";
  return (
    <div className="border border-border bg-surface px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-muted">{k}</div>
      <div className={`mt-1 font-mono text-lg tabular-nums ${c}`}>{v}</div>
      {sub && <div className="mt-0.5 text-[10px] tabular-nums text-muted">{sub}</div>}
    </div>
  );
}
