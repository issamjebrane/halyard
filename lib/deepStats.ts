import "server-only";
import { supabaseService } from "@/lib/supabase/service";
import { computeTrust } from "@/lib/metrics";
import { secondsSince } from "@/lib/format";
import type { Signal, Execution, Mt5Status, AccountBalancePoint } from "@/lib/types";

// Deterministic deep stats for the per-engine "rentability + where they missed"
// analysis. The numbers are computed here (never by the LLM); the model only
// interprets this object. One entry per copier engine: telegram (gold vip) and
// simon (manual), plus an overall + reconciliation view.

const EPS = 0.01;
const r2 = (n: number) => Number(n.toFixed(2));
const r1 = (n: number) => Number(n.toFixed(1));
const engineStatus = (ageS: number) => (ageS < 30 ? "live" : ageS < 120 ? "lagging" : "down");
const isClosed = (s: Signal) =>
  !s.excluded && (s.status === "won" || s.status === "lost" || s.status === "breakeven") && s.result_r != null;
const TRADED = new Set<Execution["status"]>(["placed", "closed", "breakeven"]);

const ENGINES = [
  { name: "telegram (gold vip)", source: "telegram:gold_vip" as string | null, slot: 1 },
  { name: "simon (manual)", source: null as string | null, slot: 2 },
];

const rOf = (s: Signal) => s.result_r ?? 0;

function tradeRow(s: Signal, ex?: Execution) {
  const slip =
    ex?.entry_fill == null ? null : s.direction === "buy" ? ex.entry_fill - s.entry_price : s.entry_price - ex.entry_fill;
  return {
    id: s.id,
    dir: s.direction,
    status: s.status,
    entry: s.entry_price,
    sl: s.stop_loss,
    tp1: s.tp1,
    tp2: s.tp2,
    tp3: s.tp3,
    peak_tp: s.peak_tp,
    result_r: s.result_r,
    mfe_r: s.mfe_r,
    mae_r: s.mae_r,
    left_on_table_r: s.result_r != null && s.mfe_r != null ? r2(s.mfe_r - s.result_r) : null,
    closed_at: s.closed_at,
    exec_status: ex?.status ?? null,
    profit_eur: ex?.profit ?? null,
    entry_fill: ex?.entry_fill ?? null,
    slippage: slip == null ? null : r2(slip),
  };
}

