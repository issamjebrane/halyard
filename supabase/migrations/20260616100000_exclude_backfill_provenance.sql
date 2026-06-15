-- Harden the backfill exclusion: flag by PROVENANCE, not by price distance.
--
-- The previous migration excluded telegram rows where the entry sat >$15 from
-- market_price_at_create. But market_price_at_create is the spot price at the
-- moment the backfill JOB ran (telegram-ingest sets it to `live ?? entry`), not
-- the message's original price — so two backfilled rows (#56, #57) whose entries
-- happened to land within $15 of that run-time spot slipped through and leaked
-- into the public trust score / equity (e.g. a fake +2.31R win).
--
-- The real signal of "this is backfill" is provenance: all 22 telegram rows were
-- bulk-inserted in one ~11s batch on 2026-06-15 18:15 (two distinct
-- market_price_at_create values, created 18:15:39–18:15:50). Genuine forward
-- signals arrive one message at a time, later than this. So exclude the whole
-- pre-cutover batch. Reversible (flip excluded back); Simon's manual rows
-- (source is null) are never touched.
update public.signals
   set excluded = true,
       excluded_reason = 'backfill: bulk-ingested historical batch, not forward-tracked'
 where source = 'telegram:gold_vip'
   and created_at < timestamptz '2026-06-15 18:20:00+00';
