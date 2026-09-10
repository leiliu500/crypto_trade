# Registered candidate: cost-aware BTC/ETH momentum rotation

Registered before inspecting development, validation, or final-period outcomes.

The strategy holds either BTC, ETH, or cash in funded spot. It never shorts or
borrows. It attempts to retain persistent trends while requiring a material
advantage before rotating between assets. A signal at a completed daily close
may only execute at a later daily open through the shared evaluator.

## Mathematics

For asset `a` and completed daily close `C[a,t]`, define:

- momentum: `m[a,t] = log(C[a,t] / C[a,t-L])`;
- forecast score: `q[a,t] = (30 / L) * m[a,t]`;
- trend floor: arithmetic mean of the latest `T` completed closes;
- nominal base round-trip friction: `r = 2 * (0.008 + 0.0003) = 0.0166`.

The forecast score is a deliberately simple momentum extrapolation over 30
days. It is a ranking statistic, not an estimated probability or a promised
return. The nominal cost hurdle is approximate; actual execution costs and
returns must come from the shared accounting evaluator.

A cash account may enter an asset only when its close exceeds its trend floor
by 0.5% and `q > 1.5*r`. Choose the eligible asset with the larger score, with BTC
winning an exact tie. Insufficient lookback forces cash.

An incumbent position remains held while its close is at least 0.995 times its
trend floor and its momentum is positive. This creates an entry/exit hysteresis
band. An otherwise valid incumbent rotates into the other eligible asset only
when the contender's forecast score exceeds the incumbent's by more than
`1.5*r`. If the incumbent becomes invalid, choose the best eligible asset or
cash. There is no automatic return to a previously held asset.

The same fixed signal thresholds apply under base and stress execution costs;
stress is an evaluation scenario, not a retuned strategy. Position size is
determined solely by the shared $10,000 account and at-most-$1,000 total entry
notional protocol. No signal-level leverage, pyramiding, or dynamic cap changes
are allowed.

## Four variants fixed before outcomes

| Variant | Momentum lookback L | Trend length T |
|---|---:|---:|
| rotation_m60_t60 | 60 days | 60 days |
| rotation_m60_t90 | 60 days | 90 days |
| rotation_m90_t60 | 90 days | 60 days |
| rotation_m90_t90 | 90 days | 90 days |

Pre-outcome data-availability amendment: trend lengths were initially proposed
as 120/180 days. The root established that native daily history begins only
about 103 days before development. They are therefore fixed at 60/90 days
before any outcome is inspected, so every variant can initialize before the
same development start. Momentum lookbacks remain 60/90 days.

The entire grid is disclosed. Select exactly one variant by development stress
net profit minus one-half of maximum dollar drawdown; ties resolve in table
order. Evaluate selection on the root's later chronological windows without
changing formulas, thresholds, or parameters.

## Scope and limitations

Development is 2025-01-01 through 2025-06-30. Validation starts 2025-07-01 and
ends 2025-12-31. Final evaluation starts 2026-01-01 and ends at the latest
completed available daily candle. Earlier observations may initialize signals
but may not create trades inside a later window before its permitted start.
The available history has been reused by earlier system research, so these are
chronological evaluation windows rather than a genuinely untouched holdout.

Daily OHLC permits comparison of delayed daily executions, not a claim about
intraday fills, available order-book depth, or executable stop-loss paths.
Rotation can lose to cash in bear markets, pay repeated fees in choppy markets,
and lag buy-and-hold in sustained bull markets. Both completed trades and
terminal liquidation must be reported; generating an entry is not evidence of
profitability.

The root's common API introduces a deliberately conservative additional
execution delay: a target after close `i` fills at open `i+2` in base and open
`i+3` in stress. The signal's incumbent is its intended allocation; the shared
evaluator is authoritative for actual delayed positions and fills.
