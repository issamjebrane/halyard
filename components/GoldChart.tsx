"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  ColorType,
  LineStyle,
  type UTCTimestamp,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type AutoscaleInfo,
} from "lightweight-charts";
import type { Signal } from "@/lib/types";
import InfoTip from "./InfoTip";

type ApiCandle = { time: number; open: number; high: number; low: number; close: number };

const toData = (c: ApiCandle): CandlestickData => ({
  time: c.time as UTCTimestamp,
  open: c.open,
  high: c.high,
  low: c.low,
  close: c.close,
});

// The chart lib needs concrete colour strings, so read them off the same CSS
// variables the rest of the app themes with — that way the chart matches
// whatever theme is active, and the MutationObserver below re-reads them when
// the user toggles. Dark hex are the fallbacks.
type Palette = { accent: string; buy: string; sell: string; border: string; muted: string };
function readPalette(): Palette {
  const fallback: Palette = { accent: "#d4a85a", buy: "#79b178", sell: "#c87171", border: "#1f1f23", muted: "#8a8a90" };
  if (typeof window === "undefined") return fallback;
  const cs = getComputedStyle(document.documentElement);
  const get = (name: keyof Palette, varName: string) => cs.getPropertyValue(varName).trim() || fallback[name];
  return {
    accent: get("accent", "--accent"),
    buy: get("buy", "--buy"),
    sell: get("sell", "--sell"),
    border: get("border", "--border"),
    muted: get("muted", "--muted"),
  };
}

const WS_URL = "wss://data-stream.binance.vision/ws/paxgusdt@kline_1m";

