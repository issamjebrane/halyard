import type { AccountBalancePoint } from "@/lib/types";
import { fmt } from "@/lib/format";
import InfoTip from "./InfoTip";

// The REAL account(s): each copier's actual broker balance over time (realized
// P&L) — distinct from the signal track record's theoretical R. One point per
// closed trade (a DB trigger snapshots balance whenever the heartbeat changes).
// Grouped per account so the two demo accounts (telegram vs simon) stay separate.
export default function AccountCurve({
  points,
  labels = {},
}: {
  points: AccountBalancePoint[];
  labels?: Record<string, string>;
}) {
  if (points.length === 0) {
    return (
      <section className="space-y-3">
        <Heading />
        <p className="text-sm text-muted">no account history yet — populates as the EA closes trades.</p>
      </section>
    );
  }

  const groups = new Map<string, AccountBalancePoint[]>();
  for (const p of points) {
    const k = p.account ?? "—";
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(p);
  }
  const entries = [...groups.entries()];

  return (
    <section className="space-y-3">
      <Heading />
      <div className={`grid gap-3 ${entries.length > 1 ? "lg:grid-cols-2" : ""}`}>
        {entries.map(([acct, pts]) => (
          <Curve key={acct} account={acct} label={labels[acct]} pts={pts} />
        ))}
      </div>
    </section>
  );
}

function Curve({ account, label, pts }: { account: string; label?: string; pts: AccountBalancePoint[] }) {
  const bal = (p: AccountBalancePoint) => p.balance ?? 0;
  const start = bal(pts[0]);
  const last = pts[pts.length - 1];
  const current = bal(last);
  const equity = last.equity ?? current;
  const net = current - start;
  const pct = start ? (net / start) * 100 : 0;
  const netCls = net > 0 ? "text-buy" : net < 0 ? "text-sell" : "text-muted";

  const vals = pts.map(bal);
  const n = vals.length;
  const w = 640, h = 120, pad = 16;
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
  const x = (i: number) => pad + (w - 2 * pad) * (n > 1 ? i / (n - 1) : 0);
  const y = (v: number) => h - pad - (h - 2 * pad) * ((v - lo) / (hi - lo));
  const path = vals.map((v, i) => (i === 0 ? "M" : "L") + `${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const startY = y(start).toFixed(1);

  return (
    <div className="border border-border bg-surface p-3">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-6 gap-y-1 font-mono text-xs">
        <span className="text-[10px] uppercase tracking-wider text-foreground">
          {label || "account"} <span className="text-muted">#{account}</span>
        </span>
        <Stat k="balance" v={fmt(current)} />
        <Stat k="equity" v={fmt(equity)} />
        <Stat k="net" v={`${net >= 0 ? "+" : ""}${fmt(net)} (${net >= 0 ? "+" : ""}${pct.toFixed(1)}%)`} cls={netCls} />
        <Stat k="from" v={fmt(start)} cls="text-muted" />
      </div>
      {n > 1 ? (
        <svg viewBox={`0 0 ${w} ${h}`} className="w-full" preserveAspectRatio="none">
          <line x1={pad} y1={startY} x2={w - pad} y2={startY} className="stroke-border" strokeWidth="1" strokeDasharray="3 3" />
          <path d={path} fill="none" className={net >= 0 ? "stroke-buy" : "stroke-sell"} strokeWidth="1.5" />
        </svg>
      ) : (
        <p className="font-mono text-[10px] text-muted">one snapshot so far — the curve draws once the balance changes.</p>
      )}
    </div>
  );
}

function Heading() {
  return (
    <h2 className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-muted">
      <span>real account (mt5)</span>
      <InfoTip label="What the real account shows" width="w-80">
        <span className="mb-2 block text-foreground">Each copier&apos;s ACTUAL broker balance over time — real realized profit/loss on the demo account(s).</span>
        This is different from the <span className="font-mono text-foreground">equity (R)</span> curve above, which is the
        signal&apos;s <span className="text-foreground">theoretical</span> result graded on the gold price feed. The two can
        diverge (different price feed, slippage), so use THIS one to judge how each copier is really doing. The dashed line
        is its starting balance.
      </InfoTip>
    </h2>
  );
}

function Stat({ k, v, cls = "" }: { k: string; v: string; cls?: string }) {
  return (
    <span>
      <span className="text-[10px] uppercase tracking-wider text-muted">{k} </span>
      <span className={`tabular-nums ${cls}`}>{v}</span>
    </span>
  );
}
