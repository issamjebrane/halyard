// TEMPORARY verification route for the AdminTabs shell — delete after review.
// /admin is auth-gated, so this renders the tab wrapper with placeholder slots
// to verify the tab bar, switching, sticky behavior, and mobile scroll.
import AdminTabs from "@/components/AdminTabs";

export const dynamic = "force-dynamic";

function Card({ title, lines }: { title: string; lines: number }) {
  return (
    <section className="space-y-3">
      <h2 className="font-mono text-xs uppercase tracking-wider text-muted">{title}</h2>
      <div className="space-y-2 border border-border bg-surface p-4 font-mono text-xs">
        {Array.from({ length: lines }).map((_, i) => (
          <div key={i} className="flex justify-between border-b border-border/60 pb-2 last:border-0">
            <span className="text-muted">row {i + 1}</span>
            <span className="tabular-nums">{(i * 1.37).toFixed(2)}R</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function TabPreview() {
  return (
    <div className="space-y-6">
      <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-muted">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-buy animate-pulse" />
        live · this dashboard updates on its own — no need to reload
      </p>
      <AdminTabs
        overview={
          <>
            <div className="border border-border bg-surface p-5">
              <div className="text-xs uppercase tracking-wider text-muted">reliability verdict</div>
              <div className="mt-3 font-mono text-4xl tabular-nums">82</div>
              <div className="text-xs text-muted">/ 100 · 140 closed</div>
            </div>
            <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {["closed", "open", "pending", "cumulative", "last 24h", "win rate"].map((k, i) => (
                <div key={k} className="border border-border bg-surface px-4 py-3">
                  <div className="text-[10px] uppercase tracking-wider text-muted">{k}</div>
                  <div className="mt-1 font-mono text-lg tabular-nums">{[140, 3, 1, "+48.2R", 6, "71%"][i]}</div>
                </div>
              ))}
            </section>
          </>
        }
        engines={<Card title="engines — telegram vs simon" lines={4} />}
        curves={
          <>
            <Card title="equity (R)" lines={3} />
            <Card title="real account (mt5)" lines={3} />
          </>
        }
        analysis={<Card title="analysis" lines={6} />}
        ops={
          <>
            <Card title="operations" lines={3} />
            <Card title="alerts" lines={4} />
            <Card title="engine activity" lines={5} />
          </>
        }
        ledger={
          <>
            <Card title="reconciliation · signal vs broker" lines={5} />
            <Card title="by source" lines={3} />
            <Card title="all signals" lines={12} />
          </>
        }
      />
    </div>
  );
}
