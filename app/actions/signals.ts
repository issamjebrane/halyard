"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { fetchLiveGold } from "@/lib/gold";

type CreateState = { error?: string } | undefined;

export async function createSignal(
  _prev: CreateState,
  formData: FormData,
): Promise<CreateState> {
  const sb = await supabaseServer();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const direction = String(formData.get("direction") ?? "").toLowerCase();
  const orderType = String(formData.get("order_type") ?? "").toLowerCase();
  const note = String(formData.get("note") ?? "").trim();

  if (direction !== "buy" && direction !== "sell")
    return { error: "direction must be buy or sell" };
  if (orderType !== "market" && orderType !== "pending")
    return { error: "order type must be market or pending" };

  // empty -> null; otherwise Number()
  const num = (k: string): number | null => {
    const s = String(formData.get(k) ?? "").trim();
    return s === "" ? null : Number(s);
  };

  const stop_loss = num("stop_loss");
  const tp1 = num("tp1");
  if (stop_loss === null || !Number.isFinite(stop_loss))
    return { error: "stop loss must be a number" };
  if (tp1 === null || !Number.isFinite(tp1))
    return { error: "TP1 is required" };

  const tp2 = num("tp2");
  const tp3 = num("tp3");
  if (tp2 !== null && !Number.isFinite(tp2))
    return { error: "TP2 must be a number" };
  if (tp3 !== null && !Number.isFinite(tp3))
    return { error: "TP3 must be a number" };

  let entry_in: number | null = null;
  if (orderType === "pending") {
    entry_in = num("entry_price");
    if (entry_in === null || !Number.isFinite(entry_in))
      return { error: "pending orders need an entry price" };
  }

  // Trusted live price (server-side); fall back to the cached price.
  let live = await fetchLiveGold();
  if (live === null) {
    const { data } = await supabaseService()
      .from("price_cache")
      .select("price")
      .eq("id", 1)
      .maybeSingle();
    live = (data?.price as number | undefined) ?? null;
  }
  if (live === null) return { error: "live price unavailable, try again" };

  const { error } = await sb.rpc("post_signal", {
    p_direction: direction,
    p_order_type: orderType,
    p_stop_loss: stop_loss,
    p_tp1: tp1,
    p_tp2: tp2,
    p_tp3: tp3,
    p_entry_in: entry_in,
    p_live: live,
    p_note: note,
  });

  if (error) return { error: error.message.toLowerCase() };

  revalidatePath("/trader");
  revalidatePath("/admin");
  redirect("/trader");
}
