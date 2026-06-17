import "server-only";
import { supabaseService } from "@/lib/supabase/service";
import { geminiText } from "@/lib/gemini";
import { computeTrust } from "@/lib/metrics";
import { secondsSince } from "@/lib/format";
import type { Signal, Execution, Mt5Status, AccountBalancePoint } from "@/lib/types";

const EPS = 0.01;
const r2 = (n: number) => Number(n.toFixed(2));
const r1 = (n: number) => Number(n.toFixed(1));
const engineStatus = (ageS: number) => (ageS < 30 ? "live" : ageS < 120 ? "lagging" : "down");
const isClosed = (s: Signal) =>
  !s.excluded && (s.status === "won" || s.status === "lost" || s.status === "breakeven") && s.result_r != null;

export type WindowKey = "7d" | "30d" | "all";
const WINDOW_HOURS: Record<WindowKey, number | null> = { "7d": 168, "30d": 720, all: null };

// Summarise a set of closed trades the same way the dashboard does.
function summarise(rows: Signal[]) {
  const n = rows.length;
  const cum = rows.reduce((a, s) => a + (s.result_r ?? 0), 0);
  const wins = rows.filter((s) => (s.result_r ?? 0) > EPS).length;
  return { n, win_rate: n ? r1((wins / n) * 100) : 0, cum_r: r2(cum), expectancy: n ? r2(cum / n) : 0 };
}

export type AnalysisFacts = ReturnType<typeof shape> extends Promise<infer T> ? T : never;

async function shape(windowKey: WindowKey) {
  const sb = supabaseService();
  const hours = WINDOW_HOURS[windowKey];
  const since = hours ? new Date(Date.now() - hours * 3_600_000).toISOString() : null;
  const since24 = new Date(Date.now() - 24 * 3_600_000).toISOString();

  const [sigRes, exRes, engRes, balRes] = await Promise.all([
    sb.from("signals").select("*").order("id", { ascending: true }),
    sb.from("executions").select("*").order("id", { ascending: true }),
    sb.from("mt5_status").select("*").order("id", { ascending: true }),
    sb.from("account_balance_history").select("*").order("id", { ascending: true }).limit(2000),
  ]);

  const signals = (sigRes.data ?? []) as Signal[];
  const executions = (exRes.data ?? []) as Execution[];
  const engines = (engRes.data ?? []) as Mt5Status[];
  const balances = (balRes.data ?? []) as AccountBalancePoint[];

  // closed trades inside the analysis window
  const inWindow = (s: Signal) => (since ? (s.closed_at ?? "") >= since : true);
  const closed = signals.filter(isClosed).filter(inWindow);
  const r = (s: Signal) => s.result_r ?? 0;

  const trust = computeTrust(closed);
  const overall = {
    closed: trust.n,
    win_rate: r1(trust.win_rate),
    profit_factor: trust.profit_factor,
    expectancy: r2(trust.expectancy),
    cum_r: r2(trust.cum_r),
    avg_win: r2(trust.avg_win),
    avg_loss: r2(trust.avg_loss),
    payoff: trust.payoff_inf ? "inf" : r2(trust.payoff),
    max_drawdown_r: r2(trust.max_dd),
    max_consec_losses: trust.max_consec_losses,
    score: trust.score,
    verdict: trust.verdict,
    flags: trust.flags,
  };

  const by_direction = (["buy", "sell"] as const).map((d) => ({
    direction: d,
    ...summarise(closed.filter((s) => s.direction === d)),
  }));

  const srcLabel = (src: string | null) => (src ? src.replace("telegram:", "tg ") : "manual");
  const sources = [...new Set(closed.map((s) => s.source ?? null))];
  const by_source = sources
    .map((src) => ({ source: srcLabel(src), ...summarise(closed.filter((s) => (s.source ?? null) === src)) }))
    .sort((a, b) => b.n - a.n);

  // capture efficiency (MFE / MAE) over trades the engine actually tracked
  const wm = closed.filter((s) => s.mfe_r != null);
  const avgMfe = wm.length ? wm.reduce((a, s) => a + (s.mfe_r ?? 0), 0) / wm.length : 0;
  const avgMae = wm.length ? wm.reduce((a, s) => a + (s.mae_r ?? 0), 0) / wm.length : 0;
  const avgRes = closed.length ? closed.reduce((a, s) => a + r(s), 0) / closed.length : 0;
  const capture = {
    avg_favorable_mfe: r2(avgMfe),
    avg_captured: r2(avgRes),
    capture_rate_pct: avgMfe > EPS ? r1((avgRes / avgMfe) * 100) : null,
    avg_adverse_mae: r2(avgMae),
  };

  // result distribution (R bands)
  const bucketOf = (x: number) => (x <= -1 + EPS ? "<=-1R" : x < -EPS ? "-1..0R" : x <= EPS ? "0R be" : x < 1 ? "0..1R" : x < 2 ? "1..2R" : ">=2R");
  const distribution: Record<string, number> = {};
  for (const s of closed) distribution[bucketOf(r(s))] = (distribution[bucketOf(r(s))] ?? 0) + 1;

  // recent form — last 10 closed by close time
  const byClose = [...closed].sort((a, b) => (a.closed_at ?? "").localeCompare(b.closed_at ?? ""));
  const recent = byClose.slice(-10);
  const recent_form = {
    last_n: recent.length,
    sequence: recent.map((s) => (r(s) > EPS ? "w" : r(s) < -EPS ? "l" : "b")).join(""),
    win_rate: recent.length ? r1((recent.filter((s) => r(s) > EPS).length / recent.length) * 100) : 0,
    cum_r: r2(recent.reduce((a, s) => a + r(s), 0)),
  };

  // avg hold (hours) for wins vs losses
  const holdH = (s: Signal) =>
    s.activated_at && s.closed_at ? (new Date(s.closed_at).getTime() - new Date(s.activated_at).getTime()) / 3_600_000 : null;
  const avgHold = (arr: Signal[]) => {
    const v = arr.map(holdH).filter((x): x is number => x != null);
    return v.length ? r1(v.reduce((a, b) => a + b, 0) / v.length) : null;
  };
  const hold_hours = { wins: avgHold(closed.filter((s) => r(s) > EPS)), losses: avgHold(closed.filter((s) => r(s) < -EPS)) };

  // engines: theoretical R (by source) vs the real broker account + slippage
  const acctOf = (id: number) => engines.find((e) => e.id === id)?.account ?? null;
  const engCols = [
    { key: "telegram (gold vip)", match: (s: Signal) => s.source === "telegram:gold_vip", slot: 1 },
    { key: "simon (manual)", match: (s: Signal) => s.source == null, slot: 2 },
  ];
  const byId = new Map(signals.map((s) => [s.id, s]));
  const enginesOut = engCols.map((c) => {
    const account = acctOf(c.slot);
    const eng = engines.find((e) => e.id === c.slot);
    const theo = summarise(closed.filter(c.match));
    const bh = balances.filter((p) => account && p.account === account);
    const start = bh.length ? bh[0].balance ?? 0 : null;
    const cur = bh.length ? bh[bh.length - 1].balance ?? 0 : eng?.balance ?? null;
    const net = start != null && cur != null ? r2(cur - start) : null;
    // entry slippage (direction-aware), avg over this account's traded executions
    const slips = executions
      .filter((e) => e.account === account && e.entry_fill != null)
      .map((e) => {
        const s = byId.get(e.signal_id);
        if (!s) return null;
        return s.direction === "buy" ? (e.entry_fill ?? 0) - s.entry_price : s.entry_price - (e.entry_fill ?? 0);
      })
      .filter((x): x is number => x != null);
    const avg_slippage = slips.length ? r2(slips.reduce((a, b) => a + b, 0) / slips.length) : null;
    return {
      label: eng?.label ?? c.key,
      account,
      status: eng ? engineStatus(secondsSince(eng.updated_at)) : "offline",
      open_positions: eng?.open_positions ?? 0,
      theoretical: { closed: theo.n, win_rate: theo.win_rate, cum_r: theo.cum_r },
      real_account_eur: { balance: eng?.balance ?? cur, equity: eng?.equity ?? null, net_total: net },
      avg_entry_slippage: avg_slippage,
    };
  });

  // last 24h activity (independent of the analysis window)
  const closed24 = signals.filter(isClosed).filter((s) => (s.closed_at ?? "") >= since24);
  const exec24 = executions.filter((e) => (e.updated_at ?? "") >= since24);
  const last_24h = {
    closed: closed24.length,
    wins: closed24.filter((s) => r(s) > EPS).length,
    losses: closed24.filter((s) => r(s) < -EPS).length,
    cum_r: r2(closed24.reduce((a, s) => a + r(s), 0)),
    realized_eur: r2(exec24.reduce((a, e) => a + (e.profit ?? 0), 0)),
    new_signals: signals.filter((s) => (s.created_at ?? "") >= since24).length,
  };

  return {
    window: windowKey,
    overall,
    by_direction,
    by_source,
    capture,
    distribution,
    recent_form,
    hold_hours,
    engines: enginesOut,
    last_24h,
    open_now: signals.filter((s) => !s.excluded && s.status === "open").length,
  };
}

