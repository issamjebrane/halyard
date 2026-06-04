-- Three take-profit levels: TP1 (required) + TP2/TP3 (optional), matching the
-- original signal format ("Target 4487 / 4491 / 4530"). Win is decided by TP1
-- (first target) vs SL; TP2/TP3 are tracked for display/overlay.

alter table public.signals rename column take_profit to tp1;
alter table public.signals add column if not exists tp2 double precision;
alter table public.signals add column if not exists tp3 double precision;

-- run_verification: outcome decided by TP1 (first target). SL has priority
-- (conservative). Identical crossing logic, just keyed on tp1.
create or replace function public.run_verification(p_price double precision)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s        record;
  lo       double precision;
  hi       double precision;
  sl_hit   boolean;
  tp_hit   boolean;
  outcome  text;
  v_exit   double precision;
  v_risk   double precision;
  v_gain   double precision;
  v_r      double precision;
  v_pips   double precision;
  pip_size constant double precision := 0.10;
begin
  if p_price is null or p_price <= 0 then
    return;
  end if;

  -- 1) Activate pending orders when price crosses the entry.
  for s in select * from public.signals where status = 'pending' loop
    lo := least(s.last_seen_price, p_price);
    hi := greatest(s.last_seen_price, p_price);
    if s.entry_price >= lo and s.entry_price <= hi then
      update public.signals
         set status = 'open', activated_at = now(), last_seen_price = s.entry_price
       where id = s.id;
      insert into public.audit_log (user_id, username, action, details)
      values (null, 'system', 'signal_activated',
              format('signal %s activated at %s', s.id, round(s.entry_price::numeric, 2)));
    else
      update public.signals set last_seen_price = p_price where id = s.id;
    end if;
  end loop;

  -- 2) Close open trades on TP1 / SL (SL priority -> conservative).
  for s in select * from public.signals where status = 'open' loop
    lo := least(s.last_seen_price, p_price);
    hi := greatest(s.last_seen_price, p_price);
    outcome := null;
    v_exit  := null;

    if s.direction = 'buy' then
      sl_hit := lo <= s.stop_loss;
      tp_hit := hi >= s.tp1;
    else
      sl_hit := hi >= s.stop_loss;
      tp_hit := lo <= s.tp1;
    end if;

    if sl_hit then
      outcome := 'lost'; v_exit := s.stop_loss;
    elsif tp_hit then
      outcome := 'won';  v_exit := s.tp1;
    end if;

    if outcome is not null then
      v_risk := coalesce(nullif(s.risk_per_unit, 0), pip_size);
      if s.direction = 'buy' then
        v_gain := v_exit - s.entry_price;
      else
        v_gain := s.entry_price - v_exit;
      end if;
      v_r    := case when v_risk <> 0 then v_gain / v_risk else 0 end;
      v_pips := v_gain / pip_size;

      update public.signals
         set status = outcome, closed_at = now(), exit_price = v_exit,
             result_pips = v_pips, result_r = v_r, last_seen_price = p_price
       where id = s.id;

      insert into public.notifications (type, signal_id, message)
      values ('signal_closed', s.id,
              format('#%s %s -> %s (%sR)', s.id, s.direction, outcome,
                     round(v_r::numeric, 2)));
      insert into public.audit_log (user_id, username, action, details)
      values (null, 'system', 'signal_closed',
              format('#%s %s -> %s (%sR)', s.id, s.direction, outcome,
                     round(v_r::numeric, 2)));
    else
      update public.signals set last_seen_price = p_price where id = s.id;
    end if;
  end loop;
end;
$$;

-- post_signal: new signature with TP1/TP2/TP3. Keeps the local-day daily cap,
-- anti-cheat market entry, and adds multi-target ordering validation.
drop function if exists public.post_signal(
  text, text, double precision, double precision, double precision, double precision, text);

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
  min_dist   constant double precision := 0.05;
  daily_cap  constant int := 5;
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

  -- Level ordering, including the optional further targets.
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
  else
    v_status := 'pending'; v_act := null; v_last := p_live;
  end if;

  insert into public.signals (
    trader_id, symbol, direction, order_type, entry_price, stop_loss,
    tp1, tp2, tp3, status, market_price_at_create, last_seen_price,
    risk_per_unit, rr_planned, note, activated_at
  ) values (
    uid, 'XAUUSD', p_direction, p_order_type, v_entry, p_stop_loss,
    p_tp1, p_tp2, p_tp3, v_status, p_live, v_last,
    v_risk, v_rr, nullif(left(coalesce(p_note, ''), 300), ''), v_act
  )
  returning id into sid;

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
