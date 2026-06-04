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

  const slRaw = String(formData.get("stop_loss") ?? "");
  const tpRaw = String(formData.get("take_profit") ?? "");
  const entryRaw = String(formData.get("entry_price") ?? "");

  const stop_loss = slRaw === "" ? NaN : Number(slRaw);
  const take_profit = tpRaw === "" ? NaN : Number(tpRaw);
  if (!Number.isFinite(stop_loss) || !Number.isFinite(take_profit))
    return { error: "stop loss and take profit must be numbers" };

  let entry_in: number | null = null;
  if (orderType === "pending") {
    entry_in = entryRaw === "" ? NaN : Number(entryRaw);
    if (!Number.isFinite(entry_in))
      return { error: "pending orders need an entry price" };
  }

  // Trusted live price (server-side). Fall back to the cached price if the
  // upstream feed is briefly unavailable.
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
    p_take_profit: take_profit,
    p_entry_in: entry_in,
    p_live: live,
    p_note: note,
  });

  if (error) return { error: error.message.toLowerCase() };

  revalidatePath("/trader");
  revalidatePath("/admin");
  redirect("/trader");
}
