// End-to-end smoke test of the ported engine against the local stack.
//   trader signs in -> posts a market BUY via post_signal (anti-cheat)
//   -> service role runs run_verification at a price that hits TP
//   -> read back: status should be 'won', result_r ~ +1R
import { createClient } from "@supabase/supabase-js";

const URL = "http://127.0.0.1:55321";
const ANON = process.env.ANON;
const SVC = process.env.SVC;

const trader = createClient(URL, ANON, { auth: { persistSession: false } });

const { data: auth, error: authErr } = await trader.auth.signInWithPassword({
  email: "trader@halyard.app",
  password: "Gold-Signals-2026",
});
if (authErr) throw new Error("signin failed: " + authErr.message);
console.log("1. trader signed in:", auth.user.email);

// Post a market BUY. entry pins to p_live (3000); SL below, TP above.
const live = 3000;
const { data: sid, error: postErr } = await trader.rpc("post_signal", {
  p_direction: "buy",
  p_order_type: "market",
  p_stop_loss: 2990,
  p_take_profit: 3010,
  p_entry_in: null,
  p_live: live,
  p_note: "e2e test",
});
if (postErr) throw new Error("post_signal failed: " + postErr.message);
console.log("2. posted signal id:", sid, "(market buy, entry pinned to", live + ")");

// Anti-cheat check: try to post a market order claiming a fake entry — entry
// must STILL be the live price, not anything the trader supplies.
const { data: sid2 } = await trader.rpc("post_signal", {
  p_direction: "sell",
  p_order_type: "market",
  p_stop_loss: 3015,
  p_take_profit: 2995,
  p_entry_in: 9999, // ignored for market
  p_live: live,
  p_note: "e2e anti-cheat",
});

const svc = createClient(URL, SVC, { auth: { persistSession: false } });

// Price jumps to 3010 -> BUY hits TP (win); SELL (entry 3000, SL 3015) still open.
const { error: verifyErr } = await svc.rpc("run_verification", { p_price: 3010 });
if (verifyErr) throw new Error("run_verification failed: " + verifyErr.message);
console.log("3. ran verification at price 3010");

const { data: rows } = await svc
  .from("signals")
  .select("id, direction, order_type, entry_price, status, result_r, exit_price")
  .in("id", [sid, sid2])
  .order("id");

console.log("4. results:");
for (const r of rows) {
  console.log(
    `   #${r.id} ${r.direction} ${r.order_type} entry=${r.entry_price} ` +
      `status=${r.status} R=${r.result_r ?? "—"} exit=${r.exit_price ?? "—"}`,
  );
}

const buy = rows.find((r) => r.id === sid);
const sell = rows.find((r) => r.id === sid2);
const pass =
  buy.status === "won" &&
  Math.abs(buy.result_r - 1) < 1e-6 &&
  buy.entry_price === live &&
  sell.entry_price === live && // anti-cheat: 9999 ignored
  sell.status === "open";
console.log(pass ? "\nE2E PASS ✓" : "\nE2E FAIL ✗");
process.exit(pass ? 0 : 1);
