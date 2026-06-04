-- Production scheduling for the verifier (every minute).
-- Run this ONCE against the hosted project after `supabase functions deploy verify`.
-- Replace <PROJECT_REF> and <SERVICE_ROLE_KEY> first.
--
-- Locally we don't use pg_cron (cross-container networking is fiddly); instead
-- the dev loop hits the function over HTTP — see scripts/poll-local.sh.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'halyard-verify',
  '* * * * *',
  $$
    select net.http_post(
      url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/verify',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer <SERVICE_ROLE_KEY>'
      ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 12000
    );
  $$
);

-- Inspect:   select * from cron.job;
-- Remove:    select cron.unschedule('halyard-verify');
-- History:   select * from cron.job_run_details order by start_time desc limit 20;
