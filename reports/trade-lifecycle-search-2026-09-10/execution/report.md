# BTC and ETH execution review — 2026-09-10

Research only. No runtime, configuration, service, order, or frozen ETH40 rule changed. This review does not select an execution method by profit. The historical study should retain its declared taker proxies and two execution delays; passive execution cannot be ranked from its daily OHLC data.

## What the services actually do

| Area | BTC weekly paper service | ETH40 daily paper service |
|---|---|---|
| Quote evidence | REST depth; age of the locally completed response must be at most 5 seconds. Level last-change timestamps are deliberately not presented as a live heartbeat. | Locally checked WebSocket top-10 CRC32, connection identity, local receipt age at most 5 seconds, exchange update age at most 5 seconds, exchange clock lead at most 1 second. |
| Order lifecycle | Durable paper submission, then local acceptance and IOC settlement; request older than 30 seconds is canceled. Terminal status can be CANCELED with a partial fill. | Direct guarded hypothetical fill in the committed cycle; no submitted, resting, or venue cancellation lifecycle. |
| Timing | Continuous five-minute evaluation of a delayed weekly signal. A pending request is recovered before another request. Buy policy is checked again at settlement. | First 60 seconds of a UTC day; eligible signal candle is two daily opens earlier. Missed windows are never filled retrospectively. |
| Partial inventory | First partial entry consumes the weekly entry; no additions. Exits retry with fresh books. | One fill per account per day; no additions. Partial exit residue remains open until a later eligible cash-target day. |
| Actual venue trading | None. Order acknowledgments and receipts are paper events. | None. Receipts are paper events. |

Evidence: `src/spot-trend/market.ts:91`, `paper.ts:57`, `paper.ts:146`, `orders.ts:160`, `orders.ts:209`; `src/eth40/market.ts:65`, `market.ts:348`, `engine.ts:136`, `engine.ts:169`. Source hashes are in `audit.json`.

Both use `src/spot-trend/account.ts:202`: an ordered, positive, tick-aligned, uncrossed book; a 10bp collar measured from the executable best ask/bid; at most 5% of displayed quantity within that collar; lot/minimum checks; a book walk; and fee-inclusive cash limits. The collar does **not** cap the spread measured from midpoint. The planner assumes captured displayed liquidity remains available; it does not measure competition, queue priority, transport latency, or subsequent cancellation of that liquidity. Forward book walking adds no separate invented 3bp slippage. Historical 3bp/10bp assumptions are different execution proxies.

Receipt replay, duplicate identity checks, and cash/inventory reconciliation are useful paper controls (`account.ts:92`, `orders.ts:96`, `engine.ts:36`). They do not reconcile private venue orders. BTC local cancellation can append a synthetic ACCEPTED event; that is not venue acknowledgment. Its long local client IDs would also require a venue-compatible mapping. A BTC pending sell is not subjected to the buy-only signal invalidation rule at settlement. This is a policy distinction to preserve or explicitly redesign, not proof of an erroneous sell.

ETH rules and quotes are asset-specific, including independent metadata timestamps. BTC benchmark data failure must not prevent otherwise valid ETH execution. WAITING/HOLD decisions can return before quote/rules checks, so those decisions are not market-readiness certificates. Bid less exit fee is a valuation convention, not proof that the entire inventory could immediately liquidate at best bid.

The deployed BTC account starts with $100,000, while ETH40 accounts start with $10,000; allocation rules differ. Their raw P&L should not be used to select an execution implementation. The joint study must retain its own matched capital and sizing protocol.

## Current venue capabilities and their limits

