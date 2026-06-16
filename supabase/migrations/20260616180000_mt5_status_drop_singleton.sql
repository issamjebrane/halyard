-- mt5_status was originally created as a singleton (CHECK id = 1). With multiple
-- copier engines each posting their own heartbeat slot (1 = telegram, 2 = simon,
-- …) that constraint blocks slot 2+. Drop it — id is still the PK, so rows stay
-- unique per slot.
alter table public.mt5_status drop constraint if exists mt5_status_singleton;
