// No-Windows MT5 executor via MetaApi (cloud bridge). Runs on Linux (e.g.
// Oracle always-free) — MetaApi holds the MT5 terminal connection, so no
// Windows VM and no local terminal are needed.
//
// Reads Gold VIP signals from Supabase (written by the Telegram ingester),
// sizes by risk %, places up to 3 market orders carrying TP1/TP2/TP3 with a
// shared SL, and moves the remaining SL to breakeven after TP1. Every signal is
// recorded in `executions` so it's never traded twice.
//
// Usage:
//   node scripts/metaapi-executor.mjs            # DRY_RUN unless you set DRY_RUN=false
//
// Env (.env.local): METAAPI_TOKEN, METAAPI_ACCOUNT_ID, [METAAPI_REGION],
//   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SYMBOL, RISK_PCT,
//   SPLIT, MAX_OPEN_TRADES, MAX_ENTRY_SLIPPAGE, MAX_SIGNAL_AGE_MIN, DRY_RUN,
//   POLL_SECONDS, SIGNAL_SOURCE.
import { readFileSync } from "node:fs";
// Use the Node-ESM build explicitly; the default "import" entry is a web bundle
// that doesn't run under Node.
import MetaApi from "metaapi.cloud-sdk/esm-node";
import { createClient } from "@supabase/supabase-js";

