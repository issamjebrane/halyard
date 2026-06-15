# Halyard → RATCHET: implementation plan

Source docs (in `docs/`): `ESTRATEGIA_SIMON_INGENIERO.md` (engineer spec) and
`Estrategia_Simon_RATCHET.pdf` (validated deck). Both agree on the same thing.

## The one-line takeaway

> The website currently closes every trade **at TP1** — the docs prove that is the
> **worst** possible exit (≈ −2.5R / −12.9% on the 22-trade sample). The validated
> strategy is **RATCHET**: a trailing stop by levels, single position, close 100% at
> TP3. Switching the web to RATCHET is the ~90% fix; the rest is a live MT5 executor.

RATCHET, exactly (from §1 of the spec):

```
ON OPEN: enter at market at the signal price · SL = original stop · target = TP3
  price hits TP1  → move SL to ENTRY  (break-even)
  price hits TP2  → move SL to TP1    (partial profit locked)
  price hits TP3  → close 100%        (win)
  live SL hit     → close
NEVER close partial. Always 100% at TP3 or at the current SL.
MAX_HOLD 72h → close at market if neither TP3 nor SL is hit.
```

Result-if-it-reverses table: just-opened → −1R · after TP1 → 0R · after TP2 → +TP1's R · after TP3 → +TP3's R.

Backtest (22 real Simon trades, 4–14 Jun, candle-by-candle on real gold): RATCHET @5%
= **+24.5%**, ~9.8% backtest drawdown (expect ~2× live). Edge is statistically thin
(t≈1.0) — **promising, not yet conclusive**; needs ~100 trades to confirm.

---

## Where the code is today

- The web's `run_verification` **already tracks** TP1/TP2/TP3 touches, `peak_tp`,
  `mfe_r`/`mae_r`, a `signal_events` tape, and a post-close `settled` window. But the
  **outcome / `result_r` is still "win at TP1 vs SL"** — i.e. the wrong accounting.
- Price source is a ~45s **spot poll** of Binance PAXG (proxy). The docs flag this as
  the cause of the #18/#20/#40 mis-marks (a poll misses fast wicks; the proxy isn't
  XAUUSD).
- New env already staged for the executor: `METAAPI_TOKEN`, `TELEGRAM_*`,
  `RISK_PCT`, `SPLIT`, `MAX_OPEN_TRADES`, `MAX_ENTRY_SLIPPAGE`, `MAX_SIGNAL_AGE_MIN`,
  `DRY_RUN=true`, `POLL_SECONDS=5`.

So Phase 1 is mostly **changing the accounting on infrastructure that already exists.**

---

## Workstream A — Web verifier: switch TP1 → RATCHET  (highest value)

**A1. RATCHET outcome in `run_verification`.** Replace the "close at TP1" result with
the trailing-stop state machine. The level-touch detection is already there; add:
- a stop-state per open signal: `sl_state ∈ {original, entry, tp1}` advancing on
  TP1/TP2 touches;
- close + `result_r` when the **current** stop is hit (−1R / 0R / +TP1·R) or TP3 is
  hit (+TP3·R); `MAX_HOLD` 72h → close at market with mark-to-market R.
- This makes the Trust Score, equity curve and tape reflect the real strategy with
  **zero changes** to `lib/metrics.ts` (it reads `result_r`/`status` only).

**A2. Evaluate on 1-minute OHLC, not a 45s snapshot.** Touch tests should use each
1-min candle's **high/low** (we already proxy klines via `/api/klines`). This removes
the wick-miss ambiguity. Decision below on PAXG vs real-XAU source.

**A3. (optional) Reprocess #2–#9** with the new logic for a homogeneous history
(those early rows pre-date the tracking upgrade).

