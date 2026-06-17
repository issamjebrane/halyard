"use client";

import { useState } from "react";
import InfoTip from "./InfoTip";

// Daily desk note — a Gemini-written plain-language summary of the last 24h
// (closed trades, real money, engine health). Generated on demand so it only
// spends a model call when you ask for it; the same /api/digest route can be hit
// by a daily cron for an automated version.
export default function DailyNote() {
  const [text, setText] = useState<string | null>(null);
  const [at, setAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const generate = async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch("/api/digest", { cache: "no-store" });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `request failed (${r.status})`);
      setText(j.text);
      setAt(j.generated_at ?? null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed to generate");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="space-y-3 border border-border bg-surface p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-muted">
          <span>daily desk note</span>
          <InfoTip label="What the daily desk note is" width="w-80">
            A plain-language summary of the last 24h — closed trades, theoretical R vs real €, and
            engine health — written by Gemini from the dashboard&apos;s own data. Generated on demand;
            a daily cron can hit the same endpoint for an automated version.
          </InfoTip>
        </h2>
        <button
          type="button"
          onClick={generate}
          disabled={loading}
          className="shrink-0 border border-border px-3 py-1.5 font-mono text-xs lowercase hover:border-foreground disabled:opacity-50"
        >
          {loading ? "writing…" : text ? "refresh" : "write today's note"}
        </button>
      </div>

      {err ? (
        <p className="font-mono text-xs text-sell">{err}</p>
      ) : text ? (
        <>
          <p className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground">{text}</p>
          {at && (
            <p className="font-mono text-[10px] uppercase tracking-wider text-muted">
              generated {new Date(at).toLocaleString()} · gemini
            </p>
          )}
        </>
      ) : (
        <p className="font-mono text-xs text-muted">
          a gemini summary of the last 24h — closed trades, real money, engine health.
        </p>
      )}
    </section>
  );
}
