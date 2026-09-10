The frozen HMM candidate is **behaviorally identical to passive ETH after warmup**. It targets cash for the first 90 bars and ETH for all 630 remaining bars. Its full trade, order and equity ledgers exactly match ETH buy-and-hold in all 16 window/scenario comparisons, including the continuous replay. This is a failure of the specific fitted model and decision rule, not evidence that every hidden Markov approach fails.

The initial 90 log returns are the entire parameter-training sample. Their first/last close dates are 2024-09-20 and 2024-12-19. The fitted daily log-return means are:

| State | Fitted mean daily log return | Probability of staying in state | 14-day expected log return starting entirely in this state |
|---|---:|---:|---:|
| 1 | -0.1933% | 79.41% | +2.9726% |
| 2 | -0.1095% | 79.62% | +3.1805% |
| 3 | +1.2077% | 77.56% | +5.8307% |

The positive state's fitted mean is large enough, and the transitions into it frequent enough, that **all three 14-day forecasts exceed the 1.6600% log-cost entry hurdle**. Even a posterior that is certain about either negative-mean state still predicts sufficient subsequent recovery to buy. The model fixes these transition/emission parameters forever after the initial training window.

This is stronger than observing no exits in one price sample. Let `v = sum(k=1..14) A^k * mu`. The forecast is `alpha * v`, where each filtered state probability is nonnegative and the probabilities sum to one. Therefore every forecast is a convex combination of the three values in the table. Their minimum is 2.9726%, above the entry hurdle. **For every valid posterior under this frozen fit, the target is ETH and the nonpositive-forecast exit is unreachable.** The actual later posterior changes, but its forecast ranges only from 3.4439% to 5.8307%.

The continuous 2025–September 2026 net result is $-296.88 base and $-330.71 under cost plus delay, exactly the costed passive ETH outcome. A mathematically different inference engine thus produced no different trading decisions here. It can count as an implemented inference mechanism; it does not establish a distinct effective allocation policy or a profitable new system in this fitted instance.

The [machine-readable diagnostic](hmm-diagnostic.json) preserves parameters, transition probabilities, the algebraic bound, all target counts, exact ledger comparisons and source hashes. I recomputed the original fit and filter solely to diagnose the frozen result. No parameter, horizon, entry rule, exit rule or model code was changed. Any redesigned fit or decision rule would be a new registered trial; no such retuning was performed.
