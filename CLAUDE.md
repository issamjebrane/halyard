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
