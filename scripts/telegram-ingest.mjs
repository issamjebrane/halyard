// READ-ONLY Telegram -> Halyard ingester for the Gold VIP channel.
//
// It logs in with the saved session (see scripts/telegram-login.mjs), READS
// messages from TELEGRAM_CHANNEL, parses new gold signals, and inserts them
// into the signals table attributed to a dedicated 'gold_vip' trader so Simon
// (the verifier) activates and tracks them. It NEVER sends or posts anything to
// Telegram. Update/brag messages ("Tp 3 successfully …") are ignored — Simon
// decides hits from the real price.
//
// Usage:
//   node scripts/telegram-ingest.mjs                 # backfill last 50 + keep listening
//   node scripts/telegram-ingest.mjs --backfill 200  # import more history first
//   node scripts/telegram-ingest.mjs --no-listen     # backfill only, then exit
//
// Reads from .env.local: TELEGRAM_API_ID/HASH/SESSION/CHANNEL,
// NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BINANCE_PRICE_URL.
import { readFileSync } from "node:fs";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import { createClient } from "@supabase/supabase-js";
import { makeParser } from "./telegram-llm-parse.mjs";

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

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const session = process.env.TELEGRAM_SESSION;
const channelRef = process.env.TELEGRAM_CHANNEL;
const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

for (const [k, v] of Object.entries({ TELEGRAM_API_ID: apiId, TELEGRAM_API_HASH: apiHash, TELEGRAM_SESSION: session, TELEGRAM_CHANNEL: channelRef, SUPABASE_SERVICE_ROLE_KEY: sbKey })) {
  if (!v) {
    console.error(`missing ${k} in .env.local` + (k === "TELEGRAM_SESSION" ? " — run: node scripts/telegram-login.mjs" : ""));
    process.exit(1);
  }
}

// args
let backfillN = 50;
let doListen = true;
for (let i = 0; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--backfill") backfillN = Number(process.argv[++i] ?? 50);
  else if (a === "--no-listen") doListen = false;
  else if (a === "--listen") doListen = true;
}

const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false } });
const SOURCE = "telegram:gold_vip";
// Don't ingest messages older than this — keeps backfill / catch-up from
// re-injecting stale historical signals at today's price (they'd go live at
// historic levels and pollute the record). Override via env if needed.
const MAX_SIGNAL_AGE_MIN = Number(process.env.MAX_SIGNAL_AGE_MIN ?? 180);
const ageOk = (d) => {
  if (!d) return true; // unknown timestamp — don't drop
  const ms = d instanceof Date ? d.getTime() : Number(d) * 1000;
  return !Number.isFinite(ms) || Date.now() - ms <= MAX_SIGNAL_AGE_MIN * 60000;
};

// Regex-first parser with a cost-capped Gemini (Flash) fallback for messy/other
// formats and management messages. See scripts/telegram-llm-parse.mjs.
const parser = makeParser();
console.log(`parser: regex + gemini ${parser.enabled ? "ON" : "off"}`);

// Ensure the dedicated 'gold_vip' trader exists; return its profile id.
async function ensureTrader() {
  const found = await sb.from("profiles").select("id").eq("username", "gold_vip").maybeSingle();
  if (found.data?.id) return found.data.id;
  const password = "gv-" + Math.random().toString(36).slice(2, 12) + "A1!"; // never logged in with
  const { error } = await sb.auth.admin.createUser({
    email: "gold-vip@halyard.local",
    password,
    email_confirm: true,
    user_metadata: { username: "gold_vip", role: "trader" },
  });
  if (error && !/already|exists|registered/i.test(error.message)) throw error;
  const again = await sb.from("profiles").select("id").eq("username", "gold_vip").maybeSingle();
  if (!again.data?.id) throw new Error("could not create/find the gold_vip trader");
  return again.data.id;
}

async function fetchLive() {
  try {
    const res = await fetch(process.env.BINANCE_PRICE_URL, { signal: AbortSignal.timeout(8000) });
    const p = Number((await res.json())?.price);
    if (Number.isFinite(p) && p > 0) return p;
  } catch {
    /* fall through */
  }
  try {
    const { data } = await sb.from("price_cache").select("price").eq("id", 1).maybeSingle();
    const p = Number(data?.price);
    if (Number.isFinite(p) && p > 0) return p;
  } catch {
    /* none */
  }
  return null;
}

let traderId;

