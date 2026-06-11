-- Provenance + idempotency for ingested signals. External feeds (e.g. the
-- Gold VIP Telegram channel) insert directly via the service role; these two
-- columns record where a signal came from and let re-runs be idempotent.
--   source     = feed identifier, e.g. 'telegram:gold_vip'
--   source_ref = the source's own message id (text), unique within a source
-- Both are NULL for manually-posted signals (post_signal leaves them unset).

alter table public.signals
  add column if not exists source     text,
  add column if not exists source_ref text;

-- One row per (source, message) — a second ingest of the same Telegram message
-- is a no-op (insert ... on conflict do nothing).
create unique index if not exists signals_source_ref_key
  on public.signals (source, source_ref)
  where source is not null and source_ref is not null;
