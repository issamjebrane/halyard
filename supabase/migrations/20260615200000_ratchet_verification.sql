-- Switch the verifier from "close at TP1" accounting to RATCHET (docs/ESTRATEGIA_SIMON_INGENIERO.md).
-- The docs prove TP1-close is the worst exit (~ -2.5R on the sample); RATCHET trails the stop by
-- levels and is the validated strategy. This makes the Trust Score / equity / tape reflect the real
-- strategy. lib/metrics.ts reads only status + result_r on won|lost rows, so no app change is needed.
--
-- RATCHET (per signal, target = highest provided TP):
--   stop starts at the ORIGINAL signal SL
--   price reaches TP1  -> stop moves to ENTRY (break-even)        [only if a higher TP is the target]
--   price reaches TP2  -> stop moves to TP1                       [only if TP3 is the target]
--   price reaches the TARGET (TP3, or highest provided) -> WIN, close there
--   current stop hit -> close there (-1R at original SL, 0R at entry, +TP1's R at TP1)
--   MAX_HOLD 72h -> close at market (mark-to-market)
-- result_r is always measured against the ORIGINAL risk |entry - original SL|.
-- SL priority is conservative: a tick that touches the original SL before TP1 was ever locked is a loss.

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
  v_mfe        double precision; v_mae double precision; v_mfe_r double precision; v_mae_r double precision;
  v_peak       int;
  v_t1_at timestamptz; v_t1_px double precision;
  v_t2_at timestamptz; v_t2_px double precision;
  v_t3_at timestamptz; v_t3_px double precision;
  v_sl_at      timestamptz;
  hit1 boolean; hit2 boolean; hit3 boolean;
  prev1 boolean; prev2 boolean; reached1 boolean; reached2 boolean;
  tgt          double precision;     -- target = highest provided TP
  eff_stop     double precision;     -- current RATCHET stop
  v_status     text; v_exit double precision; v_closed timestamptz;
  v_risk double precision; v_gain double precision; v_r double precision; v_pips double precision;
  is_buy boolean;
  pip_size  constant double precision := 0.10;
  hold_secs constant int := 72*3600;
begin
  if p_price is null or p_price <= 0 then return; end if;

  -- A) Activate pending -> open; seed baseline; 'activated' event.
  for s in select * from public.signals where status='pending' for update skip locked loop
    lo := least(s.last_seen_price, p_price); hi := greatest(s.last_seen_price, p_price);
    if s.entry_price >= lo and s.entry_price <= hi then
      update public.signals set status='open', activated_at=now(), last_seen_price=s.entry_price,
             mfe_price=s.entry_price, mae_price=s.entry_price, mfe_r=0, mae_r=0, peak_tp=0
       where id=s.id;
      insert into public.signal_events(signal_id,kind,price,r_at_event) values (s.id,'activated',s.entry_price,0);
      insert into public.audit_log(user_id,username,action,details)
        values (null,'system','signal_activated',format('signal %s activated at %s',s.id,round(s.entry_price::numeric,2)));
    else
      update public.signals set last_seen_price=p_price where id=s.id;
    end if;
  end loop;

  -- B) RATCHET management for OPEN signals.
  for s in select * from public.signals where status='open' for update skip locked loop
    is_buy := (s.direction='buy');
    lo := least(s.last_seen_price, p_price); hi := greatest(s.last_seen_price, p_price);
    if is_buy then fav:=hi; adv:=lo; else fav:=lo; adv:=hi; end if;
    v_risk := coalesce(nullif(abs(s.entry_price - s.stop_loss),0), pip_size);

    -- MFE / MAE
    v_mfe:=s.mfe_price; v_mae:=s.mae_price;
    if is_buy then
      v_mfe:=greatest(coalesce(v_mfe,fav),fav); v_mae:=least(coalesce(v_mae,adv),adv);
      v_mfe_r:=(v_mfe-s.entry_price)/v_risk;    v_mae_r:=(v_mae-s.entry_price)/v_risk;
    else
      v_mfe:=least(coalesce(v_mfe,fav),fav);    v_mae:=greatest(coalesce(v_mae,adv),adv);
      v_mfe_r:=(s.entry_price-v_mfe)/v_risk;     v_mae_r:=(s.entry_price-v_mae)/v_risk;
    end if;

    -- favorable level touches this tick
    if is_buy then
      hit1 := hi>=s.tp1; hit2 := s.tp2 is not null and hi>=s.tp2; hit3 := s.tp3 is not null and hi>=s.tp3;
    else
      hit1 := lo<=s.tp1; hit2 := s.tp2 is not null and lo<=s.tp2; hit3 := s.tp3 is not null and lo<=s.tp3;
    end if;

    -- stamp first-time level touches (display/tape; does not by itself close)
    v_peak:=s.peak_tp;
    v_t1_at:=s.tp1_hit_at; v_t1_px:=s.tp1_hit_price;
    v_t2_at:=s.tp2_hit_at; v_t2_px:=s.tp2_hit_price;
    v_t3_at:=s.tp3_hit_at; v_t3_px:=s.tp3_hit_price; v_sl_at:=s.sl_hit_at;
    if hit1 and v_t1_at is null then v_t1_at:=now(); v_t1_px:=s.tp1; v_peak:=greatest(v_peak,1);
      insert into public.signal_events(signal_id,kind,price,r_at_event) values (s.id,'tp1_hit',s.tp1,(case when is_buy then s.tp1-s.entry_price else s.entry_price-s.tp1 end)/v_risk); end if;
    if hit2 and v_t2_at is null then v_t2_at:=now(); v_t2_px:=s.tp2; v_peak:=greatest(v_peak,2);
      insert into public.signal_events(signal_id,kind,price,r_at_event) values (s.id,'tp2_hit',s.tp2,(case when is_buy then s.tp2-s.entry_price else s.entry_price-s.tp2 end)/v_risk); end if;
    if hit3 and v_t3_at is null then v_t3_at:=now(); v_t3_px:=s.tp3; v_peak:=greatest(v_peak,3);
      insert into public.signal_events(signal_id,kind,price,r_at_event) values (s.id,'tp3_hit',s.tp3,(case when is_buy then s.tp3-s.entry_price else s.entry_price-s.tp3 end)/v_risk); end if;

    prev1 := s.tp1_hit_at is not null;
    prev2 := s.tp2_hit_at is not null;
    tgt := coalesce(s.tp3, s.tp2, s.tp1);

    -- Current RATCHET stop, based on levels locked on PRIOR ticks (one-tick lag).
    -- Using prior state avoids a false stop-hit on the same tick a level is first
    -- reached: the [last_seen, price] range includes the entry as a boundary, so a
    -- same-tick "stop = entry" would trip on the entry itself. Win/loss stay immediate.
    eff_stop := s.stop_loss;
    if prev1 and (s.tp2 is not null or s.tp3 is not null) then eff_stop := s.entry_price; end if;
    if prev2 and (s.tp3 is not null) then eff_stop := s.tp1; end if;

    v_status := 'open'; v_exit := null;
    if (not prev1) and (case when is_buy then lo<=s.stop_loss else hi>=s.stop_loss end) then
      v_status:='lost'; v_exit:=s.stop_loss; if v_sl_at is null then v_sl_at:=now(); end if;       -- SL priority
    elsif (case when is_buy then hi>=tgt else lo<=tgt end) then
      v_status:='won'; v_exit:=tgt;                                                                -- target reached
    elsif prev1 and (case when is_buy then lo<=eff_stop else hi>=eff_stop end) then
      v_status:='ratchet_stop'; v_exit:=eff_stop;                                                  -- BE (entry) or +TP1's R
    elsif (now() - s.activated_at) > make_interval(secs => hold_secs) then
      v_status:='maxhold'; v_exit:=p_price;                                                        -- 72h mark-to-market
    end if;

    if v_status <> 'open' then
      v_closed := now();
      v_gain := case when is_buy then v_exit - s.entry_price else s.entry_price - v_exit end;
      v_r    := v_gain / v_risk;
      v_pips := v_gain / pip_size;
      v_status := case when v_r < 0 then 'lost' else 'won' end;   -- BE (0R) counts as a non-loss

      update public.signals set
        status=v_status, closed_at=v_closed, exit_price=v_exit, result_r=v_r, result_pips=v_pips,
        settled_at=v_closed, last_seen_price=p_price,
        mfe_price=v_mfe, mae_price=v_mae, mfe_r=v_mfe_r, mae_r=v_mae_r, peak_tp=v_peak,
        tp1_hit_at=v_t1_at, tp1_hit_price=v_t1_px, tp2_hit_at=v_t2_at, tp2_hit_price=v_t2_px,
        tp3_hit_at=v_t3_at, tp3_hit_price=v_t3_px, sl_hit_at=v_sl_at
      where id=s.id;

      insert into public.notifications(type,signal_id,message)
        values ('signal_closed',s.id,format('#%s %s -> %s (%sR, ratchet)',s.id,s.direction,v_status,round(v_r::numeric,2)));
      insert into public.audit_log(user_id,username,action,details)
        values (null,'system','signal_closed',format('#%s %s -> %s (%sR, ratchet exit %s)',s.id,s.direction,v_status,round(v_r::numeric,2),round(v_exit::numeric,2)));
      insert into public.signal_events(signal_id,kind,price,r_at_event) values (s.id,'closed',v_exit,v_r);
      insert into public.signal_events(signal_id,kind,price,r_at_event) values (s.id,'settled',v_exit,v_r);
    else
      update public.signals set
        last_seen_price=p_price, mfe_price=v_mfe, mae_price=v_mae, mfe_r=v_mfe_r, mae_r=v_mae_r,
        peak_tp=v_peak, tp1_hit_at=v_t1_at, tp1_hit_price=v_t1_px, tp2_hit_at=v_t2_at, tp2_hit_price=v_t2_px,
        tp3_hit_at=v_t3_at, tp3_hit_price=v_t3_px, sl_hit_at=v_sl_at,
        track_until=coalesce(s.track_until, s.activated_at + make_interval(secs => hold_secs))
      where id=s.id;
    end if;
  end loop;
end;
$$;

revoke execute on function public.run_verification(double precision) from public;
grant  execute on function public.run_verification(double precision) to service_role;
