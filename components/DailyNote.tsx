"use client";

import { useState } from "react";
import InfoTip from "./InfoTip";
import DeepView, { type Stats } from "./DeepView";

// AI performance analysis — a Gemini-written structured read over the dashboard's
// own data (trust, by-direction/source, capture, drawdown, engine R-vs-€) for a
// chosen window. Generated on demand so it only spends a model call when asked;
// the same /api/digest route can be hit by a daily cron for an automated version.
const WINDOWS = [
  { id: "7d", label: "7d" },
  { id: "30d", label: "30d" },
  { id: "all", label: "all" },
] as const;
type WindowId = (typeof WINDOWS)[number]["id"];

export default function DailyNote() {
  const [windowId, setWindowId] = useState<WindowId>("30d");
  const [text, setText] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [at, setAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [mode, setMode] = useState<"window" | "deep">("window");

  const run = async (query: string) => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`/api/digest?${query}`, { cache: "no-store" });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `request failed (${r.status})`);
      setText(j.text);
      setStats((j.stats as Stats) ?? null);
      setAt(j.generated_at ?? null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed to generate");
    } finally {
      setLoading(false);
    }
  };

  const generate = (w: WindowId) => {
    setWindowId(w);
    setMode("window");
    return run(`window=${w}`);
  };
  const runDeep = () => {
    setMode("deep");
    return run("mode=deep");
  };

  return (
    <section className="space-y-3 border border-border bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-muted">
          <span>ai analysis</span>
          <InfoTip label="What the ai analysis is" width="w-80">
            A structured read of the track record — reliability, what&apos;s working, risk,
            and which engine is really performing (real € vs theoretical R) — written by Gemini
            from this dashboard&apos;s own data over the chosen window. Generated on demand;
            a daily cron can hit the same endpoint for an automated version.
          </InfoTip>
        </h2>
        <div className="flex flex-wrap items-center gap-1">
          {WINDOWS.map((w) => (
            <button
              key={w.id}
              type="button"
              onClick={() => generate(w.id)}
              disabled={loading}
              className={`border px-2 py-1 font-mono text-[11px] lowercase transition-colors disabled:opacity-50 ${
                mode === "window" && windowId === w.id
                  ? "border-foreground text-foreground"
                  : "border-border text-muted hover:text-foreground"
              }`}
            >
              {w.label}
            </button>
          ))}
          <span className="px-1 text-border">|</span>
          <button
            type="button"
            onClick={runDeep}
            disabled={loading}
            title="multi-pass per-engine rentability + where-they-missed report over all trades"
            className={`border px-2 py-1 font-mono text-[11px] lowercase transition-colors disabled:opacity-50 ${
              mode === "deep" ? "border-accent text-accent" : "border-border text-muted hover:text-foreground"
            }`}
          >
            deep
          </button>
        </div>
      </div>

      {loading ? (
        <p className="font-mono text-xs text-muted">
          {mode === "deep" ? "deep analysis · all trades · multi-pass…" : `analysing ${windowId}…`}
        </p>
      ) : err ? (
        <p className="font-mono text-xs text-sell">{err}</p>
      ) : text ? (
        <>
          {mode === "deep" && stats && <DeepView stats={stats} />}
          <p className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground">{text}</p>
          {at && (
            <p className="font-mono text-[10px] uppercase tracking-wider text-muted">
              {mode === "deep" ? "deep · all trades" : windowId} · generated {new Date(at).toLocaleString()} · gemini
            </p>
          )}
        </>
      ) : (
        <p className="font-mono text-xs text-muted">
          pick a window for a quick read, or <span className="text-accent">deep</span> for a full per-engine
          rentability + where-they-missed report over all trades.
        </p>
      )}
    </section>
  );
}