export default function GoldChart({ signal }: { signal?: Signal | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);
  const levelsRef = useRef<number[]>([]);
  const palRef = useRef<Palette | null>(null);
  const signalRef = useRef<Signal | null>(null);
  const [last, setLast] = useState<number | null>(null);
  const [offline, setOffline] = useState(false);

  // keep the latest signal reachable from the theme observer (which fires
  // outside React's render) without re-running the chart-setup effect.
  useEffect(() => {
    signalRef.current = signal ?? null;
  }, [signal]);

  // (Re)draw the signal's price levels using the current palette + signal. Stable
  // identity (reads refs only) so it can be called from both the signal effect
  // and the theme observer.
  const redrawLines = useCallback(() => {
    const series = seriesRef.current;
    const pal = palRef.current;
    if (!series || !pal) return;

    for (const l of linesRef.current) {
      try {
        series.removePriceLine(l);
      } catch {
        /* chart gone */
      }
    }
    linesRef.current = [];

    const sig = signalRef.current;
    levelsRef.current = sig
      ? [sig.entry_price, sig.stop_loss, sig.tp1, sig.tp2, sig.tp3].filter(
          (v): v is number => v != null && Number.isFinite(v),
        )
      : [];
    try {
      series.applyOptions({}); // nudge the price scale to include the levels
    } catch {
      /* noop */
    }
    if (!sig) return;

    const add = (price: number | null, color: string, title: string, solid = false) => {
      if (price == null || !Number.isFinite(price)) return;
      const line = series.createPriceLine({
        price,
        color,
        // A hit level reads brighter/solid; an untouched one stays thin + dashed.
        lineWidth: solid ? 2 : 1,
        lineStyle: solid ? LineStyle.Solid : LineStyle.Dashed,
        axisLabelVisible: true,
        title,
      });
      linesRef.current.push(line);
    };

    add(sig.entry_price, pal.accent, `entry ${sig.direction}`, true);
    add(sig.stop_loss, pal.sell, sig.sl_hit_at ? "SL ✓" : "SL", sig.sl_hit_at != null);
    add(sig.tp1, pal.buy, sig.tp1_hit_at ? "TP1 ✓" : "TP1", sig.tp1_hit_at != null);
    add(sig.tp2, pal.buy, sig.tp2_hit_at ? "TP2 ✓" : "TP2", sig.tp2_hit_at != null);
    add(sig.tp3, pal.buy, sig.tp3_hit_at ? "TP3 ✓" : "TP3", sig.tp3_hit_at != null);
  }, []);

  // Create the chart + start the realtime feed once.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const pal = readPalette();
    palRef.current = pal;

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: pal.muted,
        fontFamily: "ui-monospace, monospace",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: pal.border },
        horzLines: { color: pal.border },
      },
      rightPriceScale: { borderColor: pal.border },
      timeScale: { borderColor: pal.border, timeVisible: true, secondsVisible: false },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: pal.buy,
      downColor: pal.sell,
      borderVisible: false,
      wickUpColor: pal.buy,
      wickDownColor: pal.sell,
      // Keep the signal's levels (SL/TP3 can be far) inside the visible scale.
      autoscaleInfoProvider: (orig: () => AutoscaleInfo | null) => {
        const res = orig();
        const ls = levelsRef.current;
        if (!res || !res.priceRange || ls.length === 0) return res;
        let { minValue, maxValue } = res.priceRange;
        for (const v of ls) {
          if (v < minValue) minValue = v;
          if (v > maxValue) maxValue = v;
        }
        return { ...res, priceRange: { minValue, maxValue } };
      },
    });
    chartRef.current = chart;
    seriesRef.current = series;

    // Re-theme the chart live when <html data-theme> flips (toggle or OS change).
    const themeObs = new MutationObserver(() => {
      const p = readPalette();
      palRef.current = p;
      try {
        chart.applyOptions({
          layout: { textColor: p.muted },
          grid: { vertLines: { color: p.border }, horzLines: { color: p.border } },
          rightPriceScale: { borderColor: p.border },
          timeScale: { borderColor: p.border },
        });
        series.applyOptions({ upColor: p.buy, downColor: p.sell, wickUpColor: p.buy, wickDownColor: p.sell });
      } catch {
        /* chart gone */
      }
      redrawLines();
    });
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    let alive = true;
    let ws: WebSocket | null = null;
    let poll: ReturnType<typeof setInterval> | undefined;

    const startPoll = () => {
      if (poll) return;
      poll = setInterval(async () => {
        try {
          const r = await fetch("/api/klines?interval=1m&limit=2", { cache: "no-store" });
          const j = await r.json();
          if (!alive || !j.ok) return;
          for (const c of j.candles as ApiCandle[]) series.update(toData(c));
          const lc = j.candles.at(-1) as ApiCandle | undefined;
          if (lc) setLast(lc.close);
          setOffline(false);
        } catch {
          /* keep last */
        }
      }, 4000);
    };
    const stopPoll = () => {
      if (poll) {
        clearInterval(poll);
        poll = undefined;
      }
    };

    (async () => {
      // History
      try {
        const r = await fetch("/api/klines?interval=1m&limit=300", { cache: "no-store" });
        const j = await r.json();
        if (!alive) return;
        if (j.ok && Array.isArray(j.candles)) {
          series.setData((j.candles as ApiCandle[]).map(toData));
          chart.timeScale().fitContent();
          const lc = j.candles.at(-1) as ApiCandle | undefined;
          if (lc) setLast(lc.close);
        } else setOffline(true);
      } catch {
        if (alive) setOffline(true);
      }

      // Realtime: prefer the Binance kline socket, fall back to polling.
      startPoll();
      try {
        ws = new WebSocket(WS_URL);
        ws.onopen = () => stopPoll();
        ws.onmessage = (ev) => {
          try {
            const k = JSON.parse(ev.data)?.k;
            if (!k || !alive) return;
            series.update({
              time: Math.floor(k.t / 1000) as UTCTimestamp,
              open: +k.o,
              high: +k.h,
              low: +k.l,
              close: +k.c,
            });
            setLast(+k.c);
            setOffline(false);
          } catch {
            /* ignore malformed frame */
          }
        };
        ws.onclose = () => {
          if (alive) startPoll();
        };
        ws.onerror = () => {
          if (alive) startPoll();
        };
      } catch {
        /* poll already running */
      }
    })();

    return () => {
      alive = false;
      stopPoll();
      themeObs.disconnect();
      try {
        ws?.close();
      } catch {
        /* noop */
      }
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      linesRef.current = [];
    };
  }, [redrawLines]);

  // Draw / redraw the signal's levels whenever the signal changes (the theme
  // observer calls redrawLines too, so levels recolour on a theme switch).
  useEffect(() => {
    redrawLines();
  }, [
    redrawLines,
    signal?.id,
    signal?.direction,
    signal?.entry_price,
    signal?.stop_loss,
    signal?.tp1,
    signal?.tp2,
    signal?.tp3,
    signal?.tp1_hit_at,
    signal?.tp2_hit_at,
    signal?.tp3_hit_at,
    signal?.sl_hit_at,
  ]);

  return (
    <div className="border border-border bg-surface">
      <div className="flex items-baseline justify-between border-b border-border px-4 py-2">
        <span className="inline-flex items-center gap-2 text-xs uppercase tracking-wider text-muted">
          <span>
            XAU/USD · live
            {signal && (
              <span className={`ml-2 ${signal.direction === "buy" ? "text-buy" : "text-sell"}`}>
                · #{signal.id} {signal.direction}
              </span>
            )}
          </span>
          <InfoTip label="About this chart" width="w-72">
            Real-time XAU/USD candles (Binance PAX Gold). When a signal is shown,
            its entry, stop loss and TP1–TP3 are drawn as lines; ✓ marks a level
            price has already touched.
          </InfoTip>
        </span>
        <span className="font-mono text-sm tabular-nums">
          {last == null ? "—" : last.toFixed(2)}
          {offline && <span className="ml-2 text-xs text-sell">offline</span>}
        </span>
      </div>
      <div ref={ref} className="h-[340px] w-full" />
    </div>
  );
}
