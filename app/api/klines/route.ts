import { NextResponse } from "next/server";

// Public gold market data (Binance PAXG candles), proxied server-side so the
// browser never talks to Binance directly (no CORS/geo surprises, Vercel-safe).
const BASE =
  process.env.BINANCE_KLINES_URL ??
  "https://data-api.binance.vision/api/v3/klines";
const SYMBOL = process.env.BINANCE_SYMBOL ?? "PAXGUSDT";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const interval = (searchParams.get("interval") ?? "1m").replace(
    /[^a-z0-9]/gi,
    "",
  );
  const limit = Math.min(
    1000,
    Math.max(2, Number(searchParams.get("limit") ?? 300) || 300),
  );

  try {
    const res = await fetch(
      `${BASE}?symbol=${SYMBOL}&interval=${interval}&limit=${limit}`,
      { cache: "no-store", signal: AbortSignal.timeout(12000) },
    );
    if (!res.ok) return NextResponse.json({ ok: false }, { status: 502 });
    const raw = (await res.json()) as unknown[][];
    const candles = raw.map((k) => ({
      time: Math.floor(Number(k[0]) / 1000),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
    }));
    return NextResponse.json({ ok: true, candles });
  } catch {
    return NextResponse.json({ ok: false }, { status: 502 });
  }
}
