// Reprocess closed signals under RATCHET (docs/ESTRATEGIA_SIMON_INGENIERO.md §1).
// The web closed them at TP1; this replays each one through the RATCHET trailing
// ladder on its real 1-minute PAXG OHLC and rewrites result_r/status/levels/tape.
//
//   node scripts/ratchet-reprocess.mjs          # dry-run: self-test + comparison table
//   node scripts/ratchet-reprocess.mjs --apply  # back up, then write (mutates the record)
//
// RATCHET replay mirrors public.run_verification exactly (verified there). Per
// 1-min candle [high,low]: stamp level touches + raise peak; the outcome uses the
// effective stop from the peak at the START of the candle (SL / entry / TP1);
// close at that stop, or at the final TP, or at market after 72h.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const SVC = env.SUPABASE_SERVICE_ROLE_KEY;
const KLINES = "https://data-api.binance.vision/api/v3/klines";
const MAX_HOLD_MS = 72 * 3600 * 1000;
const APPLY = process.argv.includes("--apply");

// ---- RATCHET replay (pure) ---------------------------------------------------
function ratchetReplay(sig, candles) {
  const buy = sig.direction === "buy";
  const { entry_price: entry, stop_loss: sl, tp1, tp2, tp3 } = sig;
  const finalTp = tp3 ?? tp2 ?? tp1;
  const risk = sig.risk_per_unit || Math.abs(entry - sl) || 0.1;
  const activatedAt = new Date(sig.activated_at).getTime();
  const ev = [{ kind: "activated", price: entry, r: 0, t: activatedAt }];
  let peak = 0, t1 = null, t2 = null, t3 = null, slAt = null;
  let mfe = entry, mae = entry;

  for (const k of candles) {
    const hi = k.h, lo = k.l, ts = k.t;
    if (buy) { mfe = Math.max(mfe, hi); mae = Math.min(mae, lo); }
    else { mfe = Math.min(mfe, lo); mae = Math.max(mae, hi); }

    const priorPeak = peak; // RATCHET state at the START of this candle
    // stamp touches + raise peak (mirrors run_verification's pre-outcome block)
    if ((buy ? hi >= tp1 : lo <= tp1) && t1 === null) {
      t1 = ts; peak = Math.max(peak, 1);
      ev.push({ kind: "tp1_hit", price: tp1, r: (buy ? tp1 - entry : entry - tp1) / risk, t: ts });
    }
    if (tp2 != null && (buy ? hi >= tp2 : lo <= tp2) && t2 === null) {
      t2 = ts; peak = Math.max(peak, 2);
      ev.push({ kind: "tp2_hit", price: tp2, r: (buy ? tp2 - entry : entry - tp2) / risk, t: ts });
    }
    if (tp3 != null && (buy ? hi >= tp3 : lo <= tp3) && t3 === null) {
      t3 = ts; peak = Math.max(peak, 3);
      ev.push({ kind: "tp3_hit", price: tp3, r: (buy ? tp3 - entry : entry - tp3) / risk, t: ts });
    }
    if ((buy ? lo <= sl : hi >= sl) && slAt === null) {
      slAt = ts;
      ev.push({ kind: "sl_hit", price: sl, r: (buy ? sl - entry : entry - sl) / risk, t: ts });
    }

    const effStop = priorPeak === 0 ? sl : priorPeak === 1 ? entry : tp1;
    const stopHit = buy ? lo <= effStop : hi >= effStop;
    const targetHit = buy ? hi >= finalTp : lo <= finalTp;
    const maxHoldDue = ts - activatedAt > MAX_HOLD_MS;

    let exit = null;
    if (stopHit) exit = effStop;
    else if (targetHit) exit = finalTp;
    else if (maxHoldDue) exit = k.c;

    if (exit !== null) {
      const gain = buy ? exit - entry : entry - exit;
      const r = risk !== 0 ? gain / risk : 0;
      const status = r > 1e-9 ? "won" : r < -1e-9 ? "lost" : "breakeven";
      ev.push({ kind: "closed", price: exit, r, t: ts });
      ev.push({ kind: "settled", price: exit, r, t: ts });
      return {
        status, result_r: r, result_pips: gain / 0.1, exit_price: exit, closed_at: ts,
        peak_tp: peak, t1, t2, t3, slAt,
        mfe_r: buy ? (mfe - entry) / risk : (entry - mfe) / risk,
        mae_r: buy ? (mae - entry) / risk : (entry - mae) / risk,
        mfe_price: mfe, mae_price: mae, events: ev,
      };
    }
  }
  return { status: "open", events: ev }; // no close within the fetched window
}

