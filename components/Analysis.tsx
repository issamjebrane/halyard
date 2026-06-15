import type { Signal } from "@/lib/types";
import { fmt, fmtR } from "@/lib/format";
import InfoTip from "./InfoTip";

const EPS = 0.01;
const closedOf = (s: Signal) =>
  (s.status === "won" || s.status === "lost" || s.status === "breakeven") && s.result_r != null;

// Strategy-aware analytics. The RATCHET thesis is about capturing more of each
// move while cutting losers to break-even — so the headline lenses are the
// outcome mix, how far price actually ran (peak target), and how much of the
// favorable excursion (MFE) was actually captured.
export default function Analysis({ signals }: { signals: Signal[] }) {
  const closed = signals.filter(closedOf);
  if (closed.length === 0) {
    return (
      <section className="space-y-3">
        <Heading />
        <p className="text-sm text-muted">no closed trades yet — analytics populate as signals resolve.</p>
      </section>
    );
  }

  const r = (s: Signal) => s.result_r ?? 0;
  const wins = closed.filter((s) => r(s) > EPS);
  const bes = closed.filter((s) => Math.abs(r(s)) <= EPS);
  const losses = closed.filter((s) => r(s) < -EPS);

  // how far price ran, over everything the engine actually tracked
  const activated = signals.filter((s) => s.activated_at != null);
  const peak = [0, 1, 2, 3].map((k) => activated.filter((s) => (s.peak_tp ?? 0) === k).length);
  const peakMax = Math.max(1, ...peak);

  // capture efficiency from MFE / MAE
  const wm = closed.filter((s) => s.mfe_r != null);
  const avgMfe = wm.length ? wm.reduce((a, s) => a + (s.mfe_r ?? 0), 0) / wm.length : 0;
  const avgMae = wm.length ? wm.reduce((a, s) => a + (s.mae_r ?? 0), 0) / wm.length : 0;
  const avgRes = closed.reduce((a, s) => a + r(s), 0) / closed.length;
  const capture = avgMfe > EPS ? (avgRes / avgMfe) * 100 : null;

  // by direction
  const byDir = (d: "buy" | "sell") => {
    const sub = closed.filter((s) => s.direction === d);
    const w = sub.filter((s) => r(s) > EPS).length;
    const cum = sub.reduce((a, s) => a + r(s), 0);
    return { n: sub.length, win: sub.length ? (w / sub.length) * 100 : 0, cum, exp: sub.length ? cum / sub.length : 0 };
  };
  const buy = byDir("buy"), sell = byDir("sell");

  // hold time
  const hrs = (s: Signal) =>
    s.activated_at && s.closed_at
      ? (new Date(s.closed_at).getTime() - new Date(s.activated_at).getTime()) / 3_600_000
      : null;
  const avgH = (arr: Signal[]) => {
    const v = arr.map(hrs).filter((x): x is number => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const holdWin = avgH(wins), holdLoss = avgH(losses);
  const n = closed.length;

  return (
    <section className="space-y-3">
      <Heading />
      <div className="grid gap-3 lg:grid-cols-2">
        {/* outcome mix */}
        <Panel title="outcome mix">
          <Bar segs={[
            { n: wins.length, cls: "bg-buy" },
            { n: bes.length, cls: "bg-accent" },
            { n: losses.length, cls: "bg-sell" },
          ]} />
          <Legend rows={[
            ["wins", wins.length, "text-buy"],
            ["break-even", bes.length, "text-accent"],
            ["losses", losses.length, "text-sell"],
          ]} total={n} />
        </Panel>

        {/* how far price ran */}
        <Panel title="how far price ran (peak target)">
          <ul className="space-y-1.5 font-mono text-xs">
            {[
              ["none", peak[0], "text-muted"],
              ["tp1", peak[1], "text-foreground"],
              ["tp2", peak[2], "text-foreground"],
              ["tp3", peak[3], "text-buy"],
            ].map(([label, v, cls]) => (
              <li key={label as string} className="flex items-center gap-2">
                <span className={`w-9 ${cls as string}`}>{label}</span>
                <span className="h-2 bg-border" style={{ width: `${((v as number) / peakMax) * 70}%` }} />
                <span className="tabular-nums text-muted">{v as number}</span>
              </li>
            ))}
          </ul>
        </Panel>

        {/* capture efficiency */}
        <Panel title="capture (MFE / MAE)">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 font-mono text-xs">
            <Kv k="avg favorable (MFE)" v={fmtR(avgMfe)} cls="text-buy" />
            <Kv k="avg captured" v={fmtR(avgRes)} cls={avgRes >= 0 ? "text-buy" : "text-sell"} />
            <Kv k="capture rate" v={capture == null ? "—" : `${capture.toFixed(0)}%`} />
            <Kv k="avg adverse (MAE)" v={fmtR(avgMae)} cls="text-sell" />
          </dl>
          <p className="mt-2 text-[10px] text-muted">how much of the average favorable move RATCHET kept.</p>
        </Panel>

        {/* by direction */}
        <Panel title="by direction">
          <table className="w-full border-collapse font-mono text-xs">
            <thead>
              <tr className="text-left text-muted">
                <th className="py-1 font-normal">dir</th>
                <th className="py-1 font-normal">n</th>
                <th className="py-1 font-normal">win%</th>
                <th className="py-1 font-normal">cum R</th>
                <th className="py-1 font-normal">exp</th>
              </tr>
            </thead>
            <tbody>
              {([["buy", buy], ["sell", sell]] as const).map(([d, m]) => (
                <tr key={d}>
                  <td className={`py-1 ${d === "buy" ? "text-buy" : "text-sell"}`}>{d}</td>
                  <td className="py-1 tabular-nums">{m.n}</td>
                  <td className="py-1 tabular-nums">{m.n ? `${m.win.toFixed(0)}%` : "—"}</td>
                  <td className={`py-1 tabular-nums ${m.cum > 0 ? "text-buy" : m.cum < 0 ? "text-sell" : "text-muted"}`}>{m.n ? fmtR(m.cum) : "—"}</td>
                  <td className="py-1 tabular-nums text-muted">{m.n ? fmtR(m.exp) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>

      <p className="font-mono text-[11px] text-muted">
        avg hold — wins {holdWin == null ? "—" : `${fmt(holdWin, 1)}h`} · losses{" "}
        {holdLoss == null ? "—" : `${fmt(holdLoss, 1)}h`}
      </p>
    </section>
  );
}

function Heading() {
  return (
    <h2 className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-muted">
      <span>analysis</span>
      <InfoTip label="What analysis shows" width="w-80">
        <span className="mb-2 block text-foreground">Strategy-level lenses over closed trades.</span>
        <span className="mt-1 block"><span className="font-mono text-foreground">outcome mix</span> — wins / break-even / losses</span>
        <span className="mt-1 block"><span className="font-mono text-foreground">peak target</span> — the furthest TP price reached on each trade</span>
        <span className="mt-1 block"><span className="font-mono text-foreground">capture</span> — average captured R vs the average max-favorable move (MFE); RATCHET aims to keep more of it</span>
        <span className="mt-1 block"><span className="font-mono text-foreground">by direction</span> — buy vs sell performance</span>
      </InfoTip>
    </h2>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3 border border-border bg-surface p-4">
      <div className="text-[10px] uppercase tracking-wider text-muted">{title}</div>
      {children}
    </div>
  );
}

function Bar({ segs }: { segs: { n: number; cls: string }[] }) {
  const total = Math.max(1, segs.reduce((a, s) => a + s.n, 0));
  return (
    <div className="flex h-2 w-full overflow-hidden border border-border">
      {segs.map((s, i) => (
        <span key={i} className={s.cls} style={{ width: `${(s.n / total) * 100}%` }} />
      ))}
    </div>
  );
}

function Legend({ rows, total }: { rows: [string, number, string][]; total: number }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs">
      {rows.map(([label, v, cls]) => (
        <li key={label} className={cls}>
          {v} {label}
          <span className="ml-1 text-muted">({total ? Math.round((v / total) * 100) : 0}%)</span>
        </li>
      ))}
    </ul>
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
