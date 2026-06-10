-- Follow-up to 20260605090000_event_tape.sql. Two event-tape fidelity fixes
-- surfaced by an adversarial audit; no change to the win/loss + result_r
-- accounting (still TP1 vs SL, SL priority), so trust/equity/metrics stay
-- byte-identical. The prior migration is immutable (already applied); these
-- corrections ship as create-or-replace.
--
-- FIX 1 (run_verification): the 'settled' event recorded r_at_event from
--   s.result_r, which is still NULL on the tick an outcome is decided (the
--   UPDATE writes result_r afterwards). Every loss settles same-tick, so every
--   loss's settled event lost its R. Now uses coalesce(s.result_r, v_r): for a
--   row that closed on an earlier tick s.result_r is populated; for a same-tick
--   close v_r holds the freshly computed value. v_r/v_exit/v_pips/v_gain are now
--   reset per iteration so a stale value from a prior row can never leak in.
--
-- FIX 2 (post_signal): market orders are created already 'open', so they never
--   pass through the pending->open activation loop and never got an 'activated'
--   tape event (pending orders did). post_signal now writes that event itself
--   and seeds the MFE/MAE baseline + track_until, mirroring loop-A activation,
--   so a market order's tape reads [activated, ...] like a pending order's.

-- ---------------------------------------------------------------------------
-- run_verification — FIX 1 + clarifying comments. Logic otherwise identical to
-- 20260605090000.
-- ---------------------------------------------------------------------------
create or replace function public.run_verification(p_price double precision)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s            record;
  lo           double precision;
  hi           double precision;
  fav          double precision;
  adv          double precision;
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
  highest_tp   double precision;
  pip_size     constant double precision := 0.10;
  track_window constant interval   := interval '7 days';
begin
  if p_price is null or p_price <= 0 then
    return;
  end if;

  -- A) Activate pending orders when price crosses the entry. (skip locked: two
  --    overlapping cron ticks never double-process / double-emit events for the
  --    same row; worst case a row is left for the next tick, one cycle later.)
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

  -- B) Observe open + closed-but-unsettled rows. One UPDATE per row per tick.
  for s in
    select * from public.signals
    where status = 'open'
       or (status in ('won','lost') and settled_at is null)
    for update skip locked
  loop
    -- Reset the close-locals each iteration so a stale value from the previous
    -- row can never leak into this row's settled-event R (see FIX 1).
    v_exit := null; v_r := null; v_pips := null; v_gain := null;

    lo := least(s.last_seen_price, p_price);
    hi := greatest(s.last_seen_price, p_price);

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
      v_mfe   := greatest(coalesce(v_mfe, fav), fav);
      v_mae   := least   (coalesce(v_mae, adv), adv);
      v_mfe_r := (v_mfe - s.entry_price) / v_risk;
      v_mae_r := (v_mae - s.entry_price) / v_risk;
    else
      v_mfe   := least   (coalesce(v_mfe, fav), fav);
      v_mae   := greatest(coalesce(v_mae, adv), adv);
      v_mfe_r := (s.entry_price - v_mfe) / v_risk;
      v_mae_r := (s.entry_price - v_mae) / v_risk;
    end if;

    -- Level crossings within this tick (direction-aware). Multiple targets can
    -- be crossed in a single tick when price gaps; each is stamped and emitted
    -- independently and peak_tp ends at the highest reached.
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
    if sl_hit and v_sl_at is null then
      v_sl_at := now();
      insert into public.signal_events (signal_id, kind, price, r_at_event)
      values (s.id, 'sl_hit', s.stop_loss,
              (case when s.direction = 'buy' then s.stop_loss - s.entry_price
                    else s.entry_price - s.stop_loss end) / v_risk);
    end if;

    -- OUTCOME — only for rows still 'open'. IDENTICAL accounting to three_tps:
    -- decided by TP1 vs SL, SL priority.
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

    -- SETTLE — loss, OR highest provided target reached, OR deadline passed.
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
              -- FIX 1: prefer the persisted result_r (row closed on an earlier
              -- tick); fall back to v_r (row closed on THIS tick, result_r not
              -- yet written). v_r is reset per iteration so it's never stale.
              case when v_status in ('won','lost') then coalesce(s.result_r, v_r) else null end);
    end if;

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
           track_until = coalesce(s.track_until, s.activated_at + track_window, now() + track_window),
           settled_at  = coalesce(s.settled_at, v_settle)
     where id = s.id;
  end loop;
end;
$$;

revoke execute on function public.run_verification(double precision) from public;
grant  execute on function public.run_verification(double precision) to service_role;

