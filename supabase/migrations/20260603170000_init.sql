-- Halyard — Gold Signal Verifier
-- Port of the Flask/SQLite app (db.py + market.py + app.py logic) to
-- Postgres + Supabase Auth + RLS. Business rules are preserved rule-for-rule.
--
-- Pip = $0.10. R = gain / |entry - SL|. Trades close ONLY on TP (win) or SL
-- (loss). If TP and SL are both crossed in one interval -> LOSS (conservative).
-- Pending orders activate when price crosses the entry. Signals are immutable
-- once posted; only the verification engine updates them.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- Profiles extend Supabase auth.users with a role + display name.
create table public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  username   text unique not null,
  role       text not null default 'trader' check (role in ('admin','trader')),
  locale     text not null default 'en',
  created_at timestamptz not null default now()
);

create table public.signals (
  id                     bigint generated always as identity primary key,
  trader_id              uuid not null references public.profiles(id) on delete cascade,
  symbol                 text not null default 'XAUUSD',
  direction              text not null check (direction in ('buy','sell')),
  order_type             text not null check (order_type in ('market','pending')),
  entry_price            double precision not null,
  stop_loss              double precision not null,
  take_profit            double precision not null,
  status                 text not null check (status in ('pending','open','won','lost','cancelled')),
  market_price_at_create double precision not null,
  last_seen_price        double precision not null,   -- to detect price crossings
  risk_per_unit          double precision not null,   -- |entry - SL| (1R in $)
  rr_planned             double precision not null,   -- planned reward/risk
  note                   text,
  created_at             timestamptz not null default now(),
  activated_at           timestamptz,
  closed_at              timestamptz,
  exit_price             double precision,
  result_pips            double precision,
  result_r               double precision
);

create index signals_status_idx     on public.signals (status);
create index signals_trader_id_idx  on public.signals (trader_id);
create index signals_created_at_idx on public.signals (created_at desc, id desc);

create table public.audit_log (
  id         bigint generated always as identity primary key,
  user_id    uuid,
  username   text,
  action     text not null,
  details    text,
  created_at timestamptz not null default now()
);

create table public.notifications (
  id         bigint generated always as identity primary key,
  type       text not null,            -- 'signal_new' | 'signal_closed'
  signal_id  bigint,
  message    text not null,
  is_read    boolean not null default false,
  created_at timestamptz not null default now()
);

-- Single-row cache of the latest spot price.
create table public.price_cache (
  id          int primary key default 1 check (id = 1),
  price       double precision,
  source_time text,
  fetched_at  timestamptz
);
insert into public.price_cache (id, price, source_time, fetched_at)
  values (1, null, null, null);

create table public.settings (
  key   text primary key,
  value text
);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Is the current auth user an admin? Used inside RLS policies.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- Auto-create a profile when an auth user is created. Role/username/locale can
-- be supplied via user metadata (the seed script does this); defaults to
-- 'trader' with the email local-part as username.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username, role, locale)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'role', 'trader'),
    coalesce(new.raw_user_meta_data->>'locale', 'en')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- post_signal — anti-cheat signal creation (port of app.post_signal)
-- The trusted live price (p_live) is fetched server-side by the Next.js action;
-- for MARKET orders the entry is pinned to it (the trader cannot choose it).
-- ---------------------------------------------------------------------------
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
  uid       uuid := auth.uid();
  uname     text;
  is_trader boolean;
  v_entry   double precision;
  v_status  text;
  v_act     timestamptz;
  v_last    double precision;
  v_risk    double precision;
  v_rr      double precision;
  sid       bigint;
  min_dist  constant double precision := 0.05;  -- PENDING_MIN_DISTANCE
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

  if p_direction not in ('buy','sell') or p_order_type not in ('market','pending') then
    raise exception 'invalid direction or order type';
  end if;
  if p_live is null or p_live <= 0 then
    raise exception 'live price unavailable';
  end if;
  if p_stop_loss is null or p_take_profit is null then
    raise exception 'stop loss and take profit are required';
  end if;

  -- Entry: market = trusted live price; pending = trader value, must differ.
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

  -- Level ordering (anti-cheat on levels).
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

-- ---------------------------------------------------------------------------
-- run_verification — the engine (port of market.verify_trades), called every
-- minute by the Edge Function with the freshly fetched spot price.
-- ---------------------------------------------------------------------------
create or replace function public.run_verification(p_price double precision)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s          record;
  lo         double precision;
  hi         double precision;
  sl_hit     boolean;
  tp_hit     boolean;
  outcome    text;
  v_exit     double precision;
  v_risk     double precision;
  v_gain     double precision;
  v_r        double precision;
  v_pips     double precision;
  pip_size   constant double precision := 0.10;
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

  -- 2) Close open trades on TP / SL (SL has priority -> conservative).
  for s in select * from public.signals where status = 'open' loop
    lo := least(s.last_seen_price, p_price);
    hi := greatest(s.last_seen_price, p_price);
    outcome := null;
    v_exit  := null;

    if s.direction = 'buy' then
      sl_hit := lo <= s.stop_loss;     -- min(last,cur) <= SL
      tp_hit := hi >= s.take_profit;
    else  -- sell
      sl_hit := hi >= s.stop_loss;
      tp_hit := lo <= s.take_profit;
    end if;

    if sl_hit then
      outcome := 'lost'; v_exit := s.stop_loss;
    elsif tp_hit then
      outcome := 'won';  v_exit := s.take_profit;
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

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles      enable row level security;
alter table public.signals       enable row level security;
alter table public.audit_log     enable row level security;
alter table public.notifications enable row level security;
alter table public.price_cache   enable row level security;
alter table public.settings      enable row level security;

-- profiles: a user sees their own; admin sees all.
create policy "profiles self/admin read" on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_admin());

-- signals: trader sees own; admin sees all. (Public page reads via service role,
-- token-gated, in the Next.js server.)
create policy "signals own/admin read" on public.signals
  for select to authenticated
  using (trader_id = auth.uid() or public.is_admin());
-- No insert/update/delete policies: posting goes through post_signal() and the
-- engine runs as service_role. Signals are immutable to end users.

-- notifications + audit: admin only.
create policy "notifications admin read" on public.notifications
  for select to authenticated using (public.is_admin());
create policy "notifications admin update" on public.notifications
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "audit admin read" on public.audit_log
  for select to authenticated using (public.is_admin());

-- price_cache: any authenticated user may read the live price.
create policy "price readable" on public.price_cache
  for select to authenticated using (true);

-- settings: no end-user access (share token handled via service role).

-- ---------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------
revoke execute on function public.run_verification(double precision) from public;
grant  execute on function public.run_verification(double precision) to service_role;

revoke execute on function public.post_signal(text, text, double precision, double precision, double precision, double precision, text) from public;
grant  execute on function public.post_signal(text, text, double precision, double precision, double precision, double precision, text) to authenticated;

grant execute on function public.is_admin() to authenticated, anon;
