import InfoTip from "./InfoTip";

const ROWS: { k: string; d: string }[] = [
  { k: "dir / type", d: "buy or sell · market (entry pinned to the live price) or pending (waits for the entry to be reached)" },
  { k: "entry / sl", d: "entry price and stop loss" },
  { k: "tp1 / tp2 / tp3", d: "take-profit targets; ✓ marks one the engine saw price touch (tp1 decides the win)" },
  { k: "status", d: "pending / open / won / lost · “tpN” = highest target reached" },
  { k: "R / pips", d: "result in risk multiples and in pips ($0.10 each)" },
  { k: "mfe / mae", d: "max favorable / adverse excursion in R — the best and worst the trade ran" },
  { k: "time", d: "when the trader posted the signal" },
  { k: "· excluded", d: "greyed-out, faded rows. Kept on the record for honesty but NOT counted in the score, equity or analysis — these are backfilled (old) signals, not real forward trades" },
];

export default function SignalsTableInfo() {
  return (
    <InfoTip label="What the signal columns mean" width="w-80">
      <span className="mb-2 block text-foreground">Each row is one posted signal.</span>
      {ROWS.map((r) => (
        <span key={r.k} className="mt-1 block">
          <span className="font-mono text-foreground">{r.k}</span>
          <span> — {r.d}</span>
        </span>
      ))}
    </InfoTip>
  );
}