function loadEnv() {
  try {
    for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch {
    /* ambient env */
  }
}
loadEnv();

const TOKEN = process.env.METAAPI_TOKEN;
const ACCOUNT_ID = process.env.METAAPI_ACCOUNT_ID;
const REGION = process.env.METAAPI_REGION || undefined;
const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SIGNAL_SOURCE = process.env.SIGNAL_SOURCE || "telegram:gold_vip";
const SYMBOL = process.env.SYMBOL || "XAUUSD";
const RISK_PCT = Number(process.env.RISK_PCT || "0.5");
const SPLIT = Math.max(1, Math.min(3, Number(process.env.SPLIT || "3")));
const MAX_OPEN_TRADES = Number(process.env.MAX_OPEN_TRADES || "6");
const MAX_ENTRY_SLIPPAGE = Number(process.env.MAX_ENTRY_SLIPPAGE || "2.0");
const MAX_SIGNAL_AGE_MIN = Number(process.env.MAX_SIGNAL_AGE_MIN || "15");
const DRY_RUN = String(process.env.DRY_RUN ?? "true").toLowerCase() !== "false";
const POLL_SECONDS = Number(process.env.POLL_SECONDS || "5");

for (const [k, v] of Object.entries({ METAAPI_TOKEN: TOKEN, METAAPI_ACCOUNT_ID: ACCOUNT_ID, SUPABASE_SERVICE_ROLE_KEY: SB_KEY })) {
  if (!v) {
    console.error(`missing ${k} in .env.local`);
    process.exit(1);
  }
}

const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
const START_TS = new Date();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------------- //
// Sizing
// --------------------------------------------------------------------------- //
function roundStep(v, step) {
  if (!step || step <= 0) return Math.round(v * 100) / 100;
  return Math.round(v / step) * step;
}

// Lots so that hitting SL loses ~RISK_PCT of balance. Assumes the symbol's quote
// currency == account currency (true for XAUUSD on a USD account); for other
// pairs MetaApi conversion would be needed.
function lotForRisk(spec, entry, sl, balance) {
  const slDist = Math.abs(entry - sl);
  const contract = spec.contractSize || 100;
  const lossPerLot = slDist * contract;
  if (!(lossPerLot > 0)) return 0;
  const step = spec.volumeStep || 0.01;
  const min = spec.minVolume || 0.01;
  const max = spec.maxVolume || 100;
  let lots = (balance * (RISK_PCT / 100)) / lossPerLot;
  lots = Math.max(min, Math.min(max, roundStep(lots, step)));
  return Number(lots.toFixed(2));
}

function splitVolumes(total, n, spec) {
  const step = spec.volumeStep || 0.01;
  const min = spec.minVolume || 0.01;
  n = Math.max(1, n);
  let per = roundStep(total / n, step);
  if (per < min) {
    n = Math.max(1, Math.floor(total / min));
    per = Math.max(min, roundStep(total / n, step));
  }
  return Array.from({ length: n }, () => Number(per.toFixed(2)));
}

// --------------------------------------------------------------------------- //
// executions ledger (dedup / claim)
// --------------------------------------------------------------------------- //
async function claim(signalId, account, status, extra = {}) {
  try {
    await sb.from("executions").insert({ signal_id: signalId, account, status, tickets: [], ...extra });
    return true;
  } catch {
    return false; // unique violation -> already claimed
  }
}

async function alreadyDone() {
  const { data } = await sb.from("executions").select("signal_id");
  return new Set((data || []).map((r) => r.signal_id));
}

// --------------------------------------------------------------------------- //
// Trading (MetaApi RPC connection)
// --------------------------------------------------------------------------- //
async function executeSignal(conn, sig, account, balance) {
  const sid = sig.id;
  const side = sig.direction; // 'buy' | 'sell'
  const entry = Number(sig.entry_price);
  const sl = Number(sig.stop_loss);
  const tps = [sig.tp1, sig.tp2, sig.tp3].filter((t) => t != null).map(Number).slice(0, SPLIT);
  if (!tps.length) return;

  const [spec, price, positions] = await Promise.all([
    conn.getSymbolSpecification(SYMBOL),
    conn.getSymbolPrice(SYMBOL),
    conn.getPositions(),
  ]);
  const cur = side === "buy" ? price.ask : price.bid;

  let skip = null;
  if (Math.abs(cur - entry) > MAX_ENTRY_SLIPPAGE) skip = `price ${cur} too far from entry ${entry}`;
  else if ((positions || []).length >= MAX_OPEN_TRADES) skip = `max open trades ${MAX_OPEN_TRADES}`;

  const lotsTotal = lotForRisk(spec, entry, sl, balance);
  if (!skip && lotsTotal <= 0) skip = "could not size position";

  if (skip) {
    log(`#${sid} ${side} -> SKIP: ${skip}`);
    if (!DRY_RUN) await claim(sid, account, "skipped", { detail: skip });
    return;
  }

  const legs = splitVolumes(lotsTotal, tps.length, spec);
  log(`#${sid} ${side} ${SYMBOL} @~${cur} SL ${sl} TPs ${tps} | risk ${RISK_PCT}% -> ${lotsTotal} lots, legs ${legs}`);

  if (DRY_RUN) {
    log(`#${sid} DRY_RUN: would place ${legs.length} order(s); nothing sent.`);
    return;
  }

  if (!(await claim(sid, account, "placed", { lots: lotsTotal }))) {
    log(`#${sid} already claimed — skipping`);
    return;
  }

  const tickets = [];
  const place = side === "buy" ? conn.createMarketBuyOrder.bind(conn) : conn.createMarketSellOrder.bind(conn);
  for (let i = 0; i < legs.length; i++) {
    const tp = tps[i] ?? tps[tps.length - 1];
    try {
      const res = await place(SYMBOL, legs[i], sl, tp, { comment: `hal${sid}` });
      const id = res.positionId || res.orderId;
      if (id) tickets.push(String(id));
      log(`   leg ${i + 1}: ${legs[i]} lots TP ${tp} -> ${id ?? res.stringCode}`);
    } catch (e) {
      log(`   leg ${i + 1} FAILED: ${e?.message ?? e}`);
    }
  }

  await sb
    .from("executions")
    .update({
      status: tickets.length ? "placed" : "error",
      tickets,
      entry_fill: cur,
      detail: tickets.length ? null : "all legs failed",
      updated_at: new Date().toISOString(),
    })
    .eq("signal_id", sid);
}

// Move remaining SL to breakeven after the first TP closes a leg.
async function manage(conn) {
  const { data: open } = await sb.from("executions").select("*").eq("status", "placed");
  if (!open?.length) return;
  const positions = (await conn.getPositions()) || [];
  for (const ex of open) {
    const placed = (ex.tickets || []).length;
    if (!placed) continue;
    const mine = positions.filter((p) => (p.comment || "").includes(`hal${ex.signal_id}`));
    if (mine.length === 0) {
      await sb.from("executions").update({ status: "closed", updated_at: new Date().toISOString() }).eq("signal_id", ex.signal_id);
      log(`#${ex.signal_id} all positions closed`);
    } else if (mine.length < placed) {
      for (const p of mine) {
        if (Math.abs((p.stopLoss ?? 0) - p.openPrice) < 1e-6) continue; // already BE
        try {
          await conn.modifyPosition(p.id, p.openPrice, p.takeProfit);
        } catch (e) {
          log(`   BE modify failed for ${p.id}: ${e?.message ?? e}`);
        }
      }
      await sb.from("executions").update({ status: "breakeven", updated_at: new Date().toISOString() }).eq("signal_id", ex.signal_id);
      log(`#${ex.signal_id} TP1 hit -> remaining SL moved to breakeven`);
    }
  }
}

// --------------------------------------------------------------------------- //
async function fetchNew() {
  const ageMs = MAX_SIGNAL_AGE_MIN * 60 * 1000;
  const cutoff = new Date(Math.max(START_TS.getTime(), Date.now() - ageMs)).toISOString();
  const { data: sigs } = await sb
    .from("signals")
    .select("*")
    .eq("source", SIGNAL_SOURCE)
    .in("status", ["open", "pending"])
    .gte("created_at", cutoff)
    .order("id");
  if (!sigs?.length) return [];
  const done = await alreadyDone();
  return sigs.filter((s) => !done.has(s.id));
}

async function main() {
  const api = new MetaApi(TOKEN, REGION ? { region: REGION } : {});
  const account = await api.metatraderAccountApi.getAccount(ACCOUNT_ID);
  if (account.state !== "DEPLOYED") await account.deploy();
  log("waiting for MetaApi to connect to the broker…");
  await account.waitConnected();
  const conn = account.getRPCConnection();
  await conn.connect();
  await conn.waitSynchronized();

  const info = await conn.getAccountInformation();
  const account_label = String(info.login ?? ACCOUNT_ID);
  log(`connected: login=${info.login} balance=${info.balance} ${info.currency} | symbol=${SYMBOL} | ${DRY_RUN ? "DRY_RUN (no orders)" : "LIVE ORDERS"}`);
  log(`watching source='${SIGNAL_SOURCE}' (signals after ${START_TS.toISOString().slice(11, 19)}, max age ${MAX_SIGNAL_AGE_MIN}m). Ctrl-C to stop.`);

  let stop = false;
  process.on("SIGINT", () => (stop = true));
  process.on("SIGTERM", () => (stop = true));

  while (!stop) {
    try {
      const bal = (await conn.getAccountInformation()).balance;
      for (const sig of await fetchNew()) await executeSignal(conn, sig, account_label, bal);
      await manage(conn);
    } catch (e) {
      log("loop error:", e?.message ?? e);
    }
    await sleep(POLL_SECONDS * 1000);
  }
  log("stopped.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
