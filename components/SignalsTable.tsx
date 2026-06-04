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
              <Td>{fmt(s.stop_loss)}</Td>
              <Td>{fmt(s.tp1)}</Td>
              <Td className="text-muted">{fmt(s.tp2)}</Td>
              <Td className="text-muted">{fmt(s.tp3)}</Td>
              <Td className={STATUS_CLASS[s.status] ?? ""}>{s.status}</Td>
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
              <Td className="text-muted">{rel(s.created_at)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
