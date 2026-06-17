import "server-only";
import { buildDeepStats, type DeepStats } from "@/lib/deepStats";
import { geminiText } from "@/lib/gemini";

// Multi-pass Gemini deep analysis over the deterministic deep stats: each engine
// gets its own focused pass, a forensic pass ranks where rentability was lost,
// then a synthesis pass writes the report. The numbers come from buildDeepStats
// (never the model); Gemini only interprets.
const SYS = [
  "You are halyard's performance analyst. halyard verifies gold (XAU/USD) signals and runs two copier engines: telegram (gold vip channel, real broker account) and simon (manual signals, separate account).",
  "BOTH engines are in active use — analyze and aim to improve EACH on its own terms. This is not a contest to pick a winner or drop one; give each its own rentability read and its own list of where it leaked.",
  "Interpret the GIVEN numbers — never recompute or invent figures. real_eur.net_eur (balance change) is the ground truth of money made; theoretical cum_r is the paper grade. capture.total_left_on_table_r is profit the move offered but the exit didn't keep; missed_theoretical_r is R from entries never taken (skipped/errored).",
  "Style: lowercase, terse, plain, no emoji, no hype. Quantify in R and €, cite trade ids. This is analysis of the operator's own system — NOT investment advice; never say to buy/sell/size.",
].join("\n");

export async function buildDeepAnalysis(): Promise<{ text: string; stats: DeepStats }> {
  const stats = await buildDeepStats();
  const eng = (p: string) => stats.engines.find((e) => e.name.startsWith(p));
  const simon = eng("simon");
  const gv = eng("telegram");

  // pass 1 + 2 — per-engine deep dives, in parallel
  const [simonNote, gvNote] = await Promise.all([
    geminiText(`engine: simon (manual). deep-dive its rentability and where it missed — is the edge real, did the account actually trade/make money, how much was left on the table, what was missed. data:\n${JSON.stringify(simon)}`, {
      system: SYS, maxOutputTokens: 600,
    }),
    geminiText(`engine: telegram (gold vip), the one live on real money. deep-dive: theoretical vs real net_eur, capture, slippage cost, give-backs, tiny sample. data:\n${JSON.stringify(gv)}`, {
      system: SYS, maxOutputTokens: 600,
    }),
  ]);

  // pass 3 — forensic: rank where rentability was lost across both engines
  const missed = await geminiText(
    `where they missed — forensic across both engines. rank the lost rentability by magnitude (R and €): entries never taken, capture leakage / left-on-table, tp give-backs, slippage. cite the worst trade ids. data:\n${JSON.stringify(
      { overall: stats.overall, reconciliation: stats.reconciliation, engines: stats.engines.map((e) => ({ name: e.name, missed: e.missed, real_eur: e.real_eur, notable: e.notable })) },
    )}`,
    { system: SYS, maxOutputTokens: 700 },
  );

  // pass 4 — synthesis
  const text = await geminiText(
    [
      "write the final deep report as PLAIN TEXT (no markdown: no #, no **bold**, no * bullets).",
      "format: each section is a lowercase label on its own line, then '- ' dashed points under it.",
      "sections, in order: bottom line · rentability · where they missed · execution gap · risk & confidence · what to watch.",
      "'where they missed' is the heart — quantify and rank in R and €, cite trade ids. every figure must trace to the inputs. terse, no emoji.",
      "",
      "SIMON DEEP-DIVE:\n" + simonNote,
      "\nGOLD VIP DEEP-DIVE:\n" + gvNote,
      "\nWHERE-THEY-MISSED FORENSIC:\n" + missed,
      "\nOVERALL:\n" + JSON.stringify(stats.overall),
      "RECONCILIATION:\n" + JSON.stringify(stats.reconciliation),
    ].join("\n"),
    { system: SYS, maxOutputTokens: 1200, temperature: 0.4 },
  );

  return { text, stats };
}