export const buildAnalysisFacts = (windowKey: WindowKey) => shape(windowKey);

const SYSTEM = [
  "You are the performance analyst for halyard, a gold (XAU/USD) trade-signal verifier that runs two copier engines: telegram (the gold-vip channel) and simon (manual signals).",
  "You are given a JSON of computed stats over an analysis window. Write a STRUCTURED analytical read — not a status line. Strict house style: lowercase, terse, plain prose, NO emoji, NO markdown headers/bold/bullets-with-asterisks. Use short labelled lines.",
  "Cover, in this order, each as one or two short lines prefixed with a lowercase label and a dash:",
  "  read — the bottom line: is the record reliable (use score/verdict, profit factor, expectancy), and the net cum R.",
  "  edge — what's working: the stronger direction and source, capture rate, payoff.",
  "  risk — the weak spots: max drawdown (R), max consecutive losses, any weak direction/source, and small-sample/flag caveats.",
  "  engines — which engine is REALLY performing: compare each engine's theoretical cum R against its real € net; call out divergence and slippage (real € is the truth).",
  "  latest — the last 24h activity in one line.",
  "  watch — 1-2 concrete things to monitor next (operational/statistical observations only).",
  "Rules: interpret the numbers, don't just restate them. Never invent values not in the JSON. This is performance analysis of the user's own track record — NOT investment or trading advice; do not tell the user to buy, sell, or size positions.",
].join("\n");

export async function buildAnalysis(windowKey: WindowKey = "30d"): Promise<{ text: string; stats: Awaited<ReturnType<typeof shape>> }> {
  const stats = await shape(windowKey);
  const text = await geminiText(`window: ${windowKey}\nstats:\n${JSON.stringify(stats)}`, {
    system: SYSTEM,
    temperature: 0.35,
    maxOutputTokens: 900,
  });
  return { text, stats };
}
