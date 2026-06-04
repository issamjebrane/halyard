"use client";

import { useEffect, useRef, useState } from "react";
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

type ApiCandle = { time: number; open: number; high: number; low: number; close: number };

const toData = (c: ApiCandle): CandlestickData => ({
  time: c.time as UTCTimestamp,
  open: c.open,
  high: c.high,
  low: c.low,
  close: c.close,
});

const ACCENT = "#d4a85a";
const BUY = "#79b178";
const SELL = "#c87171";
const WS_URL = "wss://data-stream.binance.vision/ws/paxgusdt@kline_1m";

export default function GoldChart({ signal }: { signal?: Signal | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);
  const levelsRef = useRef<number[]>([]);
  const [last, setLast] = useState<number | null>(null);
  const [offline, setOffline] = useState(false);

  // Create the chart + start the realtime feed once.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#8a8a90",
        fontFamily: "ui-monospace, monospace",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "#1f1f23" },
        horzLines: { color: "#1f1f23" },
      },
      rightPriceScale: { borderColor: "#1f1f23" },
      timeScale: { borderColor: "#1f1f23", timeVisible: true, secondsVisible: false },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: BUY,
      downColor: SELL,
      borderVisible: false,
      wickUpColor: BUY,
      wickDownColor: SELL,
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
  }, []);

  // Draw / redraw the signal's levels whenever the signal changes.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    for (const l of linesRef.current) {
      try {
        series.removePriceLine(l);
      } catch {
        /* chart gone */
      }
    }
    linesRef.current = [];

    levelsRef.current = signal
      ? [signal.entry_price, signal.stop_loss, signal.tp1, signal.tp2, signal.tp3].filter(
          (v): v is number => v != null && Number.isFinite(v),
        )
      : [];
    try {
      series.applyOptions({}); // nudge the price scale to include the levels
    } catch {
      /* noop */
    }

    if (!signal) return;

    const add = (price: number | null, color: string, title: string, solid = false) => {
      if (price == null || !Number.isFinite(price)) return;
      const line = series.createPriceLine({
        price,
        color,
        lineWidth: 1,
        lineStyle: solid ? LineStyle.Solid : LineStyle.Dashed,
        axisLabelVisible: true,
        title,
      });
      linesRef.current.push(line);
    };

    add(signal.entry_price, ACCENT, `entry ${signal.direction}`, true);
    add(signal.stop_loss, SELL, "SL");
    add(signal.tp1, BUY, "TP1", true);
    add(signal.tp2, BUY, "TP2");
    add(signal.tp3, BUY, "TP3");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    signal?.id,
    signal?.direction,
    signal?.entry_price,
    signal?.stop_loss,
    signal?.tp1,
    signal?.tp2,
    signal?.tp3,
  ]);

  return (
    <div className="border border-border bg-surface">
      <div className="flex items-baseline justify-between border-b border-border px-4 py-2">
        <span className="text-xs uppercase tracking-wider text-muted">
          XAU/USD · live
          {signal && (
            <span className={`ml-2 ${signal.direction === "buy" ? "text-buy" : "text-sell"}`}>
              · #{signal.id} {signal.direction}
            </span>
          )}
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
