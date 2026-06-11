-- Execution ledger: one row per signal the MT5 executor acts on, so trading is
-- idempotent across restarts (a signal is never placed twice) and the result is
-- auditable from the app. The Python executor (service role) writes here; the
-- verifier and trust math never read it.

create table if not exists public.executions (
  id          bigint generated always as identity primary key,
  signal_id   bigint not null references public.signals(id) on delete cascade,
  account     text,                                   -- mt5 login / 'demo'
  status      text not null default 'placed'
                check (status in ('placed','breakeven','closed','error','skipped')),
  tickets     jsonb not null default '[]'::jsonb,     -- mt5 order tickets
  lots        double precision,                       -- total volume placed
  entry_fill  double precision,                       -- avg fill price
  detail      text,                                   -- skip reason / error
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- One execution per signal -> claiming a signal is atomic (insert ... unique).
create unique index if not exists executions_signal_key on public.executions (signal_id);
create index if not exists executions_status_idx on public.executions (status);

alter table public.executions enable row level security;

-- Admin-only read in the app; the executor uses the service role (bypasses RLS).
drop policy if exists "executions admin read" on public.executions;
create policy "executions admin read" on public.executions
  for select to authenticated using (public.is_admin());

grant select on public.executions to authenticated;
