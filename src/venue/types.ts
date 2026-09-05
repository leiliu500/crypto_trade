export interface VenueAsset {
  id: string;
  class?: string;
  asset_class?: string;
  exchange: string;
  symbol: string;
  name: string;
  status: string;
  tradable: boolean;
  marginable: boolean;
  shortable: boolean;
  easy_to_borrow: boolean;
  fractionable: boolean;
  min_order_size?: string;
  min_trade_increment?: string;
  price_increment?: string;
  maintenance_margin_requirement?: string | number;
  attributes?: string[];
}

export interface VenueAccount {
  id: string;
  account_number: string;
  status: string;
  crypto_status?: string;
  currency: string;
  cash: string;
  portfolio_value: string;
  equity: string;
  last_equity: string;
  buying_power: string;
  effective_buying_power?: string;
  non_marginable_buying_power: string;
  trading_blocked: boolean;
  transfers_blocked: boolean;
  account_blocked: boolean;
  trade_suspended_by_user: boolean;
  shorting_enabled: boolean;
  pattern_day_trader: boolean;
  daytrade_count: number;
}

export interface VenueAccountConfiguration {
  dtbp_check: string;
  fractional_trading: boolean;
  max_margin_multiplier: string;
  no_shorting: boolean;
  pdt_check: string;
  suspend_trade: boolean;
  trade_confirm_email: string;
}

export type VenueOrderSide = "buy" | "sell";
export interface VenueOrder {
  id: string;
  client_order_id: string;
  asset_id: string;
  symbol: string;
  asset_class: string;
  qty: string | null;
  notional: string | null;
  filled_qty: string;
  filled_avg_price: string | null;
  order_class: string;
  order_type: string;
  type: string;
  side: VenueOrderSide;
  time_in_force: string;
  limit_price: string | null;
  stop_price: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  filled_at: string | null;
  canceled_at: string | null;
  failed_at: string | null;
  replaced_at: string | null;
  replaced_by: string | null;
  replaces: string | null;
}

export interface VenuePosition {
  asset_id: string;
  symbol: string;
  exchange: string;
  asset_class: string;
  qty: string;
  avg_entry_price: string;
  side: "long" | "short";
  market_value: string;
  cost_basis: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  current_price: string;
  lastday_price: string;
}

export interface VenueActivity {
  fee_usd?: string;
  id: string;
  activity_type: string;
  transaction_time?: string;
  date?: string;
  net_amount?: string;
  symbol?: string;
  qty?: string;
  price?: string;
  order_id?: string;
}

export interface VenueClock { timestamp: string; is_open: boolean; next_open: string; next_close: string; }
export interface VenueBookLevel { p: number; s: number; }
export interface VenueOrderbook { t: string; b: VenueBookLevel[]; a: VenueBookLevel[]; r?: boolean; }
export interface VenueLatestQuote { t: string; bp: number; bs: number; ap: number; as: number; }
export interface VenueLatestTrade { t: string; p: number; s: number; i: number | string; tks?: "B" | "S"; }
export interface VenueBar { t: string; o: number; h: number; l: number; c: number; v: number; n?: number; vw?: number; }
export interface VenueSnapshot { latestTrade?: VenueLatestTrade; latestQuote?: VenueLatestQuote; minuteBar?: VenueBar; dailyBar?: VenueBar; prevDailyBar?: VenueBar; }

export interface ListOrdersQuery {
  status?: "open" | "closed" | "all";
  limit?: number;
  after?: string;
  until?: string;
  direction?: "asc" | "desc";
  symbols?: string;
  side?: VenueOrderSide;
}
export interface ActivitiesQuery { activity_types?: string; order_id?: string; date?: string; until?: string; after?: string; direction?: "asc" | "desc"; page_size?: number; page_token?: string; }
export interface HistoricalQuery { symbols: string; start?: string; end?: string; timeframe?: string; limit?: number; page_token?: string; sort?: "asc" | "desc"; }
export interface VenueApiResponse<T> { data: T; requestId?: string; status: number; }
