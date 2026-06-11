// Create a single account via the Auth admin API. The on_auth_user_created
// trigger creates the matching profile from user_metadata (role/username).
//
// Usage (env from .env.local):
//   node --env-file=.env.local scripts/create-user.mjs <email> <password> [role] [username]
//   role defaults to 'trader'; username defaults to the email local-part, lowercased.
import { createClient } from "@supabase/supabase-js";

const [email, password, role = "trader", usernameArg] = process.argv.slice(2);

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error("Set SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.");
  process.exit(1);
}
if (!email || !password) {
  console.error("Usage: node --env-file=.env.local scripts/create-user.mjs <email> <password> [role] [username]");
  process.exit(1);
}

const username = (usernameArg || email.split("@")[0]).toLowerCase();
const sb = createClient(url, key, { auth: { persistSession: false } });

const { data, error } = await sb.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
  user_metadata: { username, role },
});

if (error) {
  if (/already|exists|registered/i.test(error.message) || error.status === 422) {
    console.log(`exists  ${role.padEnd(6)} ${email}`);
    process.exit(0);
  }
  console.error(`error   ${email}: ${error.message}`);
  process.exit(1);
}
console.log(`created ${role.padEnd(6)} ${email}  (username: ${username}, id: ${data.user.id})`);
