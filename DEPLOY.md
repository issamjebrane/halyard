# Deploying Halyard to production (Vercel + Supabase, free tier)

Two services: **Supabase** hosts the database + auth + verifier; **Vercel** hosts
the Next.js app. Do Supabase first (the app needs its keys).

Prereqs: a GitHub account, a Vercel account, a Supabase account, and the
Supabase CLI logged in (`supabase login`).

---

## A. Supabase (database, auth, verifier)

### 1. Create the project
- supabase.com → New project. Pick a name, a strong **database password**
  (save it), and a region near your friend.
- When it finishes, open **Project Settings → API** and copy:
  - `Project URL`            → `https://<REF>.supabase.co`
  - `anon` `public` key
  - `service_role` key (secret — never ships to the browser)
- The `<REF>` is the subdomain (e.g. `abcdwxyz`).

### 2. Push the schema (creates tables, RLS, the engine, the 10/day cap)
From the project folder:
```bash
supabase link --project-ref <REF>          # paste the DB password
supabase db push                            # applies supabase/migrations/*
```

### 3. Deploy the verifier Edge Function
```bash
supabase functions deploy verify --no-verify-jwt
```
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically in
hosted functions. The verifier uses the keyless Binance public ticker, so no
secret is required; override the symbol with
`supabase secrets set BINANCE_PRICE_URL=...` if needed.

### 4. Schedule the verifier every minute
Supabase Dashboard → **SQL Editor**, paste `supabase/cron.sql`, replace
`<PROJECT_REF>` and `<SERVICE_ROLE_KEY>`, run it. Check it registered:
```sql
select * from cron.job;
```

### 5. Lock auth to invite-only + create the accounts
- Dashboard → **Authentication → Providers → Email**: ensure **Email** is ON.
- Dashboard → **Authentication → Sign In / Providers** (or **Settings**): turn
  **"Allow new users to sign up" OFF**. (On hosted this blocks self-signup but
  still allows the seeded accounts to log in — different from local.)
- Create the two accounts:
```bash
SUPABASE_URL="https://<REF>.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="<service_role key>" \
ADMIN_EMAIL="admin@yourdomain.com"  ADMIN_PASS="<strong>" \
TRADER_EMAIL="friend@yourdomain.com" TRADER_PASS="<strong>" \
node scripts/seed.mjs
```

---

## B. Vercel (the web app)

### 6. Push the code to GitHub
```bash
git add -A
git commit -m "Halyard: gold signal verifier"
gh repo create halyard --private --source=. --push   # or create on github.com + git push
```

### 7. Import into Vercel
- vercel.com → **Add New → Project** → import the `halyard` repo.
- Framework preset: **Next.js** (auto-detected). Leave build/output defaults.

### 8. Set environment variables (Vercel → Project → Settings → Environment Variables)
| Name | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<REF>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the `anon` key |
| `SUPABASE_SERVICE_ROLE_KEY` | the `service_role` key |
| `BINANCE_PRICE_URL` | `https://data-api.binance.vision/api/v3/ticker/price?symbol=PAXGUSDT` |
| `BINANCE_API_KEY` | your Binance key (server-side; for the bot side) |
| `BINANCE_API_SECRET` | your Binance secret (server-side; for the bot side) |

Add them for **Production** (and Preview if you want). Then **Deploy**.

### 9. Point Supabase auth at the live domain
Dashboard → **Authentication → URL Configuration**:
- **Site URL**: `https://<your-app>.vercel.app`
- **Redirect URLs**: add `https://<your-app>.vercel.app/**`

---

## C. Verify production
1. Visit `https://<your-app>.vercel.app` → redirected to `/login`.
2. Log in as the trader → post a signal.
3. Within a minute the verifier runs; once price hits TP/SL it closes.
4. Log in as admin → Trust Score, equity curve, signals, CSV, public link.

Check the verifier ran:
```sql
select * from cron.job_run_details order by start_time desc limit 5;
select * from public.price_cache;     -- price + fetched_at should be recent
```

---

## C. Telegram ingester (read-only background worker)

Pulls gold signals from the Gold VIP Telegram channel into Halyard, attributed
to a dedicated `gold_vip` trader, so the verifier tracks them. It is a **long-
running listener** — it does NOT fit Vercel/Supabase (no always-on process), so
it runs as a tiny worker on Railway or Render.

### 1. Generate the session (once, on your machine)
```bash
npm run tg:login        # enter phone + the code Telegram sends (+ 2FA if set)
```
Copy the printed `TELEGRAM_SESSION=...` value — you'll paste it into the host's
env vars (it's a secret; never commit it).

### 2. Deploy the worker
Push the repo to GitHub, then:
- **Railway** → New Project → Deploy from repo. Railway reads `railway.json`
  (start command `node scripts/telegram-ingest.mjs`). Add the env vars below.
- **Render** → New → Blueprint → pick the repo. Render reads `render.yaml`
  (a `worker` service). Fill the `sync: false` secrets in the dashboard.

Env vars the worker needs:
```
TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION   (secret)
TELEGRAM_CHANNEL = Gold VIP signal                     (title, @username, or id)
NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY    (secret)
BINANCE_PRICE_URL                                       (the PAXGUSDT ticker)
```

The worker backfills the last 50 messages on boot, then listens live; it never
sends anything to Telegram, and inserts are idempotent (a dedup index on
`(source, source_ref)`). To import history only: `node scripts/telegram-ingest.mjs --backfill 200 --no-listen`.

Note: a 24/7 worker isn't truly free anywhere — Railway runs on a small monthly
usage credit; Render workers are a cheap paid instance. The web app stays on
Vercel free; only this worker needs the host.

---

## D. Trade executor — copy signals onto MetaTrader 5

Two ways to turn ingested signals into real MT5 orders. Both size by **risk %**,
place up to 3 orders (TP1/TP2/TP3 + shared SL), move SL to breakeven after TP1,
and record every signal in `executions` (never traded twice). Start on a **demo
account** with `DRY_RUN=true`.

**Option 1 — No Windows (recommended): MetaApi + Linux.**
`scripts/metaapi-executor.mjs` runs on any Linux box (e.g. Oracle Always-Free),
talking to your MT5 account through [metaapi.cloud](https://metaapi.cloud) — no
Windows VM, no local terminal.
1. Sign up at metaapi.cloud, add your MT5 **demo** account, copy the **token** and
   **account id**.
2. Put `METAAPI_TOKEN`, `METAAPI_ACCOUNT_ID` (+ the executor tuning vars) in
   `.env.local` (see `.env.local.example`).
3. `npm install && npm run execute` (keep `DRY_RUN=true` until the sizing looks
   right, then set `DRY_RUN=false`).

**Option 2 — Self-hosted on Windows: `mt5/executor.py`.**
A Windows VPS running the MT5 terminal + the official `MetaTrader5` Python lib.
See `mt5/README.md`. Full control, no third-party, but you run a Windows box.

---

## Notes / hardening
- The 10/day cap, anti-cheat entry, and TP/SL verification are all enforced in
  Postgres — they hold in production exactly as locally.
- The daily cap resets at the **trader's local midnight**. The browser timezone
  is auto-detected and stored on the profile (no input needed); it falls back to
  UTC until detected.
- Free tier: Supabase pauses a project after ~1 week of inactivity; the cron job
  keeps it active. Vercel Hobby cron can't run every minute, which is why the
  verifier lives in Supabase (pg_cron), not Vercel.
- Rotate the seeded passwords after first login.
