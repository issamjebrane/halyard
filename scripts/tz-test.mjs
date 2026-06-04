// Verify timezone-aware daily reset.
import { createClient } from "@supabase/supabase-js";
const URL = "http://127.0.0.1:55321";
const trader = createClient(URL, process.env.ANON, { auth: { persistSession: false } });

const { data: auth, error } = await trader.auth.signInWithPassword({
  email: "trader@halyard.app",
  password: "Gold-Signals-2026",
});
if (error) throw new Error(error.message);
const uid = auth.user.id;

async function dayStart() {
  const { data } = await trader.rpc("day_start", { p_uid: uid });
  return data;
}
async function used() {
  const { data } = await trader.rpc("signals_used_today");
  return data;
}
async function tzOf() {
  const { data } = await trader.from("profiles").select("timezone").eq("id", uid).single();
  return data?.timezone;
}

await trader.rpc("set_timezone", { p_tz: "UTC" });
const utcStart = await dayStart();

await trader.rpc("set_timezone", { p_tz: "Asia/Tokyo" });
console.log("1. tz stored:", await tzOf());
const tokyoStart = await dayStart();
console.log("2. day_start UTC   :", utcStart);
console.log("   day_start Tokyo :", tokyoStart, "(should differ — Tokyo midnight is earlier in UTC)");

console.log("3. used today (clean):", await used());
await trader.rpc("post_signal", {
  p_direction: "buy", p_order_type: "market",
  p_stop_loss: 2990, p_take_profit: 3010, p_entry_in: null, p_live: 3000, p_note: "tz test",
});
console.log("4. used after 1 post :", await used());

await trader.rpc("set_timezone", { p_tz: "Not/AZone" }); // invalid -> ignored
console.log("5. tz after invalid set (should stay Asia/Tokyo):", await tzOf());

const pass =
  (await tzOf()) === "Asia/Tokyo" &&
  utcStart !== tokyoStart &&
  (await used()) === 1;
console.log("\n" + (pass ? "TZ TEST PASS ✓" : "TZ TEST FAIL ✗"));

// reset to UTC; real trader's browser will set the true zone on next load
await trader.rpc("set_timezone", { p_tz: "UTC" });
process.exit(pass ? 0 : 1);
