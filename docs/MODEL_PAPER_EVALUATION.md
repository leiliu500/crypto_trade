# Model-only paper evaluation

Configuration `btc-eth-model-evaluation-v10.4.0` uses BTC/ETH model forecasts as
the only source of new entries. `MODEL_ONLY_ENTRIES=true` is the configuration
default and is enabled in Compose. Missing, stale, untrained, or out-of-domain
forecasts cannot fall back to breakout/retest or other rule entries. Existing
positions retain their stop, target, and deadline exits.

Compose also enables `CROSS_ASSET_PAPER_EVALUATION_ENABLED=true`. Direct config
loading defaults this separate permission off. With both paper submission and
evaluation enabled, a trained model's fresh nonzero directional forecast can
create a paper entry even if its cost or uncertainty screen fails. Evaluation
does not change the forecast's `eligible`, `reason`, or negative net score. The
planner records exact costs and negative expected values as calculated, while
allowing this explicit experiment through expected-value and reward/risk gates.
Training, domain, freshness, current direction, liquidity, depth, venue lot size,
account health, portfolio, position, and cooldown checks remain required.

Each entry is capped at $12, shares the 30-minute per-symbol attempt cooldown,
and uses a best-quote IOC. The fixed `trend-15m` policy uses a 30 bp stop, 45 bp
net target, and 15-minute deadline. These are simulated paper orders with actual
paper-broker fills and both execution fees recorded; profitability is unproven.

Evaluation orders carry `crossAssetEntryMode=PAPER_EVALUATION`, an
`:EVALUATION:` regime, and the full immutable forecast snapshot. The forecast
and mode are retained on dashboard order cards and in PostgreSQL order records,
and on the paired 15/30-minute observations anchored to actual entry fills.
Qualified model entries retain a separate cohort. Paired alternative exits are
hypothetical; realized P&L comes from completed broker trades.

The dashboard shows model-only entry permission, evaluation mode, forecast
direction and score at entry, entry attempts, fills, open/closed/unresolved
trades, closed-trade fees, wins, and realized P&L for available model history.
Legacy trades remain visible as history but do not enter model result totals.
Evaluate outcomes chronologically before changing parameters; these changes do
not automatically tune the model from a small sample of paper trades.

Set `CROSS_ASSET_PAPER_EVALUATION_ENABLED=false` to require the original positive
cost/uncertainty screen and exact order economics. Model-only entry permission
remains in effect, so failing forecasts produce no new entries.
