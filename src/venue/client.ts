import type { ExecutionPlan } from "../execution/planner.js";
import type {
  ActivitiesQuery, HistoricalQuery, ListOrdersQuery, VenueAccount, VenueAccountConfiguration, VenueActivity,
  VenueApiResponse, VenueAsset, VenueClock, VenueOrder, VenueOrderbook, VenuePosition, VenueSnapshot,
} from "./types.js";

export class VenueApiError extends Error {
  public constructor(message: string, public readonly status: number, public readonly requestId?: string,
    public readonly timedOut = false) { super(message); }
}

export interface OrderGateway {
  send(plan: ExecutionPlan): Promise<VenueOrder>;
  cancel(orderId: string): Promise<void>;
  cancelAll(): Promise<void>;
}

export interface VenueClient {
  getAccount(): Promise<VenueApiResponse<VenueAccount>>;
  getAccountConfiguration(): Promise<VenueApiResponse<VenueAccountConfiguration>>;
  getClock(): Promise<VenueApiResponse<VenueClock>>;
  listAssets(query?: { status?: string; asset_class?: string; exchange?: string }): Promise<VenueApiResponse<VenueAsset[]>>;
  getAsset(symbolOrId: string): Promise<VenueApiResponse<VenueAsset>>;
  listOrders(query?: ListOrdersQuery): Promise<VenueApiResponse<VenueOrder[]>>;
  getOrder(orderId: string): Promise<VenueApiResponse<VenueOrder>>;
  getOrderByClientId(clientOrderId: string): Promise<VenueApiResponse<VenueOrder>>;
  listPositions(): Promise<VenueApiResponse<VenuePosition[]>>;
  getPortfolioHistory(query?: { period?: string; timeframe?: string; date_end?: string; extended_hours?: boolean }): Promise<VenueApiResponse<unknown>>;
  getActivities(query?: ActivitiesQuery): Promise<VenueApiResponse<VenueActivity[]>>;
  latestOrderbooks(symbols: readonly string[]): Promise<VenueApiResponse<{ orderbooks: Record<string, VenueOrderbook> }>>;
  snapshots(symbols: readonly string[]): Promise<VenueApiResponse<{ snapshots: Record<string, VenueSnapshot> }>>;
  latestQuotes(symbols: readonly string[]): Promise<VenueApiResponse<unknown>>;
  latestTrades(symbols: readonly string[]): Promise<VenueApiResponse<unknown>>;
  latestBars(symbols: readonly string[]): Promise<VenueApiResponse<unknown>>;
  bars(query: HistoricalQuery): Promise<VenueApiResponse<unknown>>;
}
