export function fmt(n: number | null | undefined, d = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Number.isInteger(n) ? n.toString() : n.toFixed(d);
}

export function fmtR(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}R`;
}

// Count timestamps within the last `hours`. Kept out of component render so the
// current-time read doesn't trip the purity lint (server components run per request).
export function countWithin(isos: (string | null | undefined)[], hours = 24): number {
  const cutoff = Date.now() - hours * 3_600_000;
  return isos.reduce((n, s) => (s && new Date(s).getTime() >= cutoff ? n + 1 : n), 0);
}

export function rel(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return `${Math.floor(d)}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}
