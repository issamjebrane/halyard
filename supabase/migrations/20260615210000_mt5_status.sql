-- Live MT5 engine status: a single row the EA upserts every poll. Three jobs:
--   1) heartbeat  — updated_at tells the dashboard the EA is alive
--   2) accurate price — bid/ask is the BROKER's real XAUUSD (the verifier anchors
--      its PAXG proxy to this so the paper record matches what actually trades)
--   3) at-a-glance state — equity / balance / open positions
-- The EA writes with the service role (bypasses RLS); admins read it in the app.

create table if not exists public.mt5_status (
  id              int primary key default 1,
  account         text,
  symbol          text,
  bid             double precision,
  ask             double precision,
  open_positions  int,
  equity          double precision,
  balance         double precision,
  updated_at      timestamptz not null default now(),
  constraint mt5_status_singleton check (id = 1)
);

insert into public.mt5_status (id) values (1) on conflict (id) do nothing;

-- stamp updated_at on every upsert/update so heartbeat freshness is server-authoritative
create or replace function public.touch_mt5_status()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists mt5_status_touch on public.mt5_status;
create trigger mt5_status_touch before update on public.mt5_status
  for each row execute function public.touch_mt5_status();

alter table public.mt5_status enable row level security;
drop policy if exists "mt5_status admin read" on public.mt5_status;
create policy "mt5_status admin read" on public.mt5_status
  for select to authenticated using (public.is_admin());
grant select on public.mt5_status to authenticated;
