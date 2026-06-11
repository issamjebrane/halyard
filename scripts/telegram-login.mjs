// One-time interactive Telegram login. Produces a reusable SESSION STRING that
// the read-only ingester uses thereafter — so you only enter your phone + code
// once. This logs in as YOUR user account (api_id/api_hash from my.telegram.org);
// it never sends or posts anything.
//
// Usage:
//   node scripts/telegram-login.mjs
// then paste the printed string into .env.local as TELEGRAM_SESSION=...
//
// Reads TELEGRAM_API_ID / TELEGRAM_API_HASH from .env.local.
import { readFileSync } from "node:fs";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

// Minimal .env.local loader (no dependency on dotenv).
function loadEnv() {
  try {
    for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch {
    /* fall back to ambient env */
  }
}
loadEnv();

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
if (!apiId || !apiHash) {
  console.error("Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env.local first.");
  process.exit(1);
}

const rl = readline.createInterface({ input, output });
const ask = (q) => rl.question(q);

const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
  connectionRetries: 5,
});

console.log("Logging in as your Telegram user (read-only use). Nothing is sent.\n");

await client.start({
  phoneNumber: async () => (await ask("phone number (international, e.g. +15551234567): ")).trim(),
  password: async () => (await ask("2FA password (press Enter if you have none): ")).trim(),
  phoneCode: async () => (await ask("login code Telegram just sent you: ")).trim(),
  onError: (err) => console.error("login error:", err?.message ?? err),
});

const me = await client.getMe();
console.log(`\nlogged in as ${me.username ? "@" + me.username : me.firstName} ✓`);
console.log("\nAdd this line to .env.local (keep it secret):\n");
console.log("TELEGRAM_SESSION=" + client.session.save());
console.log("\nThen run:  node scripts/telegram-ingest.mjs --backfill 50");

await client.disconnect();
rl.close();
process.exit(0);
