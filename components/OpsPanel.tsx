import type { Execution, Mt5Status } from "@/lib/types";
import { fmt } from "@/lib/format";
import TimeStamp from "./TimeStamp";
import InfoTip from "./InfoTip";

const EXEC_CLASS: Record<Execution["status"], string> = {
  placed: "text-buy",
  closed: "text-foreground",
  breakeven: "text-accent",
  skipped: "text-muted",
  error: "text-sell",
};

// Visibility into the automated pipeline: the MT5 engine heartbeat, Telegram
// ingest, and what the copier executed. Pure presentational.
export default function OpsPanel({
  ea,
  eaAgeS,
  ingest,
  exec,
}: {
  ea: Mt5Status | null;
  eaAgeS: number | null;
  ingest: { lastAt: string | null; last24h: number; total: number };
  exec: { counts: Partial<Record<Execution["status"], number>>; total: number; recent: Execution[] };
}) {
  const dot =
    eaAgeS == null ? "bg-muted" : eaAgeS < 30 ? "bg-buy" : eaAgeS < 120 ? "bg-accent" : "bg-sell";
  const dotLabel =
    eaAgeS == null ? "offline" : eaAgeS < 30 ? "live" : eaAgeS < 120 ? "lagging" : "down";

  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-muted">
        <span>operations</span>
        <InfoTip label="What operations shows">
          The automated pipeline. <span className="text-foreground">engine</span> = the MT5 copier
          heartbeat (it posts its status + broker price every few seconds — a stale dot means it
          stopped). <span className="text-foreground">ingest</span> = signals read from Telegram.{" "}
          <span className="text-foreground">executions</span> = what the copier did (placed /
          skipped / error). The trust score never reads executions.
        </InfoTip>
      </h2>

      <div className="grid gap-3 sm:grid-cols-3">
        {/* engine heartbeat */}
        <div className="border border-border bg-surface p-4">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted">
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
            <span>engine · mt5 {dotLabel}</span>
          </div>
          {ea ? (
            <dl className="mt-3 space-y-2 font-mono text-xs">
              <Row k="heartbeat"><TimeStamp iso={ea.updated_at} /></Row>
              <Row k="price"><span className="tabular-nums">{fmt(ea.bid)}</span></Row>
              <Row k="equity"><span className="tabular-nums">{fmt(ea.equity)} / {fmt(ea.balance)}</span></Row>
              <Row k="open"><span className="tabular-nums">{ea.open_positions ?? 0}</span></Row>
            </dl>
          ) : (
            <p className="mt-3 font-mono text-xs text-muted">no heartbeat yet.</p>
          )}
        </div>

        {/* ingest */}
        <div className="border border-border bg-surface p-4">
          <div className="text-[10px] uppercase tracking-wider text-muted">ingest · telegram</div>
          <dl className="mt-3 space-y-2 font-mono text-xs">
            <Row k="last signal">
              {ingest.lastAt ? <TimeStamp iso={ingest.lastAt} /> : <span className="text-muted">none yet</span>}
            </Row>
            <Row k="last 24h"><span className="tabular-nums">{ingest.last24h}</span></Row>
            <Row k="total"><span className="tabular-nums text-muted">{ingest.total}</span></Row>
          </dl>
        </div>

        {/* executions */}
        <div className="border border-border bg-surface p-4">
          <div className="text-[10px] uppercase tracking-wider text-muted">executions · mt5</div>
          {exec.total === 0 ? (
            <p className="mt-3 font-mono text-xs text-muted">no executions yet.</p>
          ) : (
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs tabular-nums">
              {(["placed", "breakeven", "closed", "skipped", "error"] as const).map((st) =>
                exec.counts[st] ? (
                  <span key={st} className={EXEC_CLASS[st]}>
                    {exec.counts[st]} {st}
                  </span>
                ) : null,
              )}
            </div>
          )}
        </div>
      </div>

      {exec.recent.length > 0 && (
        <ul className="border border-border bg-surface font-mono text-xs">
          {exec.recent.map((e) => (
            <li
              key={e.id}
              className="flex items-center justify-between gap-4 border-b border-border/60 px-4 py-2 last:border-0"
            >
              <span className="flex items-center gap-3">
                <span className="text-muted">#{e.signal_id}</span>
                <span className={EXEC_CLASS[e.status]}>{e.status}</span>
                {e.lots != null && <span className="tabular-nums text-muted">{fmt(e.lots)} lots</span>}
                {e.detail && <span className="text-muted">· {e.detail}</span>}
              </span>
              <TimeStamp iso={e.created_at} className="text-muted" />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-muted">{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}
