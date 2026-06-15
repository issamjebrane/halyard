-- RATCHET engine verification. Each scenario runs in its own transaction and
-- ROLLS BACK — nothing is persisted, real signals are never affected. A synthetic
-- BUY (entry 100, SL 90, TP1 110, TP2 120, TP3 130, risk 10) is walked through
-- candles and we assert the resulting status / result_r.
\set ON_ERROR_STOP on

-- Scenario A — straight to TP3 (full win, +3R)
begin;
do $$
declare tid uuid; sid bigint; st text; rr double precision;
begin
  select id into tid from public.profiles where role='trader' limit 1;
  insert into public.signals(trader_id,symbol,direction,order_type,entry_price,stop_loss,tp1,tp2,tp3,status,market_price_at_create,last_seen_price,risk_per_unit,rr_planned,peak_tp,mfe_price,mae_price,mfe_r,mae_r,activated_at,track_until)
  values(tid,'XAUUSD','buy','market',100,90,110,120,130,'open',100,100,10,1,0,100,100,0,0,now(),now()+interval '7 days') returning id into sid;
  perform public.run_verification(131, 99, 130);  -- candle blows through TP3
  select status,result_r into st,rr from public.signals where id=sid;
  raise notice 'A  TP3 win          -> status=% result_r=%   (expect won  +3.0)', st, rr;
end $$;
rollback;

-- Scenario B — TP1 then reverse to entry (break-even, 0R)
begin;
do $$
declare tid uuid; sid bigint; st text; rr double precision;
begin
  select id into tid from public.profiles where role='trader' limit 1;
  insert into public.signals(trader_id,symbol,direction,order_type,entry_price,stop_loss,tp1,tp2,tp3,status,market_price_at_create,last_seen_price,risk_per_unit,rr_planned,peak_tp,mfe_price,mae_price,mfe_r,mae_r,activated_at,track_until)
  values(tid,'XAUUSD','buy','market',100,90,110,120,130,'open',100,100,10,1,0,100,100,0,0,now(),now()+interval '7 days') returning id into sid;
  perform public.run_verification(111, 99, 110);  -- touches TP1 -> SL to entry
  perform public.run_verification(101, 99, 100);  -- reverses to entry
  select status,result_r into st,rr from public.signals where id=sid;
  raise notice 'B  TP1->break-even  -> status=% result_r=%   (expect breakeven 0.0)', st, rr;
end $$;
rollback;

-- Scenario C — TP2 then reverse to TP1 (partial win, +1R)
begin;
do $$
declare tid uuid; sid bigint; st text; rr double precision;
begin
  select id into tid from public.profiles where role='trader' limit 1;
  insert into public.signals(trader_id,symbol,direction,order_type,entry_price,stop_loss,tp1,tp2,tp3,status,market_price_at_create,last_seen_price,risk_per_unit,rr_planned,peak_tp,mfe_price,mae_price,mfe_r,mae_r,activated_at,track_until)
  values(tid,'XAUUSD','buy','market',100,90,110,120,130,'open',100,100,10,1,0,100,100,0,0,now(),now()+interval '7 days') returning id into sid;
  perform public.run_verification(122, 99, 121);  -- touches TP2 -> SL to TP1
  perform public.run_verification(112, 109, 110); -- reverses to TP1
  select status,result_r into st,rr from public.signals where id=sid;
  raise notice 'C  TP2->TP1 partial -> status=% result_r=%   (expect won  +1.0)', st, rr;
end $$;
rollback;

-- Scenario D — straight to SL (full loss, -1R)
begin;
do $$
declare tid uuid; sid bigint; st text; rr double precision;
begin
  select id into tid from public.profiles where role='trader' limit 1;
  insert into public.signals(trader_id,symbol,direction,order_type,entry_price,stop_loss,tp1,tp2,tp3,status,market_price_at_create,last_seen_price,risk_per_unit,rr_planned,peak_tp,mfe_price,mae_price,mfe_r,mae_r,activated_at,track_until)
  values(tid,'XAUUSD','buy','market',100,90,110,120,130,'open',100,100,10,1,0,100,100,0,0,now(),now()+interval '7 days') returning id into sid;
  perform public.run_verification(101, 89, 90);   -- blows through SL
  select status,result_r into st,rr from public.signals where id=sid;
  raise notice 'D  SL loss          -> status=% result_r=%   (expect lost -1.0)', st, rr;
end $$;
rollback;
