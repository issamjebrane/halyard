-- Audit follow-ups (all additive / safe):
--
-- 1) Drop the unused legacy single-price verifier overload. The active engine is
--    run_verification(p_high,p_low,p_close) (RATCHET OHLC); the 1-arg version is
--    dead but a latent footgun (a stray manual call would close real signals with
--    the inferior single-price logic). Nothing references it.
drop function if exists public.run_verification(double precision);

-- 2) REAL account P&L. The signal track record (result_r) is the signal's
--    theoretical outcome graded on the gold price feed; it can diverge from what
--    the EA actually did on the broker. Snapshot the broker balance whenever the
--    EA's heartbeat reports a change (i.e. a trade closed) so the dashboard can
--    show the account's REAL realized equity curve. No EA change required — the
--    heartbeat already upserts balance into mt5_status.
create table if not exists public.account_balance_history (
  id             bigint generated always as identity primary key,
  account        text,
  balance        double precision,
  equity         double precision,
  open_positions int,
  recorded_at    timestamptz not null default now()
);
create index if not exists abh_recorded_idx on public.account_balance_history (id);

alter table public.account_balance_history enable row level security;
drop policy if exists "abh admin read" on public.account_balance_history;
create policy "abh admin read" on public.account_balance_history
  for select to authenticated using (public.is_admin());

create or replace function public.snapshot_balance()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- record only when realized balance changes (a close), or on the first row
  if tg_op = 'INSERT' or new.balance is distinct from old.balance then
    insert into public.account_balance_history(account, balance, equity, open_positions)
      values (new.account, new.balance, new.equity, new.open_positions);
  end if;
  return new;
end; $$;

drop trigger if exists snapshot_balance_tg on public.mt5_status;
create trigger snapshot_balance_tg
  after insert or update on public.mt5_status
  for each row execute function public.snapshot_balance();

-- seed the first point from the current heartbeat so the curve has a baseline
insert into public.account_balance_history(account, balance, equity, open_positions)
  select account, balance, equity, open_positions from public.mt5_status where id = 1;

-- stream changes to the live dashboard (admin-only via RLS)
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public'
          and tablename = 'account_balance_history')
  then
    execute 'alter publication supabase_realtime add table public.account_balance_history';
  end if;
end $$;
