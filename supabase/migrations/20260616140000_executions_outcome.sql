-- Let the EA report the REAL outcome of each trade into the executions ledger,
-- so it reflects closes (not just entries) and the dashboard can reconcile the
-- EA's actual P&L against the verifier's theoretical R. Additive / nullable;
-- status already allows 'closed'/'breakeven'.
alter table public.executions
  add column if not exists profit    double precision,  -- realized P&L, account currency
  add column if not exists exit_fill double precision;  -- avg close price
