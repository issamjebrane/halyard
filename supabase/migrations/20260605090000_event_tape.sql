-- Event tape: capture every detail the engine ("Simon") observes about a signal,
-- WITHOUT changing the win/loss + result_r accounting. The outcome is still
-- decided by TP1 vs SL (SL priority); lib/metrics.ts reads only
-- status/result_r/closed_at/id/direction on won|lost rows, so the trust score,
-- equity curve and metrics stay byte-identical. Everything else is pure,
-- additive observation: per-level hit times/prices, max favorable/adverse
-- excursion, and a forward-only per-signal event log. post_signal is untouched.

-- ---------------------------------------------------------------------------
-- 1) Additive tracking columns on public.signals (all nullable / defaulted)
-- ---------------------------------------------------------------------------
alter table public.signals
  add column if not exists tp1_hit_at    timestamptz,
  add column if not exists tp1_hit_price double precision,
  add column if not exists tp2_hit_at    timestamptz,
  add column if not exists tp2_hit_price double precision,
  add column if not exists tp3_hit_at    timestamptz,
  add column if not exists tp3_hit_price double precision,
  add column if not exists sl_hit_at     timestamptz,
  add column if not exists peak_tp       int not null default 0,  -- highest target reached: 0/1/2/3
  add column if not exists mfe_price     double precision,        -- max favorable excursion (raw price)
  add column if not exists mae_price     double precision,        -- max adverse excursion (raw price)
  add column if not exists mfe_r         double precision,        -- MFE in R (>= 0)
  add column if not exists mae_r         double precision,        -- MAE in R (<= 0)
  add column if not exists settled_at    timestamptz,             -- NULL while the engine still observes
  add column if not exists track_until   timestamptz;             -- post-outcome observation deadline

-- Hot path for the observation loop (open OR closed-but-unsettled).
create index if not exists signals_observing_idx
  on public.signals (id)
  where status = 'open' or (status in ('won','lost') and settled_at is null);

-- ---------------------------------------------------------------------------
-- 2) signal_events — one row per discrete engine action ("the tape")
-- ---------------------------------------------------------------------------
create table if not exists public.signal_events (
  id          bigint generated always as identity primary key,
  signal_id   bigint not null references public.signals(id) on delete cascade,
  kind        text not null check (kind in (
                'activated','tp1_hit','tp2_hit','tp3_hit','sl_hit',
                'closed','settled','price_extreme')),
  price       double precision,
  r_at_event  double precision,
  created_at  timestamptz not null default now()
);

create index if not exists signal_events_signal_idx
  on public.signal_events (signal_id, id);

alter table public.signal_events enable row level security;

-- Mirror the signals SELECT policy: a trader sees events for their own signals,
-- admin sees all. The public share page reads via service_role (bypasses RLS),
-- so this restrictive read-only policy is sufficient. No write policy: only
-- run_verification (security definer / service_role) ever inserts here.
drop policy if exists "signal_events own/admin read" on public.signal_events;
create policy "signal_events own/admin read" on public.signal_events
  for select to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.signals s
      where s.id = signal_events.signal_id
        and s.trader_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- 3) Backfill — existing closed rows must NOT be re-observed forever, and we
--    reconstruct what we reliably know (TP1/SL stamps, peak_tp) from history.
-- ---------------------------------------------------------------------------

-- 3a) Settle every already-closed row at its close time.
update public.signals
   set settled_at  = coalesce(closed_at, now()),
       track_until = coalesce(track_until, closed_at, now())
 where status in ('won','lost') and settled_at is null;

-- 3b) Won rows reached at least TP1; stamp TP1 from the close, peak_tp >= 1.
--     (TP2/TP3 were never evaluated historically -> cannot claim they were hit.)
update public.signals
   set tp1_hit_at    = coalesce(tp1_hit_at, closed_at),
       tp1_hit_price = coalesce(tp1_hit_price, exit_price, tp1),
       peak_tp       = greatest(peak_tp, 1)
 where status = 'won';