function engineBlock(
  cfg: (typeof ENGINES)[number],
  signals: Signal[],
  execBySignal: Map<number, Execution>,
  engines: Mt5Status[],
  balances: AccountBalancePoint[],
) {
  const mine = signals.filter((s) => (s.source ?? null) === cfg.source);
  const eng = engines.find((e) => e.id === cfg.slot);
  const account = eng?.account ?? null;
  const closed = mine.filter(isClosed);
  const t = computeTrust(closed);

  // real broker side, from this account's executions
  const acctExecs = [...execBySignal.values()].filter((e) => account && e.account === account);
  const traded = acctExecs.filter((e) => TRADED.has(e.status));
  const realized = acctExecs.reduce((a, e) => a + (e.profit ?? 0), 0);
  const grossWinEur = acctExecs.filter((e) => (e.profit ?? 0) > 0).reduce((a, e) => a + (e.profit ?? 0), 0);
  const grossLossEur = -acctExecs.filter((e) => (e.profit ?? 0) < 0).reduce((a, e) => a + (e.profit ?? 0), 0);
  const slips = traded
    .map((e) => {
      const s = signals.find((x) => x.id === e.signal_id);
      if (!s || e.entry_fill == null) return null;
      return s.direction === "buy" ? e.entry_fill - s.entry_price : s.entry_price - e.entry_fill;
    })
    .filter((x): x is number => x != null);

  // where they missed — entries never taken (skipped/errored) that had a result
  const skippedErr = mine
    .map((s) => ({ s, e: execBySignal.get(s.id) }))
    .filter((x) => x.e && (x.e.status === "skipped" || x.e.status === "error") && isClosed(x.s));
  const missedR = skippedErr.reduce((a, x) => a + rOf(x.s), 0);
  const missedWinners = skippedErr.filter((x) => rOf(x.s) > EPS).length;

  // capture leakage — favorable move available vs kept
  const wm = closed.filter((s) => s.mfe_r != null);
  const leftOnTable = wm.reduce((a, s) => a + ((s.mfe_r ?? 0) - rOf(s)), 0);
  const avgMfe = wm.length ? wm.reduce((a, s) => a + (s.mfe_r ?? 0), 0) / wm.length : 0;
  const avgRes = closed.length ? closed.reduce((a, s) => a + rOf(s), 0) / closed.length : 0;

  // tp give-back — reached a TP then closed flat/negative
  const giveback = closed.filter((s) => (s.peak_tp ?? 0) >= 1 && rOf(s) <= EPS);

  const bh = balances.filter((p) => account && p.account === account);

  const sorted = [...closed].sort((a, b) => rOf(b) - rOf(a));
  const leaks = [...wm].sort((a, b) => (b.mfe_r ?? 0) - rOf(b) - ((a.mfe_r ?? 0) - rOf(a)));

  return {
    name: cfg.name,
    label: eng?.label ?? cfg.name,
    account,
    status: eng ? engineStatus(secondsSince(eng.updated_at)) : "offline",
    open_positions: eng?.open_positions ?? 0,
    counts: { signals: mine.length, closed: closed.length, open: mine.filter((s) => s.status === "open").length },
    theoretical: {
      closed: t.n,
      wins: t.wins,
      losses: t.losses,
      win_rate: r1(t.win_rate),
      cum_r: r2(t.cum_r),
      expectancy: r2(t.expectancy),
      avg_win_r: r2(t.avg_win),
      avg_loss_r: r2(t.avg_loss),
      payoff: t.payoff_inf ? "inf" : r2(t.payoff),
      profit_factor: t.profit_factor,
      max_drawdown_r: r2(t.max_dd),
      max_consec_losses: t.max_consec_losses,
      score: t.score,
      verdict: t.verdict,
      flags: t.flags,
    },
    real_eur: {
      traded: traded.length,
      placed: acctExecs.filter((e) => e.status === "placed").length,
      closed: acctExecs.filter((e) => e.status === "closed").length,
      breakeven: acctExecs.filter((e) => e.status === "breakeven").length,
      skipped: acctExecs.filter((e) => e.status === "skipped").length,
      error: acctExecs.filter((e) => e.status === "error").length,
      realized_eur: r2(realized),
      gross_profit_eur: r2(grossWinEur),
      gross_loss_eur: r2(grossLossEur),
      profit_factor_eur: grossLossEur > 0 ? r2(grossWinEur / grossLossEur) : grossWinEur > 0 ? "inf" : "—",
      avg_entry_slippage: slips.length ? r2(slips.reduce((a, b) => a + b, 0) / slips.length) : null,
      worst_slippage: slips.length ? r2(Math.max(...slips)) : null,
      start_balance: bh.length ? bh[0].balance : null,
      current_balance: eng?.balance ?? (bh.length ? bh[bh.length - 1].balance : null),
      net_eur: bh.length ? r2((eng?.balance ?? bh[bh.length - 1].balance ?? 0) - (bh[0].balance ?? 0)) : null,
    },
    missed: {
      skipped_or_errored: skippedErr.length,
      missed_theoretical_r: r2(missedR),
      missed_winners: missedWinners,
      capture: {
        avg_favorable_mfe_r: r2(avgMfe),
        avg_captured_r: r2(avgRes),
        capture_rate_pct: avgMfe > EPS ? r1((avgRes / avgMfe) * 100) : null,
        total_left_on_table_r: r2(leftOnTable),
      },
      tp_giveback: { count: giveback.length, ids: giveback.map((s) => s.id) },
      execution_drag_r_vs_eur: { theoretical_cum_r: r2(t.cum_r), real_net_eur: bh.length ? r2((eng?.balance ?? 0) - (bh[0]?.balance ?? 0)) : null },
    },
    by_direction: (["buy", "sell"] as const).map((d) => {
      const sub = closed.filter((s) => s.direction === d);
      const cum = sub.reduce((a, s) => a + rOf(s), 0);
      const w = sub.filter((s) => rOf(s) > EPS).length;
      return { direction: d, n: sub.length, win_rate: sub.length ? r1((w / sub.length) * 100) : 0, cum_r: r2(cum), expectancy: sub.length ? r2(cum / sub.length) : 0 };
    }),
    notable: {
      best: sorted.slice(0, 3).map((s) => tradeRow(s, execBySignal.get(s.id))),
      worst: sorted.slice(-3).reverse().map((s) => tradeRow(s, execBySignal.get(s.id))),
      biggest_leak: leaks.slice(0, 4).map((s) => tradeRow(s, execBySignal.get(s.id))),
      givebacks: giveback.map((s) => tradeRow(s, execBySignal.get(s.id))),
    },
    trades: [...mine].sort((a, b) => a.id - b.id).map((s) => tradeRow(s, execBySignal.get(s.id))),
  };
}

export async function buildDeepStats() {
  const sb = supabaseService();
  const [sigRes, exRes, engRes, balRes] = await Promise.all([
    sb.from("signals").select("*").order("id", { ascending: true }),
    sb.from("executions").select("*").order("id", { ascending: true }),
    sb.from("mt5_status").select("*").order("id", { ascending: true }),
    sb.from("account_balance_history").select("*").order("id", { ascending: true }).limit(3000),
  ]);
  const signals = (sigRes.data ?? []) as Signal[];
  const executions = (exRes.data ?? []) as Execution[];
  const engines = (engRes.data ?? []) as Mt5Status[];
  const balances = (balRes.data ?? []) as AccountBalancePoint[];

  // latest execution per signal (the EA can re-emit; the newest row is truth)
  const execBySignal = new Map<number, Execution>();
  for (const e of executions) execBySignal.set(e.signal_id, e);

  const allClosed = signals.filter(isClosed);
  const overall = computeTrust(allClosed);

  return {
    totals: {
      signals: signals.length,
      closed: allClosed.length,
      open: signals.filter((s) => !s.excluded && s.status === "open").length,
      excluded: signals.filter((s) => s.excluded).length,
    },
    overall: {
      closed: overall.n,
      win_rate: r1(overall.win_rate),
      cum_r: r2(overall.cum_r),
      profit_factor: overall.profit_factor,
      expectancy: r2(overall.expectancy),
      max_drawdown_r: r2(overall.max_dd),
      max_consec_losses: overall.max_consec_losses,
      score: overall.score,
      verdict: overall.verdict,
      flags: overall.flags,
    },
    reconciliation: {
      realized_eur_total: r2([...execBySignal.values()].filter((e) => TRADED.has(e.status)).reduce((a, e) => a + (e.profit ?? 0), 0)),
      settled: [...execBySignal.values()].filter((e) => e.profit != null).length,
    },
    engines: ENGINES.map((c) => engineBlock(c, signals, execBySignal, engines, balances)),
  };
}

export type DeepStats = Awaited<ReturnType<typeof buildDeepStats>>;
