# Executor + Ingester — RATCHET compliance review

Adversarial multi-agent review (36 agents, 20 confirmed findings) of
scripts/metaapi-executor.mjs + telegram-ingest.mjs against the RATCHET spec.

The `.env.local` is gitignored (`.env*`), so no secret-leak via the executor source. The "secret-leak" item in the report request has no corresponding finding — I'll note it's not present. All other claims are verified. The unique index makes the `claim()` dedup work, but the executor's `claim()` swallows errors in a try/catch around an async insert that won't actually throw (it returns an error object), which is a real correctness issue worth flagging. Let me confirm that.

The `sb.from().insert()` returns a result object with `.error` rather than throwing — so the `try/catch` in `claim()` (lines 101-108) never catches a unique violation; it always returns `true`. That's a latent double-place bug. I have enough to write the report.

---

# Halyard Executor + Ingester — RATCHET Compliance Review

## 1) Verdict

**The executor does NOT implement pure RATCHET, and it is unsafe to promote to LIVE as written — but DRY_RUN is genuinely safe to *run* today** because `DRY_RUN` defaults to `true` (`metaapi-executor.mjs:47`) and the place/manage paths are gated behind it (lines 149-152, 142, 154). The core defect is architectural: every signal is split into up to 3 separate broker positions, each carrying its own TP (`SPLIT=3` default, lines 43, 123, 146, 161-167), so the position scales out at TP1/TP2/TP3 — the exact behavior the spec forbids ("NUNCA cerrar parcial… Siempre 100% en TP3 o en el SL vigente", §1 L32; "NO añadir cierres parciales (scale-out)", §9.1 L274; `PARTIAL_CLOSE=false`, §3 L74). The RATCHET ladder is also only half-built: `manage()` (lines 186-210) moves surviving legs to break-even after the first leg closes and never performs the TP2→SL-to-TP1 rung, never reads the authoritative `peak_tp` from `signals`, and has no 72h MAX_HOLD close and no aggregate-risk cap. On 22 trades the spec estimates this scale-out alone costs ~90% of the edge (§7.1 L199). **No secret leak exists** — `.env.local` is gitignored (`.gitignore` matches `.env*`) and no credential is hardcoded in either script; that item from the brief has no corresponding finding and is a non-issue. Net: keep it in DRY_RUN until the single-position rewrite lands; do not flip `DRY_RUN=false`.

## 2) CRITICAL — must fix before any LIVE run