// Parse + insert one message. Idempotent on (source, source_ref).
async function ingest(text, msgId, msgDate) {
  if (!ageOk(msgDate)) return { skip: "stale" }; // don't re-inject old posts at today's price
  const parsed = await parser.parse(text);
  if (!parsed) return { skip: "not-a-signal" };
  if (parsed.action === "close") return { skip: "close-msg" }; // exit instruction; EA self-manages via RATCHET
  const source_ref = String(msgId);

  const dup = await sb.from("signals").select("id").eq("source", SOURCE).eq("source_ref", source_ref).maybeSingle();
  if (dup.data?.id) return { skip: "dup", id: dup.data.id };

  const { direction, entry, tp1, tp2, tp3, sl } = parsed;
  const risk = Math.abs(entry - sl);
  if (!(risk > 0)) return { skip: "zero-risk" };
  const live = await fetchLive();
  const now = new Date().toISOString();
  const track = new Date(Date.now() + 7 * 86400000).toISOString();

  // Market model: open immediately at the VIP's stated entry; Simon tracks from
  // there. Seeds mirror post_signal's market branch so the row is consistent.
  const row = {
    trader_id: traderId,
    symbol: "XAUUSD",
    direction,
    order_type: "market",
    entry_price: entry,
    stop_loss: sl,
    tp1,
    tp2,
    tp3,
    status: "open",
    market_price_at_create: live ?? entry,
    last_seen_price: entry,
    risk_per_unit: risk,
    rr_planned: Math.abs(tp1 - entry) / risk,
    note: text.slice(0, 300),
    activated_at: now,
    mfe_price: entry,
    mae_price: entry,
    mfe_r: 0,
    mae_r: 0,
    peak_tp: 0,
    track_until: track,
    source: SOURCE,
    source_ref,
  };

  const ins = await sb.from("signals").insert(row).select("id").single();
  if (ins.error) {
    if (ins.error.code === "23505") return { skip: "dup-race" };
    throw ins.error;
  }
  const sid = ins.data.id;

  // Mirror a market order's opening tape + alert (best-effort).
  await sb.from("signal_events").insert({ signal_id: sid, kind: "activated", price: entry, r_at_event: 0 });
  await sb.from("notifications").insert({
    type: "signal_new",
    signal_id: sid,
    message: `#${sid} ${direction} market @ ${entry} (SL ${sl} / TP1 ${tp1})`,
  });
  await sb.from("audit_log").insert({
    user_id: null,
    username: "gold_vip",
    action: "signal_ingested",
    details: `#${sid} ${direction} @ ${entry} from telegram msg ${source_ref}`,
  });
  return { inserted: sid, via: parsed.via };
}

// Resolve TELEGRAM_CHANNEL: @username / numeric id / t.me link via getEntity,
// otherwise match a dialog by title (the channel name from the app).
async function resolveChannel(client, ref) {
  if (/^-?\d+$/.test(ref) || ref.startsWith("@") || ref.includes("t.me/")) {
    try {
      return await client.getEntity(ref);
    } catch {
      /* fall back to dialog scan */
    }
  }
  const dialogs = await client.getDialogs({ limit: 300 });
  const lc = ref.toLowerCase();
  const hit =
    dialogs.find((d) => (d.title || "").toLowerCase() === lc) ||
    dialogs.find((d) => (d.title || "").toLowerCase().includes(lc));
  if (hit) return hit.entity;
  const names = dialogs.map((d) => d.title).filter(Boolean).slice(0, 40).join(" | ");
  throw new Error(`channel "${ref}" not found. Set TELEGRAM_CHANNEL to one of:\n  ${names}`);
}

async function main() {
  traderId = await ensureTrader();
  console.log(`gold_vip trader: ${traderId}`);

  const client = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 5 });
  client.setLogLevel?.("error");
  await client.connect();
  if (!(await client.checkAuthorization())) {
    console.error("session invalid/expired — re-run: node scripts/telegram-login.mjs");
    process.exit(1);
  }

  const chan = await resolveChannel(client, channelRef);
  console.log(`reading channel: ${chan.title ?? channelRef} (id ${chan.id})`);

  let ins = 0;
  let dup = 0;
  let skip = 0;
  const tally = (r) => {
    if (r.inserted) ins++;
    else if (String(r.skip).startsWith("dup")) dup++;
    else skip++;
  };

  if (backfillN > 0) {
    const msgs = await client.getMessages(chan, { limit: backfillN });
    // oldest-first so inserted ids follow chronological order
    for (const m of [...msgs].reverse()) {
      if (!m?.message) continue;
      const r = await ingest(m.message, m.id, m.date);
      tally(r);
      if (r.inserted) console.log(`  + #${r.inserted} [${r.via}]  ${m.message.split("\n")[0].slice(0, 48)}`);
    }
    console.log(`backfill done: ${ins} inserted, ${dup} duplicates, ${skip} non-signals (of ${msgs.length} msgs)`);
    console.log(`parser stats: ${JSON.stringify(parser.stats)}`);
  }

  if (!doListen) {
    await client.disconnect();
    process.exit(0);
  }

  // NOTE: do NOT pass { chats: [chan] } — this GramJS version tries to re-resolve
  // the entity during event dispatch and throws "Cannot find any entity ... [object
  // Object]", crashing the listener on every message. Listen to all, filter by id here.
  const chanId = chan.id?.toString();
  client.addEventHandler(async (event) => {
    const m = event.message;
    if (!m?.message) return;
    const cid = m.peerId?.channelId?.toString();
    // only the Gold VIP channel — tolerate marked (-100…) vs raw id forms
    if (chanId && cid && !(cid === chanId || chanId.endsWith(cid) || cid.endsWith(chanId))) return;
    try {
      const r = await ingest(m.message, m.id, m.date);
      if (r.inserted) console.log(`  + #${r.inserted} [${r.via}]  ${m.message.split("\n")[0].slice(0, 48)}`);
      else if (!String(r.skip).startsWith("dup")) console.log(`  · skipped (${r.skip})`);
    } catch (e) {
      console.error("ingest error:", e?.message ?? e);
    }
  }, new NewMessage({}));

  console.log("listening for new signals… (Ctrl-C to stop)");
  const stop = async () => {
    await client.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