-- 3c) Lost rows -> stamp SL.
update public.signals
   set sl_hit_at = coalesce(sl_hit_at, closed_at)
 where status = 'lost';

-- 3d) Currently-open rows: seed a tracking window + baseline MFE/MAE so the
--     next tick behaves correctly.
update public.signals
   set track_until = coalesce(track_until, coalesce(activated_at, now()) + interval '7 days'),
       mfe_price   = coalesce(mfe_price, last_seen_price),
       mae_price   = coalesce(mae_price, last_seen_price),
       mfe_r       = coalesce(mfe_r, 0),
       mae_r       = coalesce(mae_r, 0)
 where status = 'open';

-- ---------------------------------------------------------------------------
-- 4) run_verification — rewritten engine.
--    The OUTCOME block (status/closed_at/exit_price/result_pips/result_r + the
--    signal_closed notification & audit rows) is copy-identical to the
--    three_tps version and gated by `status = 'open'`, so closed rows never
--    re-write their metrics columns. Everything else is additive observation.
-- ---------------------------------------------------------------------------
create or replace function public.run_verification(p_price double precision)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s            record;
  lo           double precision;   -- min(last_seen, p_price) over this tick
  hi           double precision;   -- max(last_seen, p_price) over this tick
  fav          double precision;   -- most-favorable price seen this tick
  adv          double precision;   -- most-adverse price seen this tick
  v_mfe        double precision;
  v_mae        double precision;
  v_mfe_r      double precision;
  v_mae_r      double precision;
  v_peak       int;
  v_settle     timestamptz;
  v_t1_at      timestamptz; v_t1_px double precision;
  v_t2_at      timestamptz; v_t2_px double precision;
  v_t3_at      timestamptz; v_t3_px double precision;
  v_sl_at      timestamptz;
  v_status     text;
  v_closed_at  timestamptz;
  v_exit       double precision;
  v_risk       double precision;
  v_gain       double precision;
  v_r          double precision;
  v_pips       double precision;
  hit1         boolean;
  hit2         boolean;
  hit3         boolean;
  sl_hit       boolean;
  tp1_close    boolean;
  highest_tp   double precision;   -- highest provided target (for the settle test)
  pip_size     constant double precision := 0.10;
  track_window constant interval   := interval '7 days';