**A4. Signal hygiene at post time:** reject a signal whose stop is tighter than
~2–3 $ (below gold noise — the #20 case). Add to `post_signal` validation.

---

## Workstream B — Telegram ingest (feeds both the web and the executor)

**B1.** One-time `scripts/telegram-login.mjs` (interactive) → `TELEGRAM_SESSION`.
**B2.** Reader for the `Gold VIP signal` channel (`telegram` lib, read-only): parse
messages into `{direction, entry, sl, tp1, tp2, tp3, posted_at}`; dedupe; drop
anything older than `MAX_SIGNAL_AGE_MIN`. Robust parser + a quarantine for messages it
can't parse (never guess a level).
**B3.** Write normalized signals into the existing `signals` table (source tag
`telegram:gold_vip`) so they flow through the same verifier/UI.

---

## Workstream C — Live executor (MetaApi / MT5), `DRY_RUN` first

**C1. Sizing:** lot so that the **original SL = `RISK_PCT` × current equity**
(compound, on live balance). Default **2%** to start; 4–5% is the validated optimum
(quarter-Kelly) — **never raise toward Kelly.**
**C2. Open + manage (RATCHET):** market entry, place original SL, target TP3; then the
same trailing-stop loop as A1 but issuing real `modify SL` / `close` orders via MetaApi.
`MAX_ENTRY_SLIPPAGE` guard on entry; `MAX_HOLD` 72h.
**C3. Exposure & safety:** `MAX_OPEN_TRADES`, and a **total-open-risk cap (~8%)** so
overlapping same-direction trades can't stack to 20%. A hard kill-switch + `DRY_RUN`
that logs intended orders without sending them.
**C4. Reconcile:** write real fills/exits back so the web's track record = what
actually executed (not just the proxy verification).

> ⚠️ **Config conflict to resolve:** the staged env has `SPLIT=3`. The strategy is
> emphatic (§9.1, §9.4): **no scale-out / no partial closes** — pure RATCHET, single
> position, 100% at TP3. Recommend dropping `SPLIT` (or fixing it to 1). Partials only
> ever trim winners here, because all 8 losers go straight to SL.

---

## Phasing

1. **Phase 1 — Web correctness (A1+A2).** Switch accounting to RATCHET on OHLC. This
   alone moves the measured record from "worst strategy" to the validated one. ~Self-contained.
2. **Phase 2 — Ingest (B).** Telegram → normalized signals in the DB.
3. **Phase 3 — Executor in `DRY_RUN` (C, no orders).** Paper-trade; assert the
   executor's intended actions match the web's RATCHET marks trade-for-trade.
4. **Phase 4 — Go live small.** MT5 **demo** or 2% risk, exposure caps on, reconcile.
5. **Phase 5 — Data & iterate.** Collect toward ~100 trades **before** raising risk or
   trying the post-TP3 runner. No other "optimizations".

---

## Decisions I need from you

1. **OHLC source for the web verifier:** keep **Binance PAXG** 1-min (free, already
   wired, ±$2–4 proxy error on tight stops) or pull **real XAUUSD** 1-min from MetaApi
   (matches the executor, more accurate, needs the MetaApi account live)? *Rec: PAXG now
   for Phase 1, switch the web to MetaApi XAUUSD once the executor account exists.*
2. **Reprocess history #2–#9?** (cosmetic, homogeneous record) — yes/skip.
3. **Executor go-live posture:** build it straight to a **demo** MT5 account, or
   `DRY_RUN` against live data only until Phase 1 is validated? *Rec: DRY_RUN → demo.*
4. **`SPLIT=3`:** confirm we drop scale-out and implement pure RATCHET (per the docs).

## Explicit non-goals (the docs verified these as overfitting — do NOT build)

Buy-only filter · filtering by planned R:R · skipping tight-stop trades · pausing after
2 losses · Kelly/RR/martingale sizing · any partial-close/scale-out. Risk is a **dial**
(fixed 4–5%), not a parameter to optimize.

## Standing risks

Small sample (22 trades, not conclusive) · live drawdown ~2× backtest → size for
15–20% · PAXG ≠ real gold on fine triggers · **live credentials (MetaApi token, Binance
secret) now sit in `.env.local`** — rotate them and keep `DRY_RUN=true` until the
executor is validated end-to-end.
