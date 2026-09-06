# v10.2.0 optimization audit — September 6

The database contained 22 new-version entries with completed broker exits.
One exit belonging to an entry carried over from the previous version is
excluded. New-version results: one win, 21 losses, gross price P&L -$0.020400,
fees $0.190232, net P&L -$0.210632. These are small capped paper trades.

## Evidence correction verified

All 88 observed-entry labels covering the 22 entries match broker fill price
and quantity. There are no mismatches. Four research paths from one entry were
invalidated on PUBLIC_STREAM_DOWN; three longer paths were pending at the
research snapshot. Neither invalid nor pending paths count as profitable.
The current frozen evaluation installed no model.

## What can exit optimization achieve?

For each completed trade, compute an optimistic exit at its maximum recorded
favorable price over its actual holding window. Subtract its actual entry fee
and a 5-bp exit fee at that price:

`best net = filled quantity × maximum favorable price move − entry fee − exit fee`

The sum is still **-$0.139425**, compared with -$0.210632 actually realized.
This hindsight calculation is not a tradable strategy. It assumes recorded
running extrema are complete, ignores exit latency, and even permits an exit
at entry price for trades with no favorable move. It shows that simply moving
the exits within the observed holding windows cannot overcome these entries'
costs. It does not bound a different entry or a longer, unobserved holding path.

One BTC short reached approximately 15.12 bps gross favorable excursion,
about $0.004103 after fees before the additional research reserve, then closed
at -$0.001700. Perfectly capturing that isolated peak would improve total P&L by
only about $0.005803. A lower profit floor is a testable alternative, but that
example is insufficient to fit or promote one. Most trades never earned their
round-trip fees. Only two trades' optimistic best exits were net positive.

## Paired horizon results

| Policy | Completed | Invalid | Pending | Mean net bps |
|---|---:|---:|---:|---:|
| 1 minute | 21 | 1 | 0 | -13.53 |
| 3 minutes | 21 | 1 | 0 | -13.65 |
| 10 minutes | 20 | 1 | 1 | -13.96 |
| 30 minutes | 19 | 1 | 2 | -15.96 |

These use observed broker entries and hypothetical exits with a 3-bp reserve.
They are not realized broker P&L. Unequal completion counts and overlapping
paths mean these means cannot justify choosing the least-negative horizon as
a proven improvement. All four average returns are negative.

## Optimization decision

No new parameter setting or larger size is justified by this evidence. The
priority is a different entry opportunity whose executable price move can
cover costs, measured on separate chronological data. Short-window volatility,
aggressive flow, and favorable excursion alone cannot supply that forecast.
Alternative routes require their own fill-conditioned outcomes rather than
substituting cheaper fees into existing taker fills.

The existing simulator keeps collecting paper trials, as requested. This audit
does not change submission permissions or deploy a strategy change. The actual
entry-evidence correction is verified, but profitability is not established.

[Detailed evidence](../reports/v102-optimization-audit-2026-09-06.json)