begin
  if p_price is null or p_price <= 0 then
    return;
  end if;

  -- =======================================================================
  -- A) Activate pending orders when price crosses the entry. Seed the
  --    tracking window + MFE/MAE baseline and write an 'activated' event.
  --    last_seen_price advances exactly once per pending row here.
  -- =======================================================================
  for s in
    select * from public.signals where status = 'pending'
    for update skip locked
  loop
    lo := least(s.last_seen_price, p_price);
    hi := greatest(s.last_seen_price, p_price);

    if s.entry_price >= lo and s.entry_price <= hi then
      update public.signals
         set status          = 'open',
             activated_at     = now(),
             last_seen_price  = s.entry_price,
             track_until      = now() + track_window,
             mfe_price        = s.entry_price,
             mae_price        = s.entry_price,
             mfe_r            = 0,
             mae_r            = 0,
             peak_tp          = 0
       where id = s.id;

      insert into public.signal_events (signal_id, kind, price, r_at_event)
      values (s.id, 'activated', s.entry_price, 0);

      insert into public.audit_log (user_id, username, action, details)
      values (null, 'system', 'signal_activated',
              format('signal %s activated at %s', s.id, round(s.entry_price::numeric, 2)));
    else
      update public.signals set last_seen_price = p_price where id = s.id;
    end if;
  end loop;

  -- =======================================================================
  -- B) Observe every row the engine still cares about: open (pre-outcome)
  --    plus won|lost rows that aren't settled yet (post-outcome). Rows
  --    activated in (A) this tick are now 'open' with last_seen = entry, so
  --    they get their first observation here too. One UPDATE per row per tick.
  -- =======================================================================
  for s in
    select * from public.signals
    where status = 'open'
       or (status in ('won','lost') and settled_at is null)
    for update skip locked
  loop
    lo := least(s.last_seen_price, p_price);
    hi := greatest(s.last_seen_price, p_price);

    -- Direction-aware favorable / adverse extremes within this tick.
    if s.direction = 'buy' then
      fav := hi; adv := lo;
    else
      fav := lo; adv := hi;
    end if;

    v_risk := coalesce(nullif(s.risk_per_unit, 0), pip_size);

    -- MFE / MAE (raw price + R), monotonic, including this tick.
    v_mfe := s.mfe_price;
    v_mae := s.mae_price;
    if s.direction = 'buy' then
      v_mfe   := greatest(coalesce(v_mfe, fav), fav);  -- best  = highest price
      v_mae   := least   (coalesce(v_mae, adv), adv);  -- worst = lowest price
      v_mfe_r := (v_mfe - s.entry_price) / v_risk;
      v_mae_r := (v_mae - s.entry_price) / v_risk;
    else
      v_mfe   := least   (coalesce(v_mfe, fav), fav);  -- best  = lowest price
      v_mae   := greatest(coalesce(v_mae, adv), adv);  -- worst = highest price
      v_mfe_r := (s.entry_price - v_mfe) / v_risk;
      v_mae_r := (s.entry_price - v_mae) / v_risk;
    end if;

    -- Level crossings within this tick (direction-aware).
    if s.direction = 'buy' then
      hit1   := hi >= s.tp1;
      hit2   := s.tp2 is not null and hi >= s.tp2;
      hit3   := s.tp3 is not null and hi >= s.tp3;
      sl_hit := lo <= s.stop_loss;
    else
      hit1   := lo <= s.tp1;
      hit2   := s.tp2 is not null and lo <= s.tp2;
      hit3   := s.tp3 is not null and lo <= s.tp3;
      sl_hit := hi >= s.stop_loss;
    end if;

    v_peak  := s.peak_tp;
    v_t1_at := s.tp1_hit_at; v_t1_px := s.tp1_hit_price;
    v_t2_at := s.tp2_hit_at; v_t2_px := s.tp2_hit_price;
    v_t3_at := s.tp3_hit_at; v_t3_px := s.tp3_hit_price;
    v_sl_at := s.sl_hit_at;

    -- First-time TP stamps (idempotent: only when not already set).
    if hit1 and v_t1_at is null then
      v_t1_at := now(); v_t1_px := s.tp1; v_peak := greatest(v_peak, 1);
      insert into public.signal_events (signal_id, kind, price, r_at_event)
      values (s.id, 'tp1_hit', s.tp1,
              (case when s.direction = 'buy' then s.tp1 - s.entry_price
                    else s.entry_price - s.tp1 end) / v_risk);
    end if;
    if hit2 and v_t2_at is null then
      v_t2_at := now(); v_t2_px := s.tp2; v_peak := greatest(v_peak, 2);
      insert into public.signal_events (signal_id, kind, price, r_at_event)
      values (s.id, 'tp2_hit', s.tp2,
              (case when s.direction = 'buy' then s.tp2 - s.entry_price
                    else s.entry_price - s.tp2 end) / v_risk);
    end if;
    if hit3 and v_t3_at is null then
      v_t3_at := now(); v_t3_px := s.tp3; v_peak := greatest(v_peak, 3);
      insert into public.signal_events (signal_id, kind, price, r_at_event)
      values (s.id, 'tp3_hit', s.tp3,
              (case when s.direction = 'buy' then s.tp3 - s.entry_price
                    else s.entry_price - s.tp3 end) / v_risk);
    end if;
    -- First-time SL stamp.
    if sl_hit and v_sl_at is null then
      v_sl_at := now();
      insert into public.signal_events (signal_id, kind, price, r_at_event)
      values (s.id, 'sl_hit', s.stop_loss,
              (case when s.direction = 'buy' then s.stop_loss - s.entry_price
                    else s.entry_price - s.stop_loss end) / v_risk);
    end if;

    -- ===================================================================
    -- OUTCOME — only for rows still 'open'. IDENTICAL to three_tps:
    -- decided by TP1 vs SL, SL priority, exit/pips/R computed the same.
    -- ===================================================================
    v_status    := s.status;
    v_closed_at := s.closed_at;

    if s.status = 'open' then
      tp1_close := hit1;
      if sl_hit then
        v_status := 'lost'; v_exit := s.stop_loss;
      elsif tp1_close then
        v_status := 'won';  v_exit := s.tp1;
      else
        v_status := 'open'; v_exit := null;
      end if;

      if v_status <> 'open' then
        v_closed_at := now();
        if s.direction = 'buy' then
          v_gain := v_exit - s.entry_price;
        else
          v_gain := s.entry_price - v_exit;
        end if;
        v_r    := case when v_risk <> 0 then v_gain / v_risk else 0 end;
        v_pips := v_gain / pip_size;

        insert into public.notifications (type, signal_id, message)
        values ('signal_closed', s.id,
                format('#%s %s -> %s (%sR)', s.id, s.direction, v_status,
                       round(v_r::numeric, 2)));
        insert into public.audit_log (user_id, username, action, details)
        values (null, 'system', 'signal_closed',
                format('#%s %s -> %s (%sR)', s.id, s.direction, v_status,
                       round(v_r::numeric, 2)));
        insert into public.signal_events (signal_id, kind, price, r_at_event)
        values (s.id, 'closed', v_exit, v_r);
      end if;
    end if;

    -- ===================================================================
    -- SETTLE — stop observing when: outcome is a loss (SL hit, nothing
    -- left to track), OR the highest provided target has been reached, OR
    -- the deadline passed. Write exactly one 'settled' event.
    -- ===================================================================
    highest_tp := coalesce(s.tp3, s.tp2, s.tp1);
    v_settle := null;
    if v_status = 'lost' then
      v_settle := now();
    elsif s.direction = 'buy'  and v_mfe >= highest_tp then
      v_settle := now();
    elsif s.direction = 'sell' and v_mfe <= highest_tp then
      v_settle := now();
    elsif s.track_until is not null and now() > s.track_until then
      v_settle := now();
    end if;

    if v_settle is not null and s.settled_at is null then
      insert into public.signal_events (signal_id, kind, price, r_at_event)
      values (s.id, 'settled', p_price,
              case when v_status in ('won','lost') then s.result_r else null end);
    end if;

    -- Single write per row: advance last_seen_price exactly once. Outcome
    -- columns change only on the closing tick (guarded), otherwise retained.
    update public.signals
       set last_seen_price = p_price,
           mfe_price       = v_mfe,
           mae_price       = v_mae,
           mfe_r           = v_mfe_r,
           mae_r           = v_mae_r,
           peak_tp         = v_peak,
           tp1_hit_at      = v_t1_at, tp1_hit_price = v_t1_px,
           tp2_hit_at      = v_t2_at, tp2_hit_price = v_t2_px,
           tp3_hit_at      = v_t3_at, tp3_hit_price = v_t3_px,
           sl_hit_at       = v_sl_at,
           status      = v_status,
           closed_at   = case when s.status = 'open' and v_status <> 'open'
                              then v_closed_at else s.closed_at end,
           exit_price  = case when s.status = 'open' and v_status <> 'open'
                              then v_exit else s.exit_price end,
           result_pips = case when s.status = 'open' and v_status <> 'open'
                              then v_pips else s.result_pips end,
           result_r    = case when s.status = 'open' and v_status <> 'open'
                              then v_r else s.result_r end,
           -- Backstop: future market orders open in post_signal without an
           -- activation event, so they never visit loop A. Ensure they always
           -- carry a deadline once observed here.
           track_until = coalesce(s.track_until, s.activated_at + track_window, now() + track_window),
           settled_at  = coalesce(s.settled_at, v_settle)
     where id = s.id;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Grants
-- ---------------------------------------------------------------------------
revoke execute on function public.run_verification(double precision) from public;
grant  execute on function public.run_verification(double precision) to service_role;

grant select on public.signal_events to authenticated;
