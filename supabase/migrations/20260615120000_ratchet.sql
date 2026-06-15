-- RATCHET exit (docs/ESTRATEGIA_SIMON_INGENIERO.md §1). Replaces the "close at
-- TP1" outcome with a trailing-stop ladder, evaluated on 1-minute candle
-- high/low instead of a single spot price:
--
--   open at market · SL = original · target = highest provided TP
--   hit TP1  -> move SL to ENTRY (break-even)
--   hit TP2  -> move SL to TP1   (partial locked)
--   hit final TP -> close 100% (win)
--   current SL hit -> close (loss / break-even / partial, per where the stop sits)
--   MAX_HOLD 72h  -> close at market
--
-- All the existing observation (peak_tp, per-level stamps, MFE/MAE, event tape,
-- settle window) is preserved. The only accounting change is result_r/status,
-- and break-even becomes its own closed outcome (0R — neither win nor loss).

-- 1) break-even status.
alter table public.signals drop constraint if exists signals_status_check;
alter table public.signals add constraint signals_status_check
  check (status in ('pending','open','won','lost','breakeven','cancelled'));

-- 2) The engine, evaluated on a 1-minute candle (high, low, close).
create or replace function public.run_verification(
  p_high  double precision,
  p_low   double precision,
  p_close double precision
)
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
  sl_raw       boolean;
  eff_stop     double precision;
  final_tp     double precision;
  stop_hit     boolean;
  target_hit   boolean;
  max_hold_due boolean;
  v_settle     timestamptz;
  pip_size     constant double precision := 0.10;
  track_window constant interval := interval '7 days';
  max_hold     constant interval := interval '72 hours';
