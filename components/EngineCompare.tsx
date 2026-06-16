import type { Signal, Mt5Status, AccountBalancePoint } from "@/lib/types";
import { computeMetrics } from "@/lib/metrics";
import { fmt, fmtR } from "@/lib/format";
import InfoTip from "./InfoTip";

const isClosed = (s: Signal) =>
  !s.excluded && (s.status === "won" || s.status === "lost" || s.status === "breakeven") && s.result_r != null;

// Side-by-side comparison of the two copier engines: telegram (gold vip channel,
// slot 1) vs simon (manual signals, slot 2). Shows the theoretical R record
// (verifier RATCHET grade, backfill excluded) next to the REAL broker account.
export default function EngineCompare({
  signals,
  engines,
  balance,
}: {
  signals: Signal[];
  engines: Mt5Status[];
  balance: AccountBalancePoint[];
}) {
  const acctOf = (id: number) => engines.find((e) => e.id === id)?.account ?? null;
  const cols = [
    { key: "tg", title: "telegram", sub: "gold vip channel", match: (s: Signal) => s.source === "telegram:gold_vip", account: acctOf(1) },
    { key: "si", title: "simon", sub: "manual signals", match: (s: Signal) => s.source == null, account: acctOf(2) },
  ];

  const data = cols.map((c) => {
    const subset = signals.filter(c.match);
    const m = computeMetrics(subset); // excludes flagged rows internally
    const closed = subset.filter(isClosed);
    const dir = (d: "buy" | "sell") => {
      const sub = closed.filter((s) => s.direction === d);
      return { n: sub.length, cum: sub.reduce((a, s) => a + (s.result_r ?? 0), 0) };
    };
    const bh = balance.filter((p) => c.account && p.account === c.account).sort((a, b) => a.id - b.id);
    const start = bh.length ? bh[0].balance ?? 0 : null;
    const cur = bh.length ? bh[bh.length - 1].balance ?? 0 : null;
    const net = start != null && cur != null ? cur - start : null;
    const excluded = subset.filter((s) => s.excluded).length;
    return { ...c, m, buy: dir("buy"), sell: dir("sell"), start, cur, net, excluded };
  });

  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-muted">
        <span>engines — telegram vs simon</span>
        <InfoTip label="What this compares" width="w-80">
          Each copier side by side. <span className="text-foreground">theoretical (R)</span> = how the signals
          graded under RATCHET on the gold price (backfill excluded). <span className="text-foreground">real account (€)</span> =
          the broker balance the EA actually produced. They can differ — judge each engine on the real account.
        </InfoTip>
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {data.map((d) => (
          <div key={d.key} className="space-y-3 border border-border bg-surface p-4">
            <div>
              <div className="font-mono text-sm text-foreground">{d.title}</div>
              <div className="text-[10px] uppercase tracking-wider text-muted">
                {d.sub} · acct {d.account ?? "—"}
                {d.excluded > 0 && <span> · {d.excluded} backfill excluded</span>}
              </div>
            </div>

            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wider text-muted">theoretical (R)</div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs">
                <Kv k="closed" v={String(d.m.total)} />
                <Kv k="win rate" v={d.m.total ? `${d.m.win_rate.toFixed(0)}%` : "—"} />
                <Kv k="cum R" v={d.m.total ? fmtR(d.m.cum_r) : "—"} cls={d.m.cum_r > 0 ? "text-buy" : d.m.cum_r < 0 ? "text-sell" : ""} />
                <Kv k="expectancy" v={d.m.total ? fmtR(d.m.expectancy) : "—"} />
              </dl>
              <div className="mt-1 font-mono text-[11px] text-muted">
                buy <span className={d.buy.cum >= 0 ? "text-buy" : "text-sell"}>{d.buy.n ? fmtR(d.buy.cum) : "—"}</span>
                {"  ·  "}sell <span className={d.sell.cum >= 0 ? "text-buy" : "text-sell"}>{d.sell.n ? fmtR(d.sell.cum) : "—"}</span>
              </div>
            </div>

            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wider text-muted">real account (€)</div>
              {d.start == null ? (
                <p className="font-mono text-xs text-muted">no balance history yet.</p>
              ) : (
                <dl className="grid grid-cols-3 gap-x-4 gap-y-1 font-mono text-xs">
                  <Kv k="start" v={fmt(d.start)} />
                  <Kv k="now" v={fmt(d.cur)} />
                  <Kv k="net" v={`${(d.net ?? 0) >= 0 ? "+" : ""}${fmt(d.net)}`} cls={(d.net ?? 0) > 0 ? "text-buy" : (d.net ?? 0) < 0 ? "text-sell" : "text-muted"} />
                </dl>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Kv({ k, v, cls = "" }: { k: string; v: string; cls?: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-muted">{k}</dt>
      <dd className={`tabular-nums ${cls}`}>{v}</dd>
    </div>
  );
}