**C1. Kill the scale-out / SPLIT mechanism — single position only.** `metaapi-executor.mjs:43, 86-96, 123, 146, 159-171`. This is the same defect reported four times (ratchet-exit, risk-sizing, exposure-safety, idempotency dimensions); all confirmed real, high confidence. Exact change:
- Line 43: delete the `SPLIT` const (or hardwire `const SPLIT = 1;`). Remove `SPLIT` from the env doc comment (L15) and `.env.local`.
- Line 123: `const tps = [sig.tp1, sig.tp2, sig.tp3].filter((t) => t != null).map(Number);` (drop `.slice(0, SPLIT)`).
- Delete `splitVolumes()` (lines 86-96) and the `legs` computation (line 146).
- Lines 159-171: replace the per-leg loop with a single order using the *highest* provided TP — matches the validator's `final_tp = coalesce(tp3,tp2,tp1)`:
  ```js
  const finalTP = tps[tps.length - 1];
  const place = side === "buy" ? conn.createMarketBuyOrder.bind(conn) : conn.createMarketSellOrder.bind(conn);
  const tickets = [];
  try {
    const res = await place(SYMBOL, lotsTotal, sl, finalTP, { comment: `hal${sid}` });
    const id = res.positionId || res.orderId;
    if (id) tickets.push(String(id));
  } catch (e) { log(`#${sid} place FAILED: ${e?.message ?? e}`); }
  ```
- Update the header comment (L5-8) which still advertises "up to 3 market orders carrying TP1/TP2/TP3".

**C2. Latent double-place: `claim()` dedup never triggers.** `metaapi-executor.mjs:101-108`. `sb.from("executions").insert(...)` resolves to a result object carrying `.error` on a unique violation — it does **not** throw — so the `try/catch` never catches, and `claim()` always returns `true`. The "already claimed → skip" guard (lines 154-157) is therefore dead. Two processes (or a restart mid-loop) can both place the same signal. Fix:
```js
const { error } = await sb.from("executions").insert({ signal_id: signalId, account, status, tickets: [], ...extra });
return !error; // 23505 unique violation -> false (already claimed)
```
(The `executions_signal_key` unique index already exists in `20260611090000_executions.sql`, so the constraint side is correct — only the JS error handling is broken.)

## 3) HIGH

**H1. RATCHET ladder is missing the TP2→SL-to-TP1 rung (and authoritative `peak_tp`).** `metaapi-executor.mjs:186-210`. After C1's rewrite, `manage()` must drive the full ladder off the verifier's truth, not position count. Read `peak_tp` (+ `tp1_hit_price`) from `signals` (the executor already queries that table) keyed by `ex.signal_id`, then: `peak_tp>=2` → modify SL to `tp1`; `peak_tp==1` → modify SL to entry; final-TP handled by the order's TP. Also stop filtering only `status='placed'` — a row flipped to `'breakeven'` currently never gets revisited (line 187), so even the intended ladder could never advance. `peak_tp` lives on `signals` (set by `20260615120000_ratchet.sql`), not `executions`, so infer it from there rather than adding a column.

**H2. No MAX_HOLD 72h close.** `metaapi-executor.mjs:186-210`. Spec §1 / PLAN.md C2 require closing at market when neither final TP nor SL hits within 72h. The SQL verifier's `max_hold_due` branch only updates DB accounting — it never sends a broker close; this executor is the only thing that closes live positions. Add a time check in `manage()` using `executions.created_at` (column exists, `20260611090000_executions.sql:16`): if `Date.now() - created_at > 72h`, close remaining positions for that signal at market. Note: a new status like `'max_hold_timeout'` requires widening the `executions` status CHECK constraint, so either run a migration or reuse `'closed'` with a `detail`.

**H3. No aggregate open-risk cap (~8%).** `metaapi-executor.mjs:135`. Only `MAX_OPEN_TRADES` (count) is enforced; N trades stack to N×RISK_PCT. Before placing, sum per-trade risk across open executions and skip if `current + new > 8%`. The `executions` table stores only `lots`, not entry/sl — join back to `signals` (via `signal_id`) for `entry_price`/`stop_loss` to compute each trade's risk. Required by §9.4 L304 and PLAN.md C3.

**H4. RISK_PCT unit mismatch (spec decimal-fraction vs code percent-number).** `metaapi-executor.mjs:42, 81`; `.env.local.example:29` (`RISK_PCT=0.5`, no unit comment). Code treats `RISK_PCT` as a percent-number (`balance * (RISK_PCT/100)`), so an operator who copies the spec's `0.02` gets 0.0002 = 0.02% — **100× undersized**. Same bug in `mt5/executor.py`. **Do not blindly apply the proposed "default 2" fix** (it bundles a 4× live-risk bump into a "clarification"). Minimal-risk resolution: keep the code convention, fix the spec table (§3 L71) to percent-number form (`2` = 2%, range `0.5`–`5`), and add a unit comment to `.env.local.example:29`. The default bump to 2% (H6) is a separate, deliberate decision.

**H5. Tight-stop hygiene not enforced.** `telegram-ingest.mjs:110-111` (and absent in executor `118-138`). Only `risk > 0` is checked; `entry=4500, SL=4499.50` (0.50$) passes. Spec §9.4 L302 wants rejection of stops tighter than ~2-3$. **Caveat the brief understates:** the spec labels this "no beneficio" (hygiene, NOT edge) and explicitly *rejects* skipping tight-stop trades as a filter (#20 at 0.95$ would have run +14.8R; PLAN.md non-goals L131). Implement as a **soft hygiene filter at ingest** (`post_signal`/ingester per PLAN.md A4), not a hard `MIN_STOP_DIST=2.5` per-trade reject in the executor. Severity is arguably medium given the spec framing.

**H6. RISK_PCT default 0.5% is below spec default 2%.** `metaapi-executor.mjs:42`. Safe-direction (under-sizes; cannot over-leverage). Change default `"0.5"` → `"2.0"` to match §3/§4 and PLAN.md, with a comment that 3-5% needs 30-40 confirming trades. Bundle this decision explicitly with the H4 spec reconciliation.

## 4) MEDIUM

- **M1. `peak_tp` inferred from MT5 position count, not DB.** `metaapi-executor.mjs:194-207`. `mine.length < placed` assumes a TP-driven partial close; a manual/third-party close misfires it. Subsumed by H1's fix (read `peak_tp` from `signals`). After C1 removes legs, the count heuristic is gone anyway.
- **M2. Symbol-spec fallbacks are silent.** `metaapi-executor.mjs:75, 78-80, 87-88` (`contractSize||100`, `volumeStep/minVolume/maxVolume`). `contractSize` feeds `lossPerLot` (L76), so a missing field silently skews all sizing. Log the fetched spec once at startup and warn when any fallback engages. (Finding's "lines 78-80" for contractSize is a slip; it's L75.)
- **M3. Daily signal cap bypassed on ingest.** `telegram-ingest.mjs:145`. Direct service-role insert skips `post_signal()`'s daily cap. **Cap is 10, not 5** — `20260605110000_daily_cap_10.sql` supersedes the cited migration; read `DAILY_SIGNAL_LIMIT` from `lib/constants.ts`. Boundary is the trader's *local* midnight via `day_start()` (a SQL function — call via RPC or route inserts through `post_signal()`), not UTC.
- **M4. No message-age drop on backfill.** `telegram-ingest.mjs:213-220`. `getMessages` returns months-old posts; `ingest()` sets `activated_at=now()` and never reads `m.date`, so stale signals become live at historic levels. The executor's `MAX_SIGNAL_AGE_MIN` filters on `created_at` (DB insert ≈ now for backfill), so it does **not** catch this. Fix in `ingest()`: skip when `Date.now() - m.date*1000 > MAX_SIGNAL_AGE_MIN*60000` (PLAN.md B2).
- **M5. Partial-fill not reconciled.** `metaapi-executor.mjs:161-171, 176`. Swallowed leg errors + `status='placed'` if any ticket exists → incomplete fills indistinguishable from full. **Becomes moot once C1 collapses to a single order** (no legs to partially fail); just ensure the single-order failure path sets `status='error'`.
- **M6. Entry-slippage checked only pre-placement; `entry_fill` stores the snapshot, not the real fill.** `metaapi-executor.mjs:134, 178`. `entry_fill: cur` records the pre-trade quote, and the order result's real fill price is never read — worse than the finding states. After C1, read the actual fill from `res` and re-check against `MAX_ENTRY_SLIPPAGE`; persist the real fill in `entry_fill`.

## 5) LOW

- **L1. No TP-ordering sanity check.** `metaapi-executor.mjs:123`. Add a monotonic check (buy: `entry<tp1<tp2<tp3`; sell reversed) — but **the finding's suggested `entry < tp1 < tp2 < tp3` is broken JS** (chained comparison coerces to 0/1); write it as `&&`-joined pairs. Low impact: signals come from a trusted ingester and the shared SL bounds risk.

## 6) What's actually fine

- **DRY_RUN gating** — defaults true (L47), and place/manage/claim are all behind it. Safe to run today.
- **Dedup index** — `executions_signal_key` unique index exists; only the JS error handling (C2) is wrong.
- **Per-signal risk sizing math** — `lotForRisk` (lines 73-84) is correct *given* the RISK_PCT convention; clamps to min/max/step properly.
- **Secret handling** — no hardcoded credentials; `.env.local` is gitignored. The brief's "secret-leak" item has no backing finding and is not a real issue.
- **Ingester is genuinely read-only** — never posts to Telegram; ignores brag/update messages; idempotent on `(source, source_ref)` (lines 106-107).
- **MetaApi connection lifecycle** — deploy/waitConnected/waitSynchronized (lines 230-236) is correct.

**Recommended order:** C2 (5-line fix, prevents double-place) → C1 (single-position rewrite) → H1+H2+H3 (rebuild `manage()` for the full ladder, MAX_HOLD, aggregate cap) → H4/H6 (reconcile RISK_PCT spec + default together) → M4/M3 (ingest age + daily cap) → remaining M/L. Keep `DRY_RUN=true` through all of this.

Files: `/Users/Apple/Documents/halyard/scripts/metaapi-executor.mjs`, `/Users/Apple/Documents/halyard/scripts/telegram-ingest.mjs`, `/Users/Apple/Documents/halyard/supabase/migrations/20260611090000_executions.sql`, `/Users/Apple/Documents/halyard/supabase/migrations/20260615120000_ratchet.sql`, `/Users/Apple/Documents/halyard/docs/ESTRATEGIA_SIMON_INGENIERO.md`, `/Users/Apple/Documents/halyard/docs/PLAN.md`, `/Users/Apple/Documents/halyard/.env.local.example`.