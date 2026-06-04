-- Make the 5/day cap reset at the trader's LOCAL midnight, auto-detected from
-- the browser (no input required from the user). Stored per profile; falls back
-- to UTC until detected or if an invalid zone is ever stored.

alter table public.profiles
  add column if not exists timezone text not null default 'UTC';

-- Start of "today" as a timestamptz, in the given user's stored timezone.
create or replace function public.day_start(p_uid uuid)
returns timestamptz
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tz text;
begin
  select coalesce(timezone, 'UTC') into v_tz from public.profiles where id = p_uid;
  if v_tz is null or v_tz = '' then
    v_tz := 'UTC';
  end if;
  return date_trunc('day', now() at time zone v_tz) at time zone v_tz;
exception when others then
  -- bad/unknown zone -> fall back to UTC
  return date_trunc('day', now() at time zone 'utc') at time zone 'utc';
end;
$$;

-- Silently persist the browser-detected timezone (validated against the IANA list).
create or replace function public.set_timezone(p_tz text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or p_tz is null or p_tz = '' then
    return;
  end if;
  if not exists (select 1 from pg_timezone_names where name = p_tz) then
    return;
  end if;
  update public.profiles
     set timezone = p_tz
   where id = auth.uid() and timezone is distinct from p_tz;
end;
$$;

-- How many signals the current trader has posted "today" (their local day).
create or replace function public.signals_used_today()
returns int
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int
    from public.signals
   where trader_id = auth.uid()
     and created_at >= public.day_start(auth.uid());
$$;

-- Re-create post_signal so the daily cap uses the trader's local day boundary.
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

  -- Daily cap, counted from the trader's LOCAL midnight.
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

grant execute on function public.day_start(uuid) to authenticated;
grant execute on function public.set_timezone(text) to authenticated;
grant execute on function public.signals_used_today() to authenticated;
