-- Production scheduling for the verifier (every minute).
-- Run this ONCE against the hosted project after `supabase functions deploy verify`.
-- Replace <PROJECT_REF> and <SERVICE_ROLE_KEY> first.
--
-- Apply directly against production: `./scripts/psql-prod.sh -f supabase/cron.sql`
-- (after filling the placeholders) or paste into the dashboard SQL editor.
-- No local stack / Docker is involved.

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
