// Faithful TypeScript port of app.py: compute_metrics, build_equity,
// compute_trust. Same weights, clamps, flags and verdict bands so the
// reliability verdict is identical to the Flask original.
import type { Signal } from "./types";

const clamp = (x: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, x));

type Closed = Pick<Signal, "status" | "result_r" | "closed_at" | "id" | "direction">;

function closedSorted(signals: Signal[]): Closed[] {
  return signals
    .filter(
      (s) =>
        s.status === "won" || s.status === "lost" || s.status === "breakeven",
    )
    .sort((a, b) => {
      const ca = a.closed_at ?? "";
      const cb = b.closed_at ?? "";
      if (ca < cb) return -1;
      if (ca > cb) return 1;
      return a.id - b.id;
    });
}

export type Metrics = {
  total: number;
  wins: number;
  losses: number;
  win_rate: number;
  profit_factor: string;
  expectancy: number;
  cum_r: number;
  open: number;
  pending: number;
};

export function computeMetrics(signals: Signal[]): Metrics {
  const closed = closedSorted(signals);
  const total = closed.length;
  const wins = closed.filter((r) => r.status === "won").length;
  const losses = closed.filter((r) => r.status === "lost").length;
  const win_rate = total ? (wins / total) * 100 : 0;
  const gross_profit = closed
    .filter((r) => (r.result_r ?? 0) > 0)
    .reduce((a, r) => a + (r.result_r ?? 0), 0);
  const gross_loss = -closed
    .filter((r) => (r.result_r ?? 0) < 0)
    .reduce((a, r) => a + (r.result_r ?? 0), 0);
  let profit_factor: string;
  if (gross_loss > 0) profit_factor = (gross_profit / gross_loss).toFixed(2);
  else if (gross_profit > 0) profit_factor = "∞";
  else profit_factor = "—";
  const expectancy = total
    ? closed.reduce((a, r) => a + (r.result_r ?? 0), 0) / total
    : 0;
  const cum_r = closed.reduce((a, r) => a + (r.result_r ?? 0), 0);
  return {
    total,
    wins,
    losses,
    win_rate,
    profit_factor,
    expectancy,
    cum_r,
    open: signals.filter((s) => s.status === "open").length,
    pending: signals.filter((s) => s.status === "pending").length,
  };
}

export type Equity =
  | { has_data: false }
  | {
      has_data: true;
      path: string;
      w: number;
      h: number;
      zero_y: string;
      final: number;
      x0: string;
      xn: string;
    };

export function buildEquity(signals: Signal[]): Equity {
  const rows = closedSorted(signals);
  if (rows.length === 0) return { has_data: false };
  const series = [0];
  let cum = 0;
  for (const r of rows) {
    cum += r.result_r ?? 0;
    series.push(cum);
  }
  const w = 640,
    h = 180,
    pad = 20;
  let lo = Math.min(...series);
  let hi = Math.max(...series);
  if (hi - lo < 1e-9) {
    hi += 1;
    lo -= 1;
  }
  const n = series.length;
  const x = (i: number) => pad + (w - 2 * pad) * (n > 1 ? i / (n - 1) : 0);
  const y = (v: number) => h - pad - (h - 2 * pad) * ((v - lo) / (hi - lo));
  const path = series
    .map((v, i) => (i === 0 ? "M" : "L") + `${x(i).toFixed(1)} ${y(v).toFixed(1)}`)
    .join(" ");
  return {
    has_data: true,
    path,
    w,
    h,
    zero_y: y(0).toFixed(1),
    final: cum,
    x0: x(0).toFixed(1),
    xn: x(n - 1).toFixed(1),
  };
}

export type Trust = {
  n: number;
  wins: number;
  losses: number;
  win_rate: number;
  profit_factor: string;
  expectancy: number;
  avg_win: number;
  avg_loss: number;
  payoff: number;
  payoff_inf: boolean;
  max_dd: number;
  max_consec_losses: number;
  biggest_share: number;
  cum_r: number;
  score: number | null;
  verdict: "insufficient" | "solid" | "promising" | "weak" | "poor";
  flags: string[];
};

export function computeTrust(signals: Signal[]): Trust {
  const closed = closedSorted(signals);
  const n = closed.length;
  const wins = closed.filter((r) => r.status === "won");
  const losses = closed.filter((r) => r.status === "lost");
  const nwins = wins.length;
  const nlosses = losses.length;
  const win_rate = n ? (nwins / n) * 100 : 0;
  const gross_profit = wins.reduce((a, r) => a + (r.result_r ?? 0), 0);
  const gross_loss = -losses.reduce((a, r) => a + (r.result_r ?? 0), 0); // positive
  const expectancy = n ? closed.reduce((a, r) => a + (r.result_r ?? 0), 0) / n : 0;
  const avg_win = nwins ? gross_profit / nwins : 0;
  const avg_loss = nlosses ? gross_loss / nlosses : 0;
  const payoff_inf = avg_loss === 0 && avg_win > 0;
  const payoff = avg_loss > 0 ? avg_win / avg_loss : 0;

  let pf_val: number;
  let pf_str: string;
  if (gross_loss > 0) {
    pf_val = gross_profit / gross_loss;
    pf_str = pf_val.toFixed(2);
  } else if (gross_profit > 0) {
    pf_val = 99;
    pf_str = "∞";
  } else {
    pf_val = 0;
    pf_str = "—";
  }

  let cum = 0,
    peak = 0,
    maxdd = 0;
  for (const r of closed) {
    cum += r.result_r ?? 0;
    peak = Math.max(peak, cum);
    maxdd = Math.max(maxdd, peak - cum);
  }

  let mcl = 0,
    cur = 0;
  for (const r of closed) {
    if (r.status === "lost") {
      cur += 1;
      mcl = Math.max(mcl, cur);
    } else cur = 0;
  }

  const biggest_win = wins.length
    ? Math.max(...wins.map((r) => r.result_r ?? 0))
    : 0;
  const biggest_share = gross_profit > 0 ? (biggest_win / gross_profit) * 100 : 0;

  const flags: string[] = [];
  let verdict: Trust["verdict"];
  let score: number | null;

  if (n < 10) {
    verdict = "insufficient";
    score = null;
  } else {
    const pf_score = clamp((pf_val - 1) / 1.5, 0, 1); // 0 at PF1, 1 at PF2.5
    const exp_score = clamp(expectancy / 0.5, 0, 1); // 1 at +0.5R
    const dd_score = clamp(1 - (maxdd - 3) / 12.0, 0, 1); // 1 if <=3R, 0 at >=15R
    const size_score = clamp(n / 100.0, 0, 1);
    const cons_score = clamp(1 - (biggest_share / 100.0 - 0.25) / 0.35, 0, 1);
    score = Math.round(
      100 *
        (0.3 * pf_score +
          0.2 * exp_score +
          0.2 * dd_score +
          0.15 * size_score +
          0.15 * cons_score),
    );
    if (win_rate > 90) {
      flags.push("winrate_suspicious");
      score = Math.min(score, 55);
    }
    if (n < 30) flags.push("small_sample");
    verdict =
      score >= 70 ? "solid" : score >= 50 ? "promising" : score >= 30 ? "weak" : "poor";
  }

  return {
    n,
    wins: nwins,
    losses: nlosses,
    win_rate,
    profit_factor: pf_str,
    expectancy,
    avg_win,
    avg_loss,
    payoff,
    payoff_inf,
    max_dd: maxdd,
    max_consec_losses: mcl,
    biggest_share,
    cum_r: cum,
    score,
    verdict,
    flags,
  };
}
