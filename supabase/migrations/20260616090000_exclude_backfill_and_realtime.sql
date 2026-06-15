-- Two things, both additive and reversible:
--
-- 1) Exclude backfilled telegram signals from the track record / metrics.
--    These were historical channel messages ingested with an entry far from the
--    market price at ingest time, then graded against later prices — not real
--    forward-tracked trades. We FLAG them (excluded=true), never delete: the row
--    stays auditable and a single UPDATE reverses it. Simon's manual signals
--    (source is null) and genuinely forward-tracked telegram signals are left
--    alone. lib/metrics.ts skips excluded rows, so trust/equity/metrics reflect
--    only the real record.
--
-- 2) Add the live tables to the realtime publication so the admin / trader pages
--    stream changes instead of only updating on reload. RLS still gates which
--    rows each subscriber receives.

-- 1) backfill exclusion ------------------------------------------------------
alter table public.signals
  add column if not exists excluded boolean not null default false,
  add column if not exists excluded_reason text;

update public.signals
   set excluded = true,
       excluded_reason = 'backfill: entry far from market price at ingest'
 where source = 'telegram:gold_vip'
   and abs(entry_price - market_price_at_create) > 15
   and excluded = false;

-- 2) realtime publication ----------------------------------------------------
do $$
declare
  t text;
  tables text[] := array['signals','executions','mt5_status','signal_events','notifications'];
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  foreach t in array tables loop
    if to_regclass('public.' || t) is not null
       and not exists (
         select 1 from pg_publication_tables
          where pubname = 'supabase_realtime'
            and schemaname = 'public'
            and tablename = t
       )
    then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