begin
  if p_close is null or p_close <= 0 or p_high is null or p_low is null then
    return;
  end if;

  -- A) Activate pending orders when the candle's range covers the entry.
  for s in
    select * from public.signals where status = 'pending'
    for update skip locked
  loop
    if s.entry_price >= p_low and s.entry_price <= p_high then
      update public.signals
         set status='open', activated_at=now(), last_seen_price=s.entry_price,
             track_until=now()+track_window, mfe_price=s.entry_price,
             mae_price=s.entry_price, mfe_r=0, mae_r=0, peak_tp=0
       where id=s.id;
      insert into public.signal_events (signal_id, kind, price, r_at_event)
      values (s.id, 'activated', s.entry_price, 0);
      insert into public.audit_log (user_id, username, action, details)
      values (null, 'system', 'signal_activated',
              format('signal %s activated at %s', s.id, round(s.entry_price::numeric, 2)));
    else
      update public.signals set last_seen_price = p_close where id = s.id;
    end if;
  end loop;

  -- B) Observe open + closed-but-unsettled rows.
  for s in
    select * from public.signals
    where status = 'open'
       or (status in ('won','lost','breakeven') and settled_at is null)
    for update skip locked
  loop
    v_exit := null; v_r := null; v_pips := null; v_gain := null;

    lo := p_low; hi := p_high;                       -- this candle's extremes
    if s.direction = 'buy' then fav := hi; adv := lo; else fav := lo; adv := hi; end if;
    v_risk := coalesce(nullif(s.risk_per_unit, 0), pip_size);

    -- MFE / MAE (monotonic, this candle included)
    v_mfe := s.mfe_price; v_mae := s.mae_price;
    if s.direction = 'buy' then
      v_mfe := greatest(coalesce(v_mfe, fav), fav);
      v_mae := least   (coalesce(v_mae, adv), adv);
      v_mfe_r := (v_mfe - s.entry_price) / v_risk;
      v_mae_r := (v_mae - s.entry_price) / v_risk;
    else
      v_mfe := least   (coalesce(v_mfe, fav), fav);
      v_mae := greatest(coalesce(v_mae, adv), adv);
      v_mfe_r := (s.entry_price - v_mfe) / v_risk;
      v_mae_r := (s.entry_price - v_mae) / v_risk;
    end if;

    -- Level touches in this candle.
    if s.direction = 'buy' then
      hit1 := hi >= s.tp1;
      hit2 := s.tp2 is not null and hi >= s.tp2;
      hit3 := s.tp3 is not null and hi >= s.tp3;
      sl_raw := lo <= s.stop_loss;
    else
      hit1 := lo <= s.tp1;
      hit2 := s.tp2 is not null and lo <= s.tp2;
      hit3 := s.tp3 is not null and lo <= s.tp3;
      sl_raw := hi >= s.stop_loss;
    end if;

    v_peak := s.peak_tp;
    v_t1_at := s.tp1_hit_at; v_t1_px := s.tp1_hit_price;
    v_t2_at := s.tp2_hit_at; v_t2_px := s.tp2_hit_price;
    v_t3_at := s.tp3_hit_at; v_t3_px := s.tp3_hit_price;
    v_sl_at := s.sl_hit_at;

    if hit1 and v_t1_at is null then
      v_t1_at := now(); v_t1_px := s.tp1; v_peak := greatest(v_peak, 1);
      insert into public.signal_events (signal_id, kind, price, r_at_event)
      values (s.id, 'tp1_hit', s.tp1,
              (case when s.direction='buy' then s.tp1-s.entry_price else s.entry_price-s.tp1 end)/v_risk);
    end if;
    if hit2 and v_t2_at is null then
      v_t2_at := now(); v_t2_px := s.tp2; v_peak := greatest(v_peak, 2);
      insert into public.signal_events (signal_id, kind, price, r_at_event)
      values (s.id, 'tp2_hit', s.tp2,
              (case when s.direction='buy' then s.tp2-s.entry_price else s.entry_price-s.tp2 end)/v_risk);
    end if;
    if hit3 and v_t3_at is null then
      v_t3_at := now(); v_t3_px := s.tp3; v_peak := greatest(v_peak, 3);
      insert into public.signal_events (signal_id, kind, price, r_at_event)
      values (s.id, 'tp3_hit', s.tp3,
              (case when s.direction='buy' then s.tp3-s.entry_price else s.entry_price-s.tp3 end)/v_risk);
    end if;
    if sl_raw and v_sl_at is null then
      v_sl_at := now();
      insert into public.signal_events (signal_id, kind, price, r_at_event)
      values (s.id, 'sl_hit', s.stop_loss,
              (case when s.direction='buy' then s.stop_loss-s.entry_price else s.entry_price-s.stop_loss end)/v_risk);
    end if;

    -- OUTCOME (RATCHET) — only for rows still 'open'.
    v_status := s.status; v_closed_at := s.closed_at;
    if s.status = 'open' then
      -- effective stop from the RATCHET state at the START of this candle
      eff_stop := case s.peak_tp when 0 then s.stop_loss
                                 when 1 then s.entry_price
                                 else s.tp1 end;
      final_tp := coalesce(s.tp3, s.tp2, s.tp1);
      if s.direction = 'buy' then
        stop_hit := lo <= eff_stop;  target_hit := hi >= final_tp;
      else
        stop_hit := hi >= eff_stop;  target_hit := lo <= final_tp;
      end if;
      max_hold_due := s.activated_at is not null and now() > s.activated_at + max_hold;

      if stop_hit then
        v_exit := eff_stop;                  -- loss / break-even / partial
      elsif target_hit then
        v_exit := final_tp;                  -- full win
      elsif max_hold_due then
        v_exit := p_close;                   -- timed out -> mark to market
      else
        v_exit := null;
      end if;

      if v_exit is not null then
        if s.direction = 'buy' then v_gain := v_exit - s.entry_price;
        else                        v_gain := s.entry_price - v_exit; end if;
        v_r    := case when v_risk <> 0 then v_gain / v_risk else 0 end;
        v_pips := v_gain / pip_size;
        v_status := case when v_r > 0 then 'won' when v_r < 0 then 'lost' else 'breakeven' end;
        v_closed_at := now();

        insert into public.notifications (type, signal_id, message)
        values ('signal_closed', s.id,
                format('#%s %s -> %s (%sR)', s.id, s.direction, v_status, round(v_r::numeric, 2)));
        insert into public.audit_log (user_id, username, action, details)
        values (null, 'system', 'signal_closed',
                format('#%s %s -> %s (%sR)', s.id, s.direction, v_status, round(v_r::numeric, 2)));
        insert into public.signal_events (signal_id, kind, price, r_at_event)
        values (s.id, 'closed', v_exit, v_r);
      end if;
    end if;

    -- SETTLE — once closed, or once the post-close observation window passes.
    v_settle := null;
    if v_status in ('won','lost','breakeven') then
      v_settle := now();
    elsif s.track_until is not null and now() > s.track_until then
      v_settle := now();
    end if;
    if v_settle is not null and s.settled_at is null then
      insert into public.signal_events (signal_id, kind, price, r_at_event)
      values (s.id, 'settled', p_close,
              case when v_status in ('won','lost','breakeven') then coalesce(s.result_r, v_r) else null end);
    end if;

    update public.signals
       set last_seen_price = p_close,
           mfe_price = v_mfe, mae_price = v_mae, mfe_r = v_mfe_r, mae_r = v_mae_r,
           peak_tp = v_peak,
           tp1_hit_at = v_t1_at, tp1_hit_price = v_t1_px,
           tp2_hit_at = v_t2_at, tp2_hit_price = v_t2_px,
           tp3_hit_at = v_t3_at, tp3_hit_price = v_t3_px,
           sl_hit_at = v_sl_at,
           status = v_status,
           closed_at   = case when s.status='open' and v_status<>'open' then v_closed_at else s.closed_at end,
           exit_price  = case when s.status='open' and v_status<>'open' then v_exit else s.exit_price end,
           result_pips = case when s.status='open' and v_status<>'open' then v_pips else s.result_pips end,
           result_r    = case when s.status='open' and v_status<>'open' then v_r else s.result_r end,
           track_until = coalesce(s.track_until, s.activated_at + track_window, now() + track_window),
           settled_at  = coalesce(s.settled_at, v_settle)
     where id = s.id;
  end loop;
end;
$$;

-- 3) Backward-compatible single-price wrapper (degenerate candle high=low=close).
create or replace function public.run_verification(p_price double precision)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.run_verification(p_price, p_price, p_price);
end;
$$;

revoke execute on function public.run_verification(double precision, double precision, double precision) from public;
grant  execute on function public.run_verification(double precision, double precision, double precision) to service_role;
revoke execute on function public.run_verification(double precision) from public;
grant  execute on function public.run_verification(double precision) to service_role;
