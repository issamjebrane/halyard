-- Raise the daily posting cap from 5 to 10 signals per local day. The cap is a
-- hardcoded constant inside post_signal(), so changing it means re-creating the
-- function. Body is otherwise identical to 20260605100000_engine_fixes.sql
-- (same signature, validation, anti-cheat, market-order activation event +
-- MFE/MAE seed). Only `daily_cap` changes: 5 -> 10. The UI mirror lives in
-- lib/constants.ts (DAILY_SIGNAL_LIMIT).

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
  v_mfe      double precision;
  v_track    timestamptz;
  min_dist   constant double precision := 0.05;
  daily_cap  constant int := 10;                 -- was 5
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
    v_status := 'open'; v_act := now(); v_last := v_entry;
    v_mfe := v_entry; v_track := now() + track_window;
  else
    v_status := 'pending'; v_act := null; v_last := p_live;
    v_mfe := null; v_track := null;
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
