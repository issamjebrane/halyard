-- Support multiple copier engines, each posting its own heartbeat row.
-- The EA upserts mt5_status by id (slot 1 = telegram engine, 2 = simon engine, …)
-- and self-labels. id is already the PK, so extra rows just work; add a label so
-- the dashboard can name each engine. account_balance_history is already keyed by
-- account, so the two demo accounts stay separate there.
alter table public.mt5_status add column if not exists label text;
update public.mt5_status set label = 'gold vip' where id = 1 and label is null;
