"use client";

// Visual layer for the deep analysis. Every number here comes from the
// deterministic deepStats the API returns (never the model) — the AI only writes
// the narrative shown beneath. Colour encodes meaning within the house palette:
// buy = captured/good, accent (gold) = left on the table, sell = missed/lost.

type Dir = { direction: string; n: number; win_rate: number; cum_r: number; expectancy: number };
type Engine = {
  name: string;
  label: string;
  status: string;
  counts: { closed: number };
  theoretical: { cum_r: number; win_rate: number; profit_factor: string; max_drawdown_r: number; verdict: string };
  real_eur: { net_eur: number | null; traded: number; current_balance: number | null; avg_entry_slippage: number | null };
  missed: {
    missed_theoretical_r: number;
    capture: { capture_rate_pct: number | null; total_left_on_table_r: number; avg_favorable_mfe_r: number; avg_captured_r: number };
    tp_giveback: { count: number };
  };
  by_direction: Dir[];
};
export type Stats = {
  totals: { closed: number };
  overall: { cum_r: number; win_rate: number; verdict: string; score: number | null };
  reconciliation: { realized_eur_total: number };
  engines: Engine[];
};

const fr = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}R`;
const fe = (n: number | null) => (n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}`);
const tone = (n: number) => (n > 0.001 ? "text-buy" : n < -0.001 ? "text-sell" : "text-muted");
const dot = (s: string) => (s === "live" ? "bg-buy" : s === "lagging" ? "bg-accent" : s === "down" ? "bg-sell" : "bg-muted");

export default function DeepView({ stats }: { stats: Stats }) {
  const totalLeak = stats.engines.reduce((a, e) => a + e.missed.capture.total_left_on_table_r + Math.max(0, e.missed.missed_theoretical_r), 0);
  const realNet = stats.engines.reduce((a, e) => a + (e.real_eur.net_eur ?? 0), 0);

  return (
    <div className="space-y-5">
      {/* headline strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi k="track record" v={fr(stats.overall.cum_r)} cls={tone(stats.overall.cum_r)} sub={`${stats.totals.closed} closed · ${stats.overall.verdict}`} />
        <Kpi k="real € net" v={fe(realNet)} cls={tone(realNet)} sub="broker balance truth" />
        <Kpi k="left + missed" v={`${totalLeak.toFixed(1)}R`} cls="text-accent" sub="uncaptured rentability" />
        <Kpi k="reliability" v={stats.overall.score == null ? "—" : String(stats.overall.score)} sub="/ 100" />
      </div>

      {/* per-engine scorecards */}
      <div className="grid gap-3 sm:grid-cols-2">
        {stats.engines.map((e) => (
          <EngineCard key={e.name} e={e} />
        ))}
      </div>

      {/* where they missed — the signature chart */}
      <div className="space-y-3">
        <div className="text-[10px] uppercase tracking-wider text-muted">where they missed · captured vs left vs never taken (R)</div>
        <div className="grid gap-3 sm:grid-cols-2">
          {stats.engines.map((e) => (
            <MissedBar key={e.name} e={e} />
          ))}
        </div>
        <Legend />
      </div>

      {/* by direction */}
      <div className="space-y-3">
        <div className="text-[10px] uppercase tracking-wider text-muted">by direction · cumulative R</div>
        <div className="grid gap-3 sm:grid-cols-2">
          {stats.engines.map((e) => (
            <DirChart key={e.name} e={e} />
          ))}
        </div>
      </div>
    </div>
  );
}

function Kpi({ k, v, sub, cls = "" }: { k: string; v: string; sub?: string; cls?: string }) {
  return (
    <div className="border border-border bg-surface px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-muted">{k}</div>
      <div className={`mt-1 font-mono text-lg tabular-nums ${cls}`}>{v}</div>
      {sub && <div className="mt-0.5 text-[10px] text-muted">{sub}</div>}
    </div>
  );
}

