-- Daily posting cap: a trader may post at most 5 signals per UTC calendar day.
-- Enforced inside post_signal() so it cannot be bypassed (the only insert path).
-- CREATE OR REPLACE keeps the same signature, so this just swaps the body.

create or replace function public.post_signal(
  p_direction   text,
  p_order_type  text,
  p_stop_loss   double precision,
  p_take_profit double precision,
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
  min_dist   constant double precision := 0.05;   -- PENDING_MIN_DISTANCE
  daily_cap  constant int := 5;                   -- max signals per UTC day
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

  -- Daily cap: count this trader's signals created since UTC midnight.
  select count(*) into v_today
    from public.signals
   where trader_id = uid
     and created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc';

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
  if p_stop_loss is null or p_take_profit is null then
    raise exception 'stop loss and take profit are required';
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

  if p_direction = 'buy' and not (p_stop_loss < v_entry and v_entry < p_take_profit) then
    raise exception 'buy requires SL < entry < TP';
  end if;
  if p_direction = 'sell' and not (p_take_profit < v_entry and v_entry < p_stop_loss) then
    raise exception 'sell requires TP < entry < SL';
  end if;

  v_risk := abs(v_entry - p_stop_loss);
  if v_risk <= 0 then
    raise exception 'risk must be greater than zero';
  end if;
  v_rr := abs(p_take_profit - v_entry) / v_risk;

  if p_order_type = 'market' then
    v_status := 'open'; v_act := now(); v_last := v_entry;
  else
    v_status := 'pending'; v_act := null; v_last := p_live;
  end if;

  insert into public.signals (
    trader_id, symbol, direction, order_type, entry_price, stop_loss, take_profit,
    status, market_price_at_create, last_seen_price, risk_per_unit, rr_planned,
    note, activated_at
  ) values (
    uid, 'XAUUSD', p_direction, p_order_type, v_entry, p_stop_loss, p_take_profit,
    v_status, p_live, v_last, v_risk, v_rr,
    nullif(left(coalesce(p_note, ''), 300), ''), v_act
  )
  returning id into sid;

  insert into public.notifications (type, signal_id, message)
  values (
    'signal_new', sid,
    format('#%s %s %s @ %s (SL %s / TP %s)', sid, p_direction, p_order_type,
           round(v_entry::numeric, 2), round(p_stop_loss::numeric, 2),
           round(p_take_profit::numeric, 2))
  );

  insert into public.audit_log (user_id, username, action, details)
  values (uid, uname, 'signal_created',
          format('#%s %s %s @ %s', sid, p_direction, p_order_type,
                 round(v_entry::numeric, 2)));

  return sid;
end;
$$;
