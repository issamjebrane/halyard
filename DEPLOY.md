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

### 2. Push the schema (creates tables, RLS, the engine, the 5/day cap)
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

## Notes / hardening
- The 5/day cap, anti-cheat entry, and TP/SL verification are all enforced in
  Postgres — they hold in production exactly as locally.
- The daily cap resets at the **trader's local midnight**. The browser timezone
  is auto-detected and stored on the profile (no input needed); it falls back to
  UTC until detected.
- Free tier: Supabase pauses a project after ~1 week of inactivity; the cron job
  keeps it active. Vercel Hobby cron can't run every minute, which is why the
  verifier lives in Supabase (pg_cron), not Vercel.
- Rotate the seeded passwords after first login.
