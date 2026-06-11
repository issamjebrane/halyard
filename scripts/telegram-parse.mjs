// Parser for Gold VIP signal messages. Pure, side-effect-free, and unit-tested
// (run `node scripts/telegram-parse.mjs` to self-test). Used by the ingester.
//
// Canonical message shape:
//   Gold buy now 4467
//
//   Target 4471
//   Target 4475
//   Target 4486
//
//   Stop loss 4457
//
// We only ingest NEW signals (entry + targets + SL). Update/brag messages like
// "Tp 3 successfully / Enjoy (100) pips" are deliberately ignored — Simon (the
// verifier) decides hits from the real price, not the channel's own claims.

const NUM = "([0-9]+(?:[.,][0-9]+)?)";
const toNum = (s) => Number(String(s).replace(",", "."));

// "Gold buy now 4467" / "gold sell now 4218" (tolerant of spacing/case, and an
// optional "XAUUSD"/"gold" lead-in).
const ENTRY_RE = new RegExp(`(?:gold|xau\\s*usd|xauusd)?\\s*(buy|sell)\\s+now\\s+${NUM}`, "i");
const TARGET_RE = new RegExp(`target\\s*:?\\s*${NUM}`, "ig");
const SL_RE = new RegExp(`stop\\s*-?\\s*loss\\s*:?\\s*${NUM}`, "i");

/**
 * Parse one message into a structured signal, or null if it isn't a complete,
 * well-formed new signal.
 * @returns {{direction:'buy'|'sell', entry:number, tp1:number, tp2:number|null, tp3:number|null, sl:number} | null}
 */
export function parseSignal(text) {
  if (!text || typeof text !== "string") return null;

  const em = text.match(ENTRY_RE);
  const sm = text.match(SL_RE);
  if (!em || !sm) return null;

  const direction = em[1].toLowerCase();
  const entry = toNum(em[2]);
  const sl = toNum(sm[1]);

  const targets = [];
  for (const m of text.matchAll(TARGET_RE)) targets.push(toNum(m[1]));
  if (targets.length === 0) return null;

  if (![entry, sl, ...targets].every((n) => Number.isFinite(n) && n > 0)) return null;

  // Keep the first three targets as TP1/TP2/TP3 (Halyard tracks three levels).
  const [tp1, tp2 = null, tp3 = null] = targets;

  // Validate ordering so a garbled message can't become a nonsensical trade.
  // buy : SL < entry < TP1 < TP2 < TP3   |   sell: TP3 < TP2 < TP1 < entry < SL
  const asc = (a, b) => a < b;
  const desc = (a, b) => a > b;
  const ordered = (arr, cmp) =>
    arr.every((v, i) => i === 0 || (Number.isFinite(arr[i - 1]) && cmp(arr[i - 1], v)));

  if (direction === "buy") {
    const chain = [sl, entry, tp1, tp2, tp3].filter((v) => v !== null);
    if (!ordered(chain, asc)) return null;
  } else {
    const chain = [tp3, tp2, tp1, entry, sl].filter((v) => v !== null);
    if (!ordered(chain, asc)) return null; // ascending once nulls dropped
  }

  return { direction, entry, tp1, tp2, tp3, sl };
}

// ---------------------------------------------------------------------------
// Self-test: `node scripts/telegram-parse.mjs`
// ---------------------------------------------------------------------------
function runSelfTest() {
  const cases = [
    {
      name: "canonical buy, 3 targets",
      text: "Gold buy now 4467\n\nTarget 4471\nTarget 4475\nTarget 4486\n\nStop loss 4457",
      want: { direction: "buy", entry: 4467, tp1: 4471, tp2: 4475, tp3: 4486, sl: 4457 },
    },
    {
      name: "canonical sell, 3 targets",
      text: "Gold sell now 4218\nTarget 4214\nTarget 4210\nTarget 4200\nStop loss 4228",
      want: { direction: "sell", entry: 4218, tp1: 4214, tp2: 4210, tp3: 4200, sl: 4228 },
    },
    {
      name: "buy with one target only",
      text: "Gold buy now 4134\nTarget 4138\nStop loss 4120",
      want: { direction: "buy", entry: 4134, tp1: 4138, tp2: null, tp3: null, sl: 4120 },
    },
    {
      name: "more than 3 targets -> first 3",
      text: "Gold buy now 100\nTarget 101\nTarget 102\nTarget 103\nTarget 104\nStop loss 99",
      want: { direction: "buy", entry: 100, tp1: 101, tp2: 102, tp3: 103, sl: 99 },
    },
    { name: "update/brag message -> null", text: "XAUUSD sell\nTp 3 successfully\nEnjoy (100) pips profit Running", want: null },
    { name: "missing SL -> null", text: "Gold buy now 4467\nTarget 4471", want: null },
    { name: "missing targets -> null", text: "Gold buy now 4467\nStop loss 4457", want: null },
    { name: "bad ordering (buy entry below SL) -> null", text: "Gold buy now 4450\nTarget 4471\nStop loss 4457", want: null },
    { name: "empty -> null", text: "", want: null },
  ];

  let pass = 0;
  for (const c of cases) {
    const got = parseSignal(c.text);
    const ok = JSON.stringify(got) === JSON.stringify(c.want);
    console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}`);
    if (!ok) console.log(`   want ${JSON.stringify(c.want)}\n   got  ${JSON.stringify(got)}`);
    if (ok) pass++;
  }
  console.log(`\n${pass}/${cases.length} passed`);
  process.exit(pass === cases.length ? 0 : 1);
}

// Run the self-test only when invoked directly (not when imported).
import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) runSelfTest();
