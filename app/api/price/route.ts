import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { fetchLiveGold } from "@/lib/gold";

export async function GET() {
  const sb = await supabaseServer();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });

  const { data } = await sb
    .from("price_cache")
    .select("price, source_time, fetched_at")
    .eq("id", 1)
    .maybeSingle();

  let price = (data?.price as number | undefined) ?? null;

  // Cache empty (engine hasn't run yet) — fetch once and store.
  if (price === null) {
    const live = await fetchLiveGold();
    if (live !== null) {
      price = live;
      await supabaseService().from("price_cache").upsert({
        id: 1,
        price: live,
        source_time: "",
        fetched_at: new Date().toISOString(),
      });
    }
  }

  if (price === null) return NextResponse.json({ ok: false });
  return NextResponse.json({
    ok: true,
    price,
    source_time: data?.source_time ?? null,
    fetched_at: data?.fetched_at ?? null,
  });
}
