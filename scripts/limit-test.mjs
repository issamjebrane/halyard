// Verify the 10/day cap: post 11 signals as the trader; expect 10 ok, 11th rejected.
import { createClient } from "@supabase/supabase-js";

const URL = "http://127.0.0.1:55321";
const trader = createClient(URL, process.env.ANON, {
  auth: { persistSession: false },
});

const { error: authErr } = await trader.auth.signInWithPassword({
  email: "trader@halyard.app",
  password: "Gold-Signals-2026",
});
if (authErr) throw new Error("signin failed: " + authErr.message);

let ok = 0;
let rejected = null;
for (let i = 1; i <= 11; i++) {
  const { error } = await trader.rpc("post_signal", {
    p_direction: "buy",
    p_order_type: "market",
    p_stop_loss: 2990,
    p_tp1: 3010,
    p_tp2: null,
    p_tp3: null,
    p_entry_in: null,
    p_live: 3000,
    p_note: `limit test ${i}`,
  });
  if (error) {
    rejected = { i, msg: error.message };
    console.log(`  post ${i}: REJECTED -> ${error.message}`);
  } else {
    ok++;
    console.log(`  post ${i}: ok`);
  }
}

const pass = ok === 10 && rejected?.i === 11 && /daily limit/i.test(rejected.msg);
console.log(`\naccepted=${ok} firstRejected=#${rejected?.i}`);
console.log(pass ? "LIMIT TEST PASS ✓" : "LIMIT TEST FAIL ✗");
process.exit(pass ? 0 : 1);
