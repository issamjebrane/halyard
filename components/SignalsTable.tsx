import type { Signal } from "@/lib/types";
import { fmt, fmtR, rel } from "@/lib/format";

const STATUS_CLASS: Record<string, string> = {
  won: "text-buy",
  lost: "text-sell",
  open: "text-foreground",
  pending: "text-muted",
  cancelled: "text-muted",
};

export default function SignalsTable({
  signals,
  showTrader = false,
}: {
  signals: Signal[];
  showTrader?: boolean;
}) {
  if (signals.length === 0) {
    return <p className="text-sm text-muted">no signals yet.</p>;
  }
  return (
    <div className="overflow-x-auto border border-border">
      <table className="w-full border-collapse font-mono text-xs">
        <thead>
          <tr className="border-b border-border text-left text-muted">
            <Th>#</Th>
            {showTrader && <Th>trader</Th>}
            <Th>dir</Th>
            <Th>type</Th>
            <Th>entry</Th>
            <Th>sl</Th>
            <Th>tp1</Th>
            <Th>tp2</Th>
            <Th>tp3</Th>
            <Th>status</Th>
            <Th>R</Th>
            <Th>pips</Th>
            <Th>mfe</Th>
            <Th>mae</Th>
            <Th>age</Th>
          </tr>
        </thead>
        <tbody>
          {signals.map((s) => (
            <tr key={s.id} className="border-b border-border/60 last:border-0">
              <Td>{s.id}</Td>
              {showTrader && <Td>{s.trader_name ?? "—"}</Td>}
              <Td className={s.direction === "buy" ? "text-buy" : "text-sell"}>
                {s.direction}
              </Td>
              <Td className="text-muted">{s.order_type}</Td>
              <Td>{fmt(s.entry_price)}</Td>
              <Td className={s.sl_hit_at ? "text-sell" : ""}>{fmt(s.stop_loss)}</Td>
              <Tp price={s.tp1} hit={s.tp1_hit_at != null} />
              <Tp price={s.tp2} hit={s.tp2_hit_at != null} />
              <Tp price={s.tp3} hit={s.tp3_hit_at != null} />
              <Td className={STATUS_CLASS[s.status] ?? ""}>
                {s.status}
                {s.peak_tp > 0 && (
                  <span className="text-muted"> · tp{s.peak_tp}</span>
                )}
              </Td>
              <Td
                className={
                  s.result_r == null
                    ? "text-muted"
                    : s.result_r >= 0
                      ? "text-buy"
                      : "text-sell"
                }
              >
                {s.result_r == null ? "—" : fmtR(s.result_r)}
              </Td>
              <Td className="text-muted">
                {s.result_pips == null ? "—" : fmt(s.result_pips, 1)}
              </Td>
              <Td className={s.mfe_r == null ? "text-muted" : "text-buy"}>
                {s.mfe_r == null ? "—" : fmtR(s.mfe_r)}
              </Td>
              <Td className={s.mae_r == null ? "text-muted" : "text-sell"}>
                {s.mae_r == null ? "—" : fmtR(s.mae_r)}
              </Td>
              <Td className="text-muted">{rel(s.created_at)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// A take-profit cell: bright + ✓ once the engine has touched it, muted until then.
function Tp({ price, hit }: { price: number | null; hit: boolean }) {
  if (price == null) return <Td className="text-muted">—</Td>;
  return (
    <Td className={hit ? "text-buy" : "text-muted"}>
      {fmt(price)}
      {hit && " ✓"}
    </Td>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 font-normal uppercase tracking-wider">{children}</th>;
}
function Td({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-3 py-2 ${className}`}>{children}</td>;
}