-- ---------------------------------------------------------------------------
-- post_signal — FIX 2. Same signature/validation/anti-cheat as three_tps; the
-- only changes are (a) seeding MFE/MAE baseline + track_until for market orders
-- and (b) writing the 'activated' tape event for them.
-- ---------------------------------------------------------------------------
create or replace function public.post_signal(
  p_direction   text,
  p_order_type  text,
  p_stop_loss   double precision,
  p_tp1         double precision,
  p_tp2         double precision,
  p_tp3         double precision,
  p_entry_in    double precision,
  p_live        double precision,
  p_note        text
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  uid        uuid := auth.uid();
  uname      text;
  is_trader  boolean;
  v_entry    double precision;
  v_status   text;
  v_act      timestamptz;
  v_last     double precision;
  v_risk     double precision;
  v_rr       double precision;
  sid        bigint;
  v_today    int;
  v_mfe      double precision;   -- MFE/MAE baseline (market only; null for pending)
  v_track    timestamptz;        -- tracking window (market only)
  min_dist   constant double precision := 0.05;
  daily_cap  constant int := 5;
  track_window constant interval := interval '7 days';
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  select p.username, (p.role = 'trader')
    into uname, is_trader
    from public.profiles p where p.id = uid;

  if not coalesce(is_trader, false) then
    raise exception 'only traders can post signals';
  end if;

  select count(*) into v_today
    from public.signals
   where trader_id = uid
     and created_at >= public.day_start(uid);

  if v_today >= daily_cap then
    raise exception 'daily limit reached: % signals per day', daily_cap
      using errcode = 'P0001';
  end if;

  if p_direction not in ('buy','sell') or p_order_type not in ('market','pending') then
    raise exception 'invalid direction or order type';
  end if;
  if p_live is null or p_live <= 0 then
    raise exception 'live price unavailable';
  end if;
  if p_stop_loss is null or p_tp1 is null then
    raise exception 'stop loss and TP1 are required';
  end if;

  if p_order_type = 'market' then
    v_entry := p_live;
  else
    v_entry := p_entry_in;
    if v_entry is null then
      raise exception 'entry price is required for pending orders';
    end if;
    if abs(v_entry - p_live) < min_dist then
      raise exception 'pending entry is too close to the current price';
    end if;
  end if;

  if p_direction = 'buy' then
    if not (p_stop_loss < v_entry and v_entry < p_tp1) then
      raise exception 'buy requires SL < entry < TP1';
    end if;
    if p_tp2 is not null and not (p_tp2 > p_tp1) then
      raise exception 'TP2 must be greater than TP1 for a buy';
    end if;
    if p_tp3 is not null then
      if p_tp2 is null then raise exception 'set TP2 before TP3'; end if;
      if not (p_tp3 > p_tp2) then raise exception 'TP3 must be greater than TP2 for a buy'; end if;
    end if;
  else
    if not (p_tp1 < v_entry and v_entry < p_stop_loss) then
      raise exception 'sell requires TP1 < entry < SL';
    end if;
    if p_tp2 is not null and not (p_tp2 < p_tp1) then
      raise exception 'TP2 must be lower than TP1 for a sell';
    end if;
    if p_tp3 is not null then
      if p_tp2 is null then raise exception 'set TP2 before TP3'; end if;
      if not (p_tp3 < p_tp2) then raise exception 'TP3 must be lower than TP2 for a sell'; end if;
    end if;
  end if;

  v_risk := abs(v_entry - p_stop_loss);
  if v_risk <= 0 then
    raise exception 'risk must be greater than zero';
  end if;
  v_rr := abs(p_tp1 - v_entry) / v_risk;

  if p_order_type = 'market' then
    -- Opens immediately; seed the tracking baseline so it never relies on the
    -- first verification tick and mirrors loop-A activation.
    v_status := 'open'; v_act := now(); v_last := v_entry;
    v_mfe := v_entry; v_track := now() + track_window;
  else
    v_status := 'pending'; v_act := null; v_last := p_live;
    v_mfe := null; v_track := null;  -- seeded by run_verification on activation
  end if;

  insert into public.signals (
    trader_id, symbol, direction, order_type, entry_price, stop_loss,
    tp1, tp2, tp3, status, market_price_at_create, last_seen_price,
    risk_per_unit, rr_planned, note, activated_at,
    mfe_price, mae_price, mfe_r, mae_r, track_until
  ) values (
    uid, 'XAUUSD', p_direction, p_order_type, v_entry, p_stop_loss,
    p_tp1, p_tp2, p_tp3, v_status, p_live, v_last,
    v_risk, v_rr, nullif(left(coalesce(p_note, ''), 300), ''), v_act,
    v_mfe, v_mfe,
    case when p_order_type = 'market' then 0 else null end,
    case when p_order_type = 'market' then 0 else null end,
    v_track
  )
  returning id into sid;

  -- Market orders skip the pending->open activation loop, so emit their
  -- 'activated' tape event here (pending orders get it from run_verification).
  if p_order_type = 'market' then
    insert into public.signal_events (signal_id, kind, price, r_at_event)
    values (sid, 'activated', v_entry, 0);
  end if;

  insert into public.notifications (type, signal_id, message)
  values (
    'signal_new', sid,
    format('#%s %s %s @ %s (SL %s / TP1 %s)', sid, p_direction, p_order_type,
           round(v_entry::numeric, 2), round(p_stop_loss::numeric, 2),
           round(p_tp1::numeric, 2))
  );

  insert into public.audit_log (user_id, username, action, details)
  values (uid, uname, 'signal_created',
          format('#%s %s %s @ %s', sid, p_direction, p_order_type,
                 round(v_entry::numeric, 2)));

  return sid;
end;
$$;

grant execute on function public.post_signal(
  text, text, double precision, double precision, double precision,
  double precision, double precision, double precision, text) to authenticated;