Kraken REST supports market, limit, and conditional order families. Post-only applies to limits. IOC cancels an immediately unfilled remainder; FOK requires immediate full execution. GTD expires an order; REST `deadline` instead rejects a late new-order request and accepts a timestamp 2–60 seconds ahead. Validation-only requests do not trade. Therefore a request deadline cannot replace a resting-order timeout. [Kraken Add Order](https://docs.kraken.com/api-reference/trading/add-order)

Amendment retains order IDs and preserves queue priority where possible, not unconditionally. A post-only price amendment can reject a change that would take liquidity. Do not assume repeated repricing keeps the original queue position. [Kraken Amend Order](https://docs.kraken.com/api-reference/trading/amend-order)

Cancellation addresses an open order by venue or client identity. Engineering implication: a lost response or cancellation request alone is insufficient evidence to submit a replacement; reconcile terminal status and cumulative executions first. [Kraken Cancel Order](https://docs.kraken.com/api-reference/trading/cancel-order)

Kraken's dead-man timer cancels the client's orders on expiry and needs periodic renewal. Its broad scope must be understood before mixing strategies. It is a disconnect safeguard, not the per-order strategy timeout. [Kraken Cancel All Orders After](https://docs.kraken.com/api-reference/trading/cancel-all-orders-after-x)

The public Spot Crypto Tier 1 schedule checked on this date is 0.40% maker and 0.80% taker. These are research assumptions, not a verified fee tier for this account. [Kraken fee schedule](https://www.kraken.com/features/fee-schedule)

## Concrete alternatives to investigate

**E01: Immediate guarded marketable limit with IOC.** Keep fresh pair-specific quote/rules, fee-inclusive allocation, a fixed maximum acceptable price, depth participation, and a current signal check immediately before submission. A future venue adapter must reserve funds and persist intent before sending; reconcile each actual fill, fee currency, and unfilled remainder afterward. A timeout is an unknown submission outcome until resolved. Accept partial quantities only according to the preregistered inventory policy. FOK is an optional all-or-none variant when a partial position is undesirable; its rejection rate cannot be inferred here.

For BTC, this best matches the existing paper IOC semantics, but authenticated execution evidence and stronger market freshness would be new work. For ETH, it best matches the current guarded paper fill, while a real order lifecycle would still be new work. This is the appropriate common historical proxy, not a proven profitable execution choice.

**E02: One bounded passive attempt, then cancel and reconcile.** A concrete, unvalidated experiment could place one post-only buy at the observed best bid or sell at the observed best ask, with no chasing and a 20-second maximum rest. Cancel sooner if the entry signal becomes invalid, quote evidence fails, or the execution window closes. Use exchange expiry as a backstop where supported. After a terminal result and full reconciliation, either stop or make at most one separately permitted IOC attempt for the remaining quantity, with a newly checked signal, budget, price ceiling, and quote. Unknown state blocks the fallback.

The 20 seconds is a prospective test definition, not an optimized duration. BTC's five-minute recorder and ETH's roughly 30-second observations cannot resolve this experiment's event path: it needs event-level recording. A partial passive entry already consumes the current no-additions allowance in both frozen services. An additional fallback after that partial entry would therefore require a **new experiment**, and cannot be presented as unchanged ETH40 or BTC behavior. ETH also cannot extend its first-minute window or refill a missed day. A passive risk exit must have an explicit urgency/deadline policy; reduced maker fees do not prove waiting to exit is beneficial.

**E03: Do not submit, or cancel without fallback.** This is a valid outcome when the signal is expired, the guarded price is unavailable, the book/rules cannot be verified, the remainder is below minimum size, funds are reserved by an unresolved order, or the window has closed. An unfilled canceled entry has no acquired inventory and no trading fee in the illustrative ledger. A canceled partially filled order still has inventory and paid fees; it is not a canceled trade. Residual holdings must remain visible until actually sold.

No evidence here supports selecting a looser collar or longer passive timeout for one asset. Compare BTC and ETH separately by spread in basis points, depth at the *same dollar size*, fill shortfall, and conditional subsequent returns. Higher ETH volatility alone does not establish a maker advantage; a lower BTC spread alone does not establish a higher fill probability.

## Economics and required evidence

For reference prices before adverse slippage, equal-leg costs give

`required exit / entry = (1 + entry fee)(1 + entry slippage) / ((1 - exit fee)(1 - exit slippage))`.

| Proxy per leg | Break-even reference-price rise | P&L on $1,000 fee-inclusive entry budget, flat reference price |
|---|---:|---:|
| 80bp fee + 3bp slippage | 1.673889% | −$16.463315 |
| 100bp fee + 10bp slippage | 2.224447% | −$21.760418 |

A 1% rise still loses $6.63/$11.98 respectively. Costs recur on every completed round trip, making frequent small-target trading particularly demanding. This algebra does not predict return frequency or establish that long holding will profit. With equal entry budget and identical exit, the 40bp versus 80bp entry fee benefit is erased by a 39.840637bp worse entry price. Spread improvement could change that comparison, but it must be measured. The script's maker-fee illustration is deliberately not included in the historical ranking.

Before choosing E02 over E01, record every eligible opportunity, including rejected and unfilled ones: asset, signal identity/availability/expiry, target quantity, budget and reserves, decision-time midpoint/spread/depth, sequence/checksum and local/exchange timestamps, outbound request/acknowledgment times, IDs, amendments, cancellation requests, terminal status, cumulative fills, and fees. Record subsequent midpoint at fixed preregistered horizons such as 1/5/30/60 seconds, and mark missing observations rather than interpolate. Separate execution cost versus the decision midpoint from subsequent price movement and from unfilled opportunity cost.

Kraken's authenticated executions feed supplies order events, execution identity, cumulative quantity/cost, actual fees, maker/taker indicator, and subscription sequence. Its default snapshot contains open orders and the latest 50 trades, so a long disconnect requires additional history reconciliation rather than assuming the snapshot is complete. [Kraken executions feed](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/executions)

Public books and trades can support conservative queue models, but cannot prove one's actual passive priority or fill. Paper experiments must label modeled fills and bounds. Actual fill-rate and fee claims require authorized venue execution records; none were requested or created in this review. Expected payoff depends on both fill probability and the conditional payoff of filled opportunities. Selection on filled orders alone can hide missed winners and unfavorable fills. Use an all-opportunity denominator and matched prospective assignment rather than cherry-picking filled orders.

Run `python3 reports/trade-lifecycle-search-2026-09-10/execution/cost_checks.py`. All assertions pass. `cost-checks-output.json` contains reproducible decimal accounting, a cancellation-race example, duplicate-event checks, and explicitly assumed payoff examples. No strategy returns, empirical fill probabilities, or maker profitability are estimated.
