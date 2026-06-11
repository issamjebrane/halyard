import InfoTip from "./InfoTip";

const ROWS: { k: string; tone: string; d: string }[] = [
  { k: "activated", tone: "text-accent", d: "a pending order's entry was reached — the trade is now live" },
  { k: "tp1 / tp2 / tp3 hit", tone: "text-buy", d: "price touched take-profit level 1, 2 or 3" },
  { k: "sl hit", tone: "text-sell", d: "price touched the stop loss" },
  { k: "closed", tone: "text-foreground", d: "outcome locked in — win (at TP1) or loss (at SL)" },
  { k: "settled", tone: "text-muted", d: "engine finished observing (it keeps watching a while after close to log later levels)" },
  { k: "extreme", tone: "text-muted", d: "a new furthest point in profit (MFE) or in loss (MAE)" },
];

export default function EngineTapeInfo() {
  return (
    <InfoTip label="What the engine tape shows" width="w-80">
      <span className="mb-2 block text-foreground">
        The engine tape is a time-ordered log of everything the verifier observed
        for the signal.
      </span>
      {ROWS.map((r) => (
        <span key={r.k} className="mt-1 block">
          <span className={`font-mono ${r.tone}`}>{r.k}</span>
          <span> — {r.d}</span>
        </span>
      ))}
      <span className="mt-2 block">
        columns: <span className="font-mono text-foreground">price</span> = the
        level at that moment · <span className="font-mono text-foreground">R</span>{" "}
        = profit/loss in R at that moment. The win/loss result itself is still
        decided only by TP1 vs SL.
      </span>
    </InfoTip>
  );
}
