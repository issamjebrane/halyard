// LLM (Gemini Flash) signal parser — the "smart" layer in front of the regex parser.
//
// Cost is the design constraint, so the LLM is used SPARINGLY:
//   1. regex first  — the canonical Gold VIP format parses for free (no API call)
//   2. keyword gate — only trade-looking messages are ever sent to the LLM
//   3. Gemini Flash — free-tier / cheap; maxOutputTokens=256; input truncated to 600 chars
//   4. daily cap    — LLM_PARSE_DAILY_MAX hard-limits calls/UTC-day, then regex-only
//   5. dedup        — the ingester never re-parses the same message
// In practice this is a few calls/day -> ~free, with a ceiling you set.
//
// Returns the same shape the regex parser does, plus `action` and `via`:
//   { action:'open', direction, entry, tp1, tp2, tp3, sl, via:'regex'|'gemini' }
//   { action:'close' }                       // VIP told an existing trade to exit
//   null                                      // nothing actionable (ignore/chatter)
//
// Env: GEMINI_API_KEY (required to enable the LLM; absent => pure regex),
//      LLM_PARSE=on|off, GEMINI_MODEL (default gemini-2.0-flash),
//      LLM_PARSE_DAILY_MAX (default 200). Uses native fetch — no extra deps.
import { parseSignal } from "./telegram-parse.mjs";

const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Cheap pre-filter: only worth an LLM call if the text smells like a trade
// instruction (a trade keyword AND a number). Skips images, brags, ads, chatter.
const KW = /\b(buy|sell|long|short|target|tps?|take\s*profit|sl|stop\s*-?\s*loss|entry|enter|close|exit|book)\b/i;
export function looksTradeRelated(text) {
  return typeof text === "string" && KW.test(text) && /\d/.test(text);
}

const SYSTEM = `You extract gold (XAUUSD) trading signals from Telegram messages and return ONLY JSON.

action:
- "open"  = a NEW tradeable signal: a direction (buy/sell) with an entry price and a stop loss. Targets may be 1-3.
- "close" = an instruction to exit/close an EXISTING trade now ("close now", "exit", "close all", "book profits and exit").
- "ignore" = anything else: results/brags ("TP3 hit, +100 pips"), partial updates ("move SL to BE"), commentary, ads, news, or an incomplete signal missing direction/entry/SL.

Rules:
- Numbers are gold prices (~1500-5000). Strip commas/words; output plain numbers.
- direction is "buy" or "sell" (treat long=buy, short=sell). null if unknown.
- entry = the order price. sl = stop loss. tp1/tp2/tp3 = the first three take-profit/targets in order; use null for any not given.
- For "open": ordering must make sense — buy: sl < entry < tp1 <= tp2 <= tp3; sell: tp3 <= tp2 <= tp1 < entry < sl. If it doesn't, use action "ignore".
- For "close"/"ignore": set direction/entry/sl/tp1/tp2/tp3 to null.
- Never invent levels. If a required level is missing, it's "ignore", not a guess.

Examples:
- "Gold buy now 4467 / Target 4471 / Target 4475 / Stop loss 4457" -> {"action":"open","direction":"buy","entry":4467,"sl":4457,"tp1":4471,"tp2":4475,"tp3":null}
- "XAUUSD SELL 4218 / TP 4210 / SL 4228" -> {"action":"open","direction":"sell","entry":4218,"sl":4228,"tp1":4210,"tp2":null,"tp3":null}
- "close gold now, secure profit" -> {"action":"close","direction":null,"entry":null,"sl":null,"tp1":null,"tp2":null,"tp3":null}
- "TP3 smashed +120 pips, enjoy" -> {"action":"ignore","direction":null,"entry":null,"sl":null,"tp1":null,"tp2":null,"tp3":null}`;

// Gemini responseSchema (UPPERCASE types, nullable for optional numbers).
const SCHEMA = {
  type: "OBJECT",
  properties: {
    action: { type: "STRING", enum: ["open", "close", "ignore"] },
    direction: { type: "STRING", nullable: true },
    entry: { type: "NUMBER", nullable: true },
    sl: { type: "NUMBER", nullable: true },
    tp1: { type: "NUMBER", nullable: true },
    tp2: { type: "NUMBER", nullable: true },
    tp3: { type: "NUMBER", nullable: true },
  },
  required: ["action", "direction", "entry", "sl", "tp1", "tp2", "tp3"],
};

const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
const utcDay = () => new Date().toISOString().slice(0, 10);

