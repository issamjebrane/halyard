export type Direction = "buy" | "sell";
export type OrderType = "market" | "pending";
export type SignalStatus =
  | "pending"
  | "open"
  | "won"
  | "lost"
  | "breakeven"
  | "cancelled";
export type Role = "admin" | "trader";

export type Profile = {
  id: string;
  username: string;
  role: Role;
  locale: string;
  timezone: string;
  created_at: string;
};

export type Signal = {
  id: number;
  trader_id: string;
  symbol: string;
  direction: Direction;
  order_type: OrderType;
  entry_price: number;
  stop_loss: number;
  tp1: number;
  tp2: number | null;
  tp3: number | null;
  status: SignalStatus;
  market_price_at_create: number;
  last_seen_price: number;
  risk_per_unit: number;
  rr_planned: number;
  note: string | null;
  created_at: string;
  activated_at: string | null;
  closed_at: string | null;
  exit_price: number | null;
  result_pips: number | null;
  result_r: number | null;
  // lifecycle tracking — every level the engine touched, plus excursions.
  tp1_hit_at: string | null;
  tp1_hit_price: number | null;
  tp2_hit_at: string | null;
  tp2_hit_price: number | null;
  tp3_hit_at: string | null;
  tp3_hit_price: number | null;
  sl_hit_at: string | null;
  peak_tp: number; // highest target reached: 0/1/2/3
  mfe_price: number | null; // max favorable excursion (raw price)
  mae_price: number | null; // max adverse excursion (raw price)
  mfe_r: number | null; // MFE in R (>= 0)
  mae_r: number | null; // MAE in R (<= 0)
  settled_at: string | null; // null while the engine is still observing
  track_until: string | null; // post-outcome observation deadline
  // present when joined for admin/public views
  trader_name?: string;
};

// One discrete thing the verification engine did to a signal — "the tape".
export type SignalEventKind =
  | "activated"
  | "tp1_hit"
  | "tp2_hit"
  | "tp3_hit"
  | "sl_hit"
  | "closed"
  | "settled"
  | "price_extreme";

export type SignalEvent = {
  id: number;
  signal_id: number;
  kind: SignalEventKind;
  price: number | null;
  r_at_event: number | null;
  created_at: string;
};

export type PriceCache = {
  price: number | null;
  source_time: string | null;
  fetched_at: string | null;
};

export type Notification = {
  id: number;
  type: string;
  signal_id: number | null;
  message: string;
  is_read: boolean;
  created_at: string;
};
