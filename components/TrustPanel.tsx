import type { Trust } from "@/lib/metrics";
import { fmt, fmtR } from "@/lib/format";
import InfoTip from "./InfoTip";

const VERDICT_LABEL: Record<Trust["verdict"], string> = {
  insufficient: "insufficient data",
  solid: "solid",
  promising: "promising",
  weak: "questionable",
  poor: "not reliable",
};

const FLAG_LABEL: Record<string, string> = {
  winrate_suspicious: "win rate >90% — suspiciously high, score capped",
  small_sample: "fewer than 30 trades — treat as provisional",
};

export default function TrustPanel({ trust }: { trust: Trust }) {
  return (
    <div className="border border-border bg-surface p-5">
      <div className="flex items-baseline justify-between">
        <span className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted">
          reliability verdict
          <InfoTip label="How the reliability verdict works" width="w-80">
            <span className="mb-2 block text-foreground">
              A 0–100 score from the trader&apos;s closed trades.
            </span>
            <span className="mt-1 block"><span className="font-mono text-foreground">win rate</span> — % of closed trades that hit TP1</span>
            <span className="mt-1 block"><span className="font-mono text-foreground">profit factor</span> — gross profit ÷ gross loss (&gt;1 is profitable)</span>
            <span className="mt-1 block"><span className="font-mono text-foreground">expectancy</span> — average result per trade, in R</span>
            <span className="mt-1 block"><span className="font-mono text-foreground">max drawdown</span> — largest peak-to-valley drop, in R</span>
            <span className="mt-1 block"><span className="font-mono text-foreground">payoff</span> — average win ÷ average loss</span>
            <span className="mt-1 block"><span className="font-mono text-foreground">max consec. losses</span> — longest losing streak</span>
            <span className="mt-2 block">
              bands: ≥70 solid · ≥50 promising · ≥30 questionable · &lt;30 not
              reliable · &lt;10 trades = insufficient. A win rate over 90% caps the
              score (suspicious); under 30 trades is provisional.
            </span>
          </InfoTip>
        </span>
        <span className="font-mono text-sm text-accent">
          {VERDICT_LABEL[trust.verdict]}
        </span>
      </div>

      <div className="mt-3 flex items-baseline gap-3">
        <span className="font-mono text-4xl tabular-nums">
          {trust.score ?? "—"}
        </span>
        <span className="text-xs text-muted">/ 100 · {trust.n} closed</span>
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-2 font-mono text-sm sm:grid-cols-3">
        <Stat k="win rate" v={`${trust.win_rate.toFixed(1)}%`} />
        <Stat k="profit factor" v={trust.profit_factor} />
        <Stat k="expectancy" v={fmtR(trust.expectancy)} />
        <Stat k="max drawdown" v={`${fmt(trust.max_dd)}R`} />
        <Stat k="payoff" v={trust.payoff_inf ? "∞" : fmt(trust.payoff)} />
        <Stat k="max consec. losses" v={String(trust.max_consec_losses)} />
      </dl>

      {trust.flags.length > 0 && (
        <ul className="mt-4 space-y-1">
          {trust.flags.map((f) => (
            <li key={f} className="text-xs text-sell">
              ⚠ {FLAG_LABEL[f] ?? f}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-muted">{k}</dt>
      <dd className="tabular-nums">{v}</dd>
    </div>
  );
}