// Validate the model's raw output into our canonical signal (or a bare action).
function normalize(inp) {
  const action = inp && ["open", "close", "ignore"].includes(inp.action) ? inp.action : "ignore";
  if (action !== "open") return { action };
  const direction = inp.direction === "buy" || inp.direction === "sell" ? inp.direction : null;
  const entry = num(inp.entry), sl = num(inp.sl), tp1 = num(inp.tp1);
  let tp2 = num(inp.tp2), tp3 = num(inp.tp3);
  if (!direction || ![entry, sl, tp1].every((n) => n != null && n > 0)) return { action: "ignore" };
  if (!(tp2 > 0)) tp2 = null;
  if (!(tp3 > 0)) tp3 = null;
  const chain =
    direction === "buy"
      ? [sl, entry, tp1, tp2, tp3].filter((v) => v != null)
      : [tp3, tp2, tp1, entry, sl].filter((v) => v != null);
  const ok = chain.every((v, i) => i === 0 || chain[i - 1] < v);
  if (!ok) return { action: "ignore" };
  return { action: "open", direction, entry, tp1, tp2, tp3, sl };
}

/**
 * Build a parser. Returns { parse(text)->Promise, stats, enabled } where parse
 * resolves to a signal object (action 'open'), { action:'close' }, or null.
 */
export function makeParser(opts = {}) {
  const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY;
  const model = opts.model ?? DEFAULT_MODEL;
  const enabled = (process.env.LLM_PARSE ?? "on") !== "off" && !!apiKey;
  const dailyMax = Number(opts.dailyMax ?? process.env.LLM_PARSE_DAILY_MAX ?? 200);

  let day = utcDay();
  let used = 0;
  const stats = { regex: 0, llm: 0, capped: 0, skipped: 0, errors: 0, close: 0 };

  async function callGemini(text) {
    const res = await fetch(`${API_BASE}/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: text.slice(0, 600) }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 512,
          responseMimeType: "application/json",
          responseSchema: SCHEMA,
          thinkingConfig: { thinkingBudget: 0 }, // 2.5-flash thinks by default; off => budget goes to the JSON (and cheaper)
        },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const out = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!out) return null;
    try {
      return JSON.parse(out);
    } catch {
      return null;
    }
  }

  return {
    stats,
    enabled,
    async parse(text) {
      if (!text || typeof text !== "string") return null;

      // 1) regex first — free + deterministic for the canonical format.
      const rx = parseSignal(text);
      if (rx) {
        stats.regex++;
        return { action: "open", ...rx, via: "regex" };
      }

      // 2) gate: don't spend a call on anything that isn't trade-shaped.
      if (!enabled || !looksTradeRelated(text)) {
        stats.skipped++;
        return null;
      }

      // 3) hard daily cap (resets at UTC midnight / on restart).
      const d = utcDay();
      if (d !== day) {
        day = d;
        used = 0;
      }
      if (used >= dailyMax) {
        stats.capped++;
        return null;
      }
      used++;

      try {
        const out = normalize(await callGemini(text));
        stats.llm++;
        if (out.action === "open") return { ...out, via: "gemini" };
        if (out.action === "close") {
          stats.close++;
          return { action: "close", via: "gemini" };
        }
        return null; // ignore
      } catch (e) {
        stats.errors++;
        console.error("gemini parse error:", e?.message ?? e);
        return null; // fail safe — regex already missed, so we just skip
      }
    },
  };
}

// Direct-run smoke test (needs GEMINI_API_KEY): `node scripts/telegram-llm-parse.mjs`
import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const samples = [
    "XAUUSD SELL @ 4218 — TP 4210, 4200 — SL 4228", // messy open (regex misses)
    "gold long 4467, targets 4471/4475/4486, stop 4457", // slashed open
    "close gold now and secure profits 4300", // close (number present so it passes the gate)
    "TP3 hit +120 pips, enjoy the run! 4500", // ignore (brag)
    "good morning traders, big news today", // gated out (no call)
    "Gold buy now 4467\nTarget 4471\nStop loss 4457", // canonical -> regex, no call
  ];
  const p = makeParser();
  console.log("llm enabled:", p.enabled, "model:", DEFAULT_MODEL);
  for (const s of samples) {
    const r = await p.parse(s);
    console.log("\n" + s.split("\n")[0].slice(0, 50));
    console.log("  ->", JSON.stringify(r));
  }
  console.log("\nstats:", JSON.stringify(p.stats));
  process.exit(0);
}