function EngineCard({ e }: { e: Engine }) {
  const cap = e.missed.capture.capture_rate_pct;
  return (
    <div className="space-y-3 border border-border bg-surface p-4">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot(e.status)}`} />
        <span className="text-foreground">{e.label}</span>
        <span>· {e.theoretical.verdict}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs">
        <Kv k="paper (R)" v={fr(e.theoretical.cum_r)} cls={tone(e.theoretical.cum_r)} />
        <Kv k="real € net" v={fe(e.real_eur.net_eur)} cls={tone(e.real_eur.net_eur ?? 0)} />
        <Kv k="win rate" v={`${e.theoretical.win_rate.toFixed(0)}%`} />
        <Kv k="traded" v={`${e.real_eur.traded} / ${e.counts.closed}`} cls={e.real_eur.traded === 0 ? "text-sell" : ""} />
      </div>
      {/* capture gauge */}
      <div>
        <div className="mb-1 flex justify-between text-[10px] uppercase tracking-wider text-muted">
          <span>capture of favorable move</span>
          <span className={`tabular-nums ${cap != null && cap < 0 ? "text-sell" : "text-foreground"}`}>{cap == null ? "—" : `${cap.toFixed(0)}%`}</span>
        </div>
        <div className="h-2 w-full bg-background">
          <div className={cap != null && cap < 0 ? "h-2 bg-sell" : "h-2 bg-buy"} style={{ width: `${Math.min(100, Math.abs(cap ?? 0))}%` }} />
        </div>
      </div>
    </div>
  );
}

function MissedBar({ e }: { e: Engine }) {
  const captured = Math.max(0, e.theoretical.cum_r);
  const left = Math.max(0, e.missed.capture.total_left_on_table_r);
  const missed = Math.max(0, e.missed.missed_theoretical_r);
  const total = captured + left + missed || 1;
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <div className="border border-border bg-surface p-4">
      <div className="mb-2 text-[10px] uppercase tracking-wider text-foreground">{e.label}</div>
      <div className="flex h-3 w-full overflow-hidden border border-border">
        <span className="bg-buy" style={{ width: pct(captured) }} title={`captured ${fr(e.theoretical.cum_r)}`} />
        <span className="bg-accent" style={{ width: pct(left) }} title={`left on table ${left.toFixed(2)}R`} />
        <span className="bg-sell" style={{ width: pct(missed) }} title={`missed entries ${missed.toFixed(2)}R`} />
      </div>
      <dl className="mt-2 grid grid-cols-3 gap-2 font-mono text-[11px]">
        <Seg k="captured" v={fr(e.theoretical.cum_r)} cls="text-buy" />
        <Seg k="left on table" v={`${left.toFixed(2)}R`} cls="text-accent" />
        <Seg k="never taken" v={`${missed.toFixed(2)}R`} cls="text-sell" />
      </dl>
      <p className="mt-2 text-[10px] text-muted">
        kept {total > 0 ? ((captured / total) * 100).toFixed(0) : 0}% of {total.toFixed(1)}R available
      </p>
    </div>
  );
}

function DirChart({ e }: { e: Engine }) {
  const max = Math.max(1, ...e.by_direction.map((d) => Math.abs(d.cum_r)));
  return (
    <div className="border border-border bg-surface p-4">
      <div className="mb-3 text-[10px] uppercase tracking-wider text-foreground">{e.label}</div>
      <ul className="space-y-2 font-mono text-xs">
        {e.by_direction.map((d) => (
          <li key={d.direction} className="flex items-center gap-2">
            <span className={`w-8 ${d.direction === "buy" ? "text-buy" : "text-sell"}`}>{d.direction}</span>
            <span className="flex h-2 flex-1 items-center bg-background">
              <span className={d.cum_r >= 0 ? "h-2 bg-buy" : "h-2 bg-sell"} style={{ width: `${(Math.abs(d.cum_r) / max) * 100}%` }} />
            </span>
            <span className={`w-14 text-right tabular-nums ${tone(d.cum_r)}`}>{d.n ? fr(d.cum_r) : "—"}</span>
            <span className="w-10 text-right tabular-nums text-muted">{d.n ? `${d.win_rate.toFixed(0)}%` : ""}</span>
          </li>
        ))}
      </ul>
    </div>
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
function Seg({ k, v, cls }: { k: string; v: string; cls: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-muted">{k}</dt>
      <dd className={`tabular-nums ${cls}`}>{v}</dd>
    </div>
  );
}
function Legend() {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-muted">
      <li className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 bg-buy" /> captured</li>
      <li className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 bg-accent" /> left on the table (exits)</li>
      <li className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 bg-sell" /> never taken (skipped/errored)</li>
    </ul>
  );
}
