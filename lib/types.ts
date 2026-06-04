export type Direction = "buy" | "sell";
export type OrderType = "market" | "pending";
export type SignalStatus = "pending" | "open" | "won" | "lost" | "cancelled";
export type Role = "admin" | "trader";

export type Profile = {
  id: string;
  username: string;
  role: Role;
  locale: string;
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
  take_profit: number;
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
  // present when joined for admin/public views
  trader_name?: string;
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
