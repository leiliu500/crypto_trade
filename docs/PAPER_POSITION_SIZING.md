# Paper position sizing, v14

The active distributional paper engine uses a $1,000 per-order ceiling, further limited to 1% of current equity and each asset's configured ceiling. On the roughly $100,000 paper account this replaces the old $12 research cap without treating the new ceiling as an order target. The values are project risk choices, not a universal institutional minimum or evidence of a profitable strategy.

`config/base.json` owns `DISTRIBUTIONAL_MAXIMUM_NOTIONAL=1000` and `DISTRIBUTIONAL_MAXIMUM_EQUITY_FRACTION=0.01`. The existing $1,000 per-asset and $5,000 portfolio ceilings remain. The controller still allows one BTC/ETH trade slot, so these settings do not authorize five concurrent $1,000 positions. `DISTRIBUTIONAL_SIZING_MODE=RISK_BOUNDED` is the runtime default; `LEGACY_FIXED` is for reproducing the original $12 experiments.

## Mathematics

For equity E, high-water equity H, configured trade-risk fraction r, drawdown limit D and measured volatility sigma in basis points:

```
notional ceiling = min(1000, symbol ceiling, 0.01 * E)
drawdown = max(0, 1 - E / max(H, E))
risk budget = E * r * (1 - drawdown / D)^2 * min(1, targetSigma / sigma)
loss per unit = price * (stopBps + completeCostBps + jumpSigma * sigma) / 10000
quantity = floor_to_exchange_lot(min(
  notional ceiling / ask,
  risk budget / loss per unit,
  0.01 * min(best bid quantity, best ask quantity),
  exchange maximum quantity
))
```

The implementation uses the existing risk sizer, with a volatility floor to avoid division by zero, and evaluates both directions. A common research context uses the widest declared action stop (60 bp), because any of the six actions can be selected. Complete costs include both fees, spread, impact, adverse selection, configured funding/borrow reserves, latency and the configured cost-error reserve. The jump buffer is additional modeled loss protection. Sizing does not assume a profitable edge or fabricate a Kelly estimate.

At the defaults r=0.001 and D=0.05, an un-drawn-down $100,000 account has at most a $100 modeled trade-loss budget before volatility scaling. The much smaller notional or liquidity ceiling often binds first. These are model-based controls: price gaps, execution outages and funding differences can produce losses beyond a stop or reserve.

If the permitted quantity is below the exchange minimum, it remains zero and the reason is reported. It is never rounded up to force an entry. The planner recalculates the quantity at dispatch using current account equity and the same quote; changed size or costs reject the order. Existing portfolio reservation, loss, liquidity, persistence and positive-net-score gates still apply. Sizing costs are used for the loss budget and are not subtracted again from the model's net-return target.

## Training and restart

Training simulations and selected paper orders use the same sized quantity, including the partial-fill denominator. Decisions, outcomes and checkpoints carry a sizing-policy fingerprint covering the cap, equity fraction, per-asset limits, risk and cost parameters. Incompatible, untagged $12 outcomes cannot enter the new bank.

The actual checkpoint is the configured base filename plus `.sizing-<policy SHA-256>.json`. The original checkpoint and imported $12 artifact are preserved. Startup verifies a supplied training artifact against the active sizing policy; an incompatible legacy artifact is rejected and the existing live bank is retained. Price-history restoration remains separate and usable, since observed prices are not size-dependent fill outcomes. A changed cap/risk/cost policy starts a distinct training bank; restart with the same policy restores it. Existing paper cash, positions and fill history use the existing broker ledger.

The new policy requires its own completed outcomes and qualifying training dates. The size-aware historical replay path reconstructs those outcomes from recorded books and trades using the current sizing policy; it does not relabel old $12 outcomes. Its artifact records the policy, sizing context, source files, fees and instrument rules. Historical labels supply training only and reset prospective validation when they change the effective bank. No date, sample, positive-score or prospective-validation requirement is relaxed. A bank can continue to show zero orders when conditional net-return estimates do not qualify.

## Operational evidence and references

The dashboard reports the configured ceiling, equity fraction, current effective ceiling, proposed quantity and sizing constraint. `npm run config:audit` reports the effective static limits and policy fingerprint; runtime decisions supply the actual account-dependent size.

- [Kraken linear contract specifications](https://support.kraken.com/articles/4844359082772-linear-multi-collateral-derivatives-contract-specifications) describe per-instrument lot/tick limits. Production sizing uses the venue rules already reconciled by the engine.
- [Kraken derivatives fees](https://support.kraken.com/articles/360048917612-fee-schedule) are proportional to executed notional. A larger position does not, at an unchanged tier and execution quality, remove fee drag in basis points.
- [CFTC electronic-trading risk principles](https://www.cftc.gov/LawRegulation/FederalRegister/finalrules/2020-27622.html) discuss venue-level pre-trade controls. This implementation applies explicit order and portfolio limits as engineering controls; it does not claim regulatory certification or applicability of that rule to this account.

Changing the cap addresses position scale and lot feasibility. It does not establish positive expected returns.
