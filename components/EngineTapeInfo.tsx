// A small "i" info icon. On hover (or keyboard focus) it shows a short
// explanation of the engine tape and what each event row means. Pure CSS —
// safe to render inside a server component and inside an <h2> (spans only).

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
    <span className="group relative inline-flex normal-case tracking-normal">
      <span
        tabIndex={0}
        role="img"
        aria-label="What the engine tape shows"
        data-tip="engine-tape"
        className="flex h-4 w-4 cursor-help select-none items-center justify-center rounded-full border border-border text-[10px] font-medium text-muted hover:border-foreground hover:text-foreground focus:text-foreground focus:outline-none"
      >
        i
      </span>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-0 top-6 z-30 hidden w-80 max-w-[80vw] border border-border bg-background p-3 text-left text-[11px] font-normal leading-relaxed text-muted shadow-lg group-hover:block group-focus-within:block"
      >
        <span className="mb-2 block text-foreground">
          The engine tape is a time-ordered log of everything the verifier
          observed for the signal.
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
      </span>
    </span>
  );
}
