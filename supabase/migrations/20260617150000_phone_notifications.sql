-- Phone notifications via ntfy.sh — instant, serverless, always-on (no Mac/Claude).
-- DB triggers push trade events the moment they happen; a pg_cron watchdog pushes
-- engine-down. Uses pg_net (same as the verify cron). net.http_post is async, so
-- it never blocks the triggering transaction even if ntfy is unreachable.

-- topic in settings so it can be rotated without a migration
update public.settings set value = 'halyard-2b1edf609d974ed1' where key = 'ntfy_topic';
insert into public.settings (key, value)
  select 'ntfy_topic', 'halyard-2b1edf609d974ed1'
  where not exists (select 1 from public.settings where key = 'ntfy_topic');

-- helper: push a message to the configured ntfy topic
create or replace function public.notify_phone(p_message text, p_title text default 'Halyard', p_tags text default '', p_priority int default 3)
returns void language plpgsql security definer set search_path = public as $$
declare topic text;
begin
  select value into topic from public.settings where key = 'ntfy_topic';
  if topic is null or topic = '' then return; end if;
  perform net.http_post(
    url := 'https://ntfy.sh',
    body := jsonb_build_object(
      'topic', topic, 'message', p_message, 'title', p_title,
      'tags', case when p_tags = '' then '[]'::jsonb else to_jsonb(string_to_array(p_tags, ',')) end,
      'priority', p_priority
    ),
    headers := '{"Content-Type":"application/json"}'::jsonb
  );
end; $$;

-- executions → entry events (placed / skipped / error)
create or replace function public.notify_execution()
returns trigger language plpgsql security definer set search_path = public as $$
declare eng text;
begin
  select case when s.source is null then 'simon' else 'telegram' end into eng
    from public.signals s where s.id = new.signal_id;
  if new.status = 'placed' then
    perform public.notify_phone('#'||new.signal_id||' placed · '||coalesce(new.lots::text,'?')||' lots · '||coalesce(eng,'?'), 'Halyard · trade placed', 'chart_with_upwards_trend', 3);
  elsif new.status = 'error' then
    perform public.notify_phone('#'||new.signal_id||' ERROR · '||coalesce(new.detail,''), 'Halyard · order error', 'warning', 5);
  elsif new.status = 'skipped' then
    perform public.notify_phone('#'||new.signal_id||' skipped · '||coalesce(new.detail,''), 'Halyard · skipped', 'fast_forward', 2);
  end if;
  return null;
end; $$;
drop trigger if exists notify_execution_tg on public.executions;
create trigger notify_execution_tg after insert on public.executions
  for each row execute function public.notify_execution();

-- signals → outcome events (won / lost / breakeven), once per close
create or replace function public.notify_signal_close()
returns trigger language plpgsql security definer set search_path = public as $$
declare eng text; rtxt text;
begin
  if old.status in ('open','pending') and new.status in ('won','lost','breakeven') then
    eng := case when new.source is null then 'simon' else 'telegram' end;
    rtxt := case when new.result_r is null then '' else ((case when new.result_r >= 0 then '+' else '' end) || round(new.result_r::numeric,2) || 'R') end;
    if new.status = 'won' then
      perform public.notify_phone('#'||new.id||' WON '||rtxt||' · '||eng, 'Halyard · win', 'white_check_mark', 4);
    elsif new.status = 'lost' then
      perform public.notify_phone('#'||new.id||' lost '||rtxt||' · '||eng, 'Halyard · loss', 'red_circle', 3);
    else
      perform public.notify_phone('#'||new.id||' break-even · '||eng, 'Halyard · break-even', 'white_circle', 2);
    end if;
  end if;
  return null;
end; $$;
drop trigger if exists notify_signal_close_tg on public.signals;
create trigger notify_signal_close_tg after update on public.signals
  for each row execute function public.notify_signal_close();

-- engine-down watchdog (always-on, pg_cron). State kept OUT of mt5_status so we
-- don't reset its updated_at (the touch trigger) and mask the outage.
create table if not exists public.notify_state (engine_id int primary key, down boolean not null default false);
alter table public.notify_state enable row level security;

create or replace function public.watchdog_engines()
returns void language plpgsql security definer set search_path = public as $$
declare r record; age int; was_down boolean;
begin
  for r in select * from public.mt5_status loop
    age := floor(extract(epoch from now() - r.updated_at));
    select coalesce((select down from public.notify_state where engine_id = r.id), false) into was_down;
    if age > 180 and not was_down then
      perform public.notify_phone('engine '''||coalesce(r.label,'?')||''' DOWN — no heartbeat for '||age||'s', 'Halyard · ENGINE DOWN', 'rotating_light', 5);
      insert into public.notify_state(engine_id, down) values (r.id, true)
        on conflict (engine_id) do update set down = true;
    elsif age <= 180 and was_down then
      perform public.notify_phone('engine '''||coalesce(r.label,'?')||''' back up', 'Halyard · engine recovered', 'green_circle', 3);
      insert into public.notify_state(engine_id, down) values (r.id, false)
        on conflict (engine_id) do update set down = false;
    end if;
  end loop;
end; $$;

-- schedule the watchdog every 2 minutes (replace if it already exists)
do $$ begin perform cron.unschedule('halyard-engine-watchdog'); exception when others then null; end $$;
select cron.schedule('halyard-engine-watchdog', '*/2 * * * *', $$select public.watchdog_engines();$$);
