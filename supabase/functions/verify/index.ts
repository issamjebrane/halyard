// Halyard verifier — the serverless analog of market.poll_once().
// Fetches the spot gold price, caches it, and runs the verification engine.
// Scheduled to run every minute via pg_cron + pg_net (see supabase/cron.sql).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const GOLD_URL = Deno.env.get("GOLD_PRICE_URL") ??
  "https://api.gold-api.com/price/XAU";

Deno.serve(async () => {
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1) Read the spot price (no key required).
  let price: number | null = null;
  let sourceTime = "";
  try {
    const res = await fetch(GOLD_URL, {
      headers: { "User-Agent": "halyard-verifier" },
      signal: AbortSignal.timeout(12000),
    });
    const data = await res.json();
    const p = Number(data?.price);
    if (Number.isFinite(p) && p > 0) {
      price = p;
      sourceTime = data?.updatedAt ?? "";
    }
  } catch (_err) {
    price = null;
  }

  if (price === null) {
    return Response.json({ ok: false, error: "price_unavailable" }, { status: 502 });
  }

  // 2) Cache the price.
  const { error: cacheErr } = await supabase.from("price_cache").upsert({
    id: 1,
    price,
    source_time: sourceTime,
    fetched_at: new Date().toISOString(),
  });

  // 3) Run the verification engine.
  const { error: rpcErr } = await supabase.rpc("run_verification", {
    p_price: price,
  });

  const ok = !cacheErr && !rpcErr;
  return Response.json(
    {
      ok,
      price,
      cache_error: cacheErr?.message ?? null,
      verify_error: rpcErr?.message ?? null,
    },
    { status: ok ? 200 : 500 },
  );
});
