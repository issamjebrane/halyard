// Seed the admin + trader accounts (port of app.seed_accounts).
// Uses the service-role key and the Auth admin API; the on_auth_user_created
// trigger creates each profile with the role from user_metadata.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/seed.mjs
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.");
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false } });

const accounts = [
  {
    email: process.env.ADMIN_EMAIL || "admin@halyard.local",
    password: process.env.ADMIN_PASS || "admin-halyard-2026",
    username: "admin",
    role: "admin",
  },
  {
    email: process.env.TRADER_EMAIL || "trader@halyard.local",
    password: process.env.TRADER_PASS || "simon-gold-2026",
    username: "simon",
    role: "trader",
  },
];

console.log("=".repeat(64));
for (const a of accounts) {
  const { error } = await sb.auth.admin.createUser({
    email: a.email,
    password: a.password,
    email_confirm: true,
    user_metadata: { username: a.username, role: a.role },
  });
  if (error) {
    if (/already|exists|registered/i.test(error.message) || error.status === 422) {
      console.log(`exists  ${a.role.padEnd(6)} ${a.email}`);
    } else {
      console.error(`error   ${a.email}: ${error.message}`);
    }
    continue;
  }
  console.log(`created ${a.role.padEnd(6)} ${a.email}  /  ${a.password}`);
}
console.log("=".repeat(64));
console.log("CHANGE THESE PASSWORDS after first login.");