// ---- self-test against the 4 canonical scenarios ----------------------------
function selfTest() {
  const base = { direction: "buy", entry_price: 100, stop_loss: 90, tp1: 110, tp2: 120, tp3: 130, risk_per_unit: 10, activated_at: new Date(0).toISOString() };
  const c = (h, l, cl, min) => ({ h, l, c: cl, t: min * 60000 });
  const cases = [
    ["A TP3 win", [c(131, 99, 130, 1)], "won", 3],
    ["B TP1->BE", [c(111, 99, 110, 1), c(101, 99, 100, 2)], "breakeven", 0],
    ["C TP2->TP1", [c(122, 99, 121, 1), c(112, 109, 110, 2)], "won", 1],
    ["D SL", [c(101, 89, 90, 1)], "lost", -1],
  ];
  let ok = true;
  for (const [name, candles, eStatus, eR] of cases) {
    const r = ratchetReplay(base, candles);
    const pass = r.status === eStatus && Math.abs(r.result_r - eR) < 1e-9;
    if (!pass) ok = false;
    console.log(`  ${pass ? "✓" : "✗"} ${name}: ${r.status} ${r.result_r?.toFixed(2)} (expect ${eStatus} ${eR})`);
  }
  return ok;
}

async function fetchKlines(startMs, endMs) {
  const out = [];
  let from = startMs;
  while (from < endMs) {
    const u = `${KLINES}?symbol=PAXGUSDT&interval=1m&startTime=${from}&endTime=${endMs}&limit=1000`;
    const res = await fetch(u);
    const raw = await res.json();
    if (!Array.isArray(raw) || raw.length === 0) break;
    for (const k of raw) out.push({ t: Number(k[0]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]) });
    if (raw.length < 1000) break;
    from = Number(raw[raw.length - 1][0]) + 60000;
  }
  return out;
}

async function main() {
  console.log("RATCHET reprocess — self-test:");
  if (!selfTest()) { console.error("SELF-TEST FAILED — aborting."); process.exit(1); }

  const sb = createClient(URL_, SVC, { auth: { persistSession: false } });
  const { data: signals, error } = await sb
    .from("signals")
    .select("id,direction,entry_price,stop_loss,tp1,tp2,tp3,risk_per_unit,activated_at,status,result_r")
    .in("status", ["won", "lost", "breakeven"])
    .not("activated_at", "is", null)
    .order("id");
  if (error) throw new Error(error.message);

  console.log(`\nReprocessing ${signals.length} closed signals...\n`);
  console.log("  #   dir  | old status  oldR  | new status  newR  peak");
  console.log("  " + "-".repeat(56));
  const results = [];
  let oldCum = 0, newCum = 0;
  for (const s of signals) {
    const start = new Date(s.activated_at).getTime();
    const candles = await fetchKlines(start, start + MAX_HOLD_MS + 60000);
    if (candles.length === 0) { console.log(`  ${s.id} no klines — skip`); continue; }
    const r = ratchetReplay(s, candles);
    if (r.status === "open") { console.log(`  ${String(s.id).padEnd(3)} ${s.direction} unresolved in 72h — skip`); continue; }
    oldCum += s.result_r ?? 0; newCum += r.result_r;
    results.push({ s, r });
    console.log(
      `  ${String(s.id).padEnd(3)} ${s.direction.padEnd(4)} | ${String(s.status).padEnd(10)} ${(s.result_r ?? 0).toFixed(2).padStart(5)} | ` +
      `${r.status.padEnd(10)} ${r.result_r.toFixed(2).padStart(5)}  tp${r.peak_tp}`,
    );
  }
  console.log("  " + "-".repeat(56));
  console.log(`  cumulative R:  old ${oldCum.toFixed(2)}  ->  RATCHET ${newCum.toFixed(2)}`);
  console.log(`  outcomes: won ${results.filter(x => x.r.status === "won").length} · ` +
    `breakeven ${results.filter(x => x.r.status === "breakeven").length} · ` +
    `lost ${results.filter(x => x.r.status === "lost").length}`);

  if (!APPLY) {
    console.log("\nDRY-RUN. Re-run with --apply to back up + write.");
    return;
  }

  // NOTE: a backup table (public.signals_ratchet_backup) must already exist —
  // created via psql before --apply (see the run steps). This loop only writes.
  console.log("\nApplying RATCHET results...");
  for (const { s, r } of results) {
    const upd = {
      status: r.status, result_r: r.result_r, result_pips: r.result_pips, exit_price: r.exit_price,
      closed_at: new Date(r.closed_at).toISOString(), peak_tp: r.peak_tp,
      tp1_hit_at: r.t1 ? new Date(r.t1).toISOString() : null,
      tp2_hit_at: r.t2 ? new Date(r.t2).toISOString() : null,
      tp3_hit_at: r.t3 ? new Date(r.t3).toISOString() : null,
      sl_hit_at: r.slAt ? new Date(r.slAt).toISOString() : null,
      mfe_r: r.mfe_r, mae_r: r.mae_r, mfe_price: r.mfe_price, mae_price: r.mae_price,
      settled_at: new Date(r.closed_at).toISOString(), last_seen_price: r.exit_price,
    };
    await sb.from("signals").update(upd).eq("id", s.id);
    await sb.from("signal_events").delete().eq("signal_id", s.id);
    await sb.from("signal_events").insert(
      r.events.map((e) => ({ signal_id: s.id, kind: e.kind, price: e.price, r_at_event: e.r, created_at: new Date(e.t).toISOString() })),
    );
  }
  console.log(`Applied RATCHET to ${results.length} signals.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
