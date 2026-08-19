import { numberToDecimal } from "../core/decimal.js";
import type { ExecutionPlan } from "../execution/planner.js";
import type { AlpacaOrder } from "./types.js";
import { AlpacaRestClient } from "./rest.js";

const ALPACA_CRYPTO_MAXIMUM_DECIMAL_PLACES = 9;

export interface OrderGateway {
  send(plan: ExecutionPlan): Promise<AlpacaOrder>;
  cancel(orderId: string): Promise<void>;
  cancelAll(): Promise<void>;
}

export class AlpacaOrderGateway implements OrderGateway {
  public constructor(private readonly rest: AlpacaRestClient) {}
  public async send(plan: ExecutionPlan): Promise<AlpacaOrder> {
    // Both maker and taker paths are capped limit orders. Taker uses IOC and a
    // book-walk-derived worst price; no uncapped market order is emitted.
    const response = await this.rest.createOrder({
      symbol: plan.symbol,
      qty: numberToDecimal(plan.qty, ALPACA_CRYPTO_MAXIMUM_DECIMAL_PLACES),
      side: plan.side === 1 ? "buy" : "sell",
      type: "limit",
      time_in_force: plan.timeInForce,
      limit_price: numberToDecimal(plan.limitPx, ALPACA_CRYPTO_MAXIMUM_DECIMAL_PLACES),
      client_order_id: plan.clientOrderId,
      order_class: "simple",
    });
    return response.data;
  }
  public async cancel(orderId: string): Promise<void> { await this.rest.cancelOrder(orderId); }
  public async cancelAll(): Promise<void> { await this.rest.cancelAllOrders(); }
}
