// Halyard verifier. Reads the broker's 1-minute OHLC (Binance PAX Gold) and runs
// the RATCHET engine against each closed candle's high/low — more faithful than a
// 45s spot snapshot, which can miss a fast wick (docs §7.4). Scheduled every
// minute via pg_cron + pg_net (cron.sql).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const KLINES_URL = Deno.env.get("BINANCE_KLINES_URL") ??
  "https://data-api.binance.vision/api/v3/klines?symbol=PAXGUSDT&interval=1m&limit=3";

Deno.serve(async () => {
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1) Fetch recent 1-minute candles. Binance returns oldest -> newest; the last
  //    one is the in-progress minute, the rest are closed.
  let candles: number[][] = [];
  try {
    const res = await fetch(KLINES_URL, {
      headers: { "User-Agent": "halyard-verifier" },
      signal: AbortSignal.timeout(12000),
    });
    const raw = await res.json();
    if (Array.isArray(raw)) candles = raw as number[][];
  } catch (_err) {
    candles = [];
  }
  if (candles.length < 2) {
    return Response.json({ ok: false, error: "ohlc_unavailable" }, { status: 502 });
  }

  const inProgress = candles[candles.length - 1];
  const closed = candles.slice(0, -1); // last 1-2 closed candles (overlap covers a missed run)
  const price = Number(inProgress[4]); // current close ≈ live price

  // 2) Cache the live price for the UI ticker.
  const { error: cacheErr } = await supabase.from("price_cache").upsert({
    id: 1,
    price,
    source_time: "",
    fetched_at: new Date().toISOString(),
  });

  // 3) Run the RATCHET engine on each closed candle, oldest first.
  let verifyErr: string | null = null;
  for (const k of closed) {
    const high = Number(k[2]);
    const low = Number(k[3]);
    const close = Number(k[4]);
    if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) continue;
    const { error } = await supabase.rpc("run_verification", {
      p_high: high,
      p_low: low,
      p_close: close,
    });
    if (error) {
      verifyErr = error.message;
      break;
    }
  }

  const ok = !cacheErr && !verifyErr;
  return Response.json(
    {
      ok,
      price,
      candles_processed: closed.length,
      cache_error: cacheErr?.message ?? null,
      verify_error: verifyErr,
    },
    { status: ok ? 200 : 500 },
  );
});
