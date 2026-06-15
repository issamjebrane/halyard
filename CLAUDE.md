@AGENTS.md

# Halyard

A signal "tape" today. A bot-instance launcher tomorrow. Treat the schema and
naming as generic enough to survive that pivot.

## Conventions

- Dev port is **3003**. `npm run dev` and `npm run start` both bind to it.
- Tone: lowercase labels, terse copy, no emoji, no gradients.
- Numbers always render in `font-mono` with tabular figures.
- Direction is stored lowercase: `buy` or `sell`.
- Vocabulary in code mirrors the UI:
  - posts → `transmissions` (table + action names)
  - the feed page → `/` aka "the tape"
  - the post page → `/compose`, the verb is "raise"
  - log in → "enter", log out → "leave"

## Stack

- Next.js 16 (App Router) — read `node_modules/next/dist/docs/` before editing
- Supabase (auth + Postgres) wired via `@supabase/ssr`
- Tailwind v4 with a small palette declared in `app/globals.css`
- No third-party UI library; components are hand-rolled and minimal

## Layout

```
app/
  page.tsx              — the tape (public, dynamic)
  layout.tsx            — root + nav (session-aware)
  login/                — /login (form is a client island)
  compose/              — /compose (auth-gated server component + form)
  actions/              — server actions (auth + transmissions)
lib/
  supabase/{server,client,proxy,session}.ts
  types.ts              — shared `Transmission` type
proxy.ts                — runs the supabase session refresh (Next 16 renamed
                          middleware → proxy; nodejs runtime only)
supabase/schema.sql     — table + RLS policies, run once in the dashboard
```

## Adding bot instances later

Reuse the `auth.users` table. Add a `rigs` (or `instances`) table keyed by
`user_id`, with config columns for the bot side. Keep the `transmissions`
table as the source of truth signals are read from.

## Ops — production-direct, NO Docker

This project does not use the Supabase local stack or any Docker container.
Operate everything against the hosted project:

- **SQL / engine checks:** `./scripts/psql-prod.sh -f <file.sql>` connects to the
  prod pooler (creds from `.env.local`). Verify engine changes with a **ROLLBACK**
  transaction so nothing persists — see `scripts/ratchet-verify.sql`. Never run
  crafted test prices through `run_verification` outside a rollback: it would
  close real open signals.
- **Migrations:** `supabase db push`. **Edge function:** `supabase functions
  deploy verify --no-verify-jwt`. Neither needs Docker.
- `supabase/config.toml` is the Supabase CLI config (used by `db push` /
  `functions deploy`); it only launches Docker if you run `supabase start`, which
  we never do.

## Exit logic — RATCHET

The verifier closes on a trailing-stop ladder, not at TP1
(`docs/ESTRATEGIA_SIMON_INGENIERO.md`, `supabase/migrations/*_ratchet.sql`):
TP1→SL to entry (break-even), TP2→SL to TP1, final TP→close (win), current SL→close,
72h max hold. `run_verification(high, low, close)` evaluates on 1-minute candle
high/low. Break-even is its own `status` (0R, neither win nor loss).
