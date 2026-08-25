export interface AlpacaCredentials { keyId: string; secretKey: string; }
export interface AlpacaClientConfig {
  credentials: AlpacaCredentials;
  paper: boolean;
  tradingBaseUrl?: string;
  dataBaseUrl?: string;
  cryptoLocation?: string;
  requestTimeoutMs?: number;
  maximumGetRetries?: number;
}

export interface AlpacaAsset {
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

export interface AlpacaAccount {
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
  options_buying_power?: string;
  options_approved_level?: number;
  options_trading_level?: number;
}

export interface AlpacaAccountConfiguration {
  dtbp_check: string;
  fractional_trading: boolean;
  max_margin_multiplier: string;
  no_shorting: boolean;
  pdt_check: string;
  suspend_trade: boolean;
  trade_confirm_email: string;
  max_options_trading_level?: number;
}

export type AlpacaOrderSide = "buy" | "sell";
export type AlpacaOrderType = "market" | "limit" | "stop" | "stop_limit";
export type AlpacaTimeInForce = "day" | "gtc" | "ioc";
export type AlpacaPositionIntent = "buy_to_open" | "buy_to_close" | "sell_to_open" | "sell_to_close";
export interface AlpacaCreateOrder {
  symbol: string;
  qty?: string;
  notional?: string;
  side: AlpacaOrderSide;
  type: AlpacaOrderType;
  time_in_force: AlpacaTimeInForce;
  limit_price?: string;
  stop_price?: string;
  client_order_id: string;
  order_class?: "simple" | "";
  position_intent?: AlpacaPositionIntent;
}
export interface AlpacaReplaceOrder { qty?: string; time_in_force?: AlpacaTimeInForce; limit_price?: string; stop_price?: string; client_order_id?: string; }
export interface AlpacaOrder {
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
  side: AlpacaOrderSide;
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

export interface AlpacaPosition {
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
export interface AlpacaActivity { id: string; activity_type: string; transaction_time?: string; date?: string; net_amount?: string; symbol?: string; qty?: string; price?: string; order_id?: string; }
export interface AlpacaClock { timestamp: string; is_open: boolean; next_open: string; next_close: string; }

export interface AlpacaBookLevel { p: number; s: number; }
export interface AlpacaOrderbook { t: string; b: AlpacaBookLevel[]; a: AlpacaBookLevel[]; r?: boolean; }
export interface AlpacaLatestQuote { t: string; bp: number; bs: number; ap: number; as: number; }
export interface AlpacaLatestTrade { t: string; p: number; s: number; i: number | string; tks?: "B" | "S"; }
export interface AlpacaBar { t: string; o: number; h: number; l: number; c: number; v: number; n?: number; vw?: number; }
export interface AlpacaSnapshot { latestTrade?: AlpacaLatestTrade; latestQuote?: AlpacaLatestQuote; minuteBar?: AlpacaBar; dailyBar?: AlpacaBar; prevDailyBar?: AlpacaBar; }

export interface AlpacaOptionContract {
  id: string;
  symbol: string;
  name: string;
  status: "active" | "inactive";
  tradable: boolean;
  expiration_date: string;
  root_symbol: string;
  underlying_symbol: string;
  underlying_asset_id: string;
  type: "call" | "put";
  style: "american" | "european";
  strike_price: string;
  size: string;
  open_interest?: string;
  open_interest_date?: string;
  close_price?: string;
  close_price_date?: string;
  /** Penny Program Indicator, returned by current contract responses when available. */
  ppind?: boolean;
}
export interface OptionContractsQuery {
  underlying_symbols?: string;
  status?: "active" | "inactive";
  expiration_date?: string;
  expiration_date_gte?: string;
  expiration_date_lte?: string;
  root_symbol?: string;
  type?: "call" | "put";
  style?: "american" | "european";
  strike_price_gte?: number;
  strike_price_lte?: number;
  page_token?: string;
  limit?: number;
}
export interface ListOrdersQuery { status?: "open" | "closed" | "all"; limit?: number; after?: string; until?: string; direction?: "asc" | "desc"; symbols?: string; side?: AlpacaOrderSide; asset_class?: "us_equity" | "us_option" | "crypto" | "all"; }
export interface ActivitiesQuery { activity_types?: string; category?: "trade_activity" | "non_trade_activity"; order_id?: string; date?: string; until?: string; after?: string; direction?: "asc" | "desc"; page_size?: number; page_token?: string; }
export interface HistoricalQuery { symbols: string; start?: string; end?: string; timeframe?: string; limit?: number; page_token?: string; sort?: "asc" | "desc"; }

export interface AlpacaApiResponse<T> { data: T; requestId?: string; status: number; }
