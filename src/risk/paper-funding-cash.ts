import type { KrakenPaperHistory } from "../kraken/paper-broker.js";
import { validatePaperFundingState, type PaperFundingState } from "../kraken/paper-funding.js";

export type PaperFundingHistory = NonNullable<KrakenPaperHistory["funding"]>;
interface Prefix { times: number[]; cash: number[] }
const cache = new WeakMap<PaperFundingState, Prefix>();
const index = (times: readonly number[], atMs: number, inclusive: boolean): number => {
  let lo = 0, hi = times.length;
  while (lo < hi) { const m = Math.floor((lo + hi) / 2);
    if (times[m]! < atMs || inclusive && times[m] === atMs) lo = m + 1; else hi = m; }
  return lo;
};
/** Funding CASH is dated when the atomic paper broker posting changes cash.
 * This deliberately does not backdate late corrections or call open accrual a
 * realized cash flow. The separately exposed accrual keeps that distinction. */
export function paperFundingCashWindow(history: PaperFundingHistory, fromMs: number, toMs: number,
  includeFrom: boolean, unknownPreEpochExposure: boolean) {
  const { state, snapshot } = history;
  const unknown = (reason: string) => ({ known: false as const, cashUsd: null, reason });
  if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs) || toMs < fromMs
    || !validatePaperFundingState(state) || !snapshot || snapshot.startedAtMs !== state.config.startedAtMs
    || snapshot.asOfMs > toMs || snapshot.asOfMs < state.lastObservedAtMs
    || snapshot.asOfMs < toMs - 1_000) return unknown("PAPER_FUNDING_EVIDENCE_INVALID_OR_STALE");
  if (history.priorHistoryFundingUnknown && fromMs < snapshot.startedAtMs && unknownPreEpochExposure)
    return unknown("PAPER_FUNDING_PRE_EPOCH_EXPOSURE_UNKNOWN");
  if (!snapshot.fundingAccountingKnown) return unknown("PAPER_FUNDING_RATES_OR_CASH_POSTINGS_INCOMPLETE");
  let prefix = cache.get(state);
  if (!prefix) {
    const postings = state.events.flatMap(event => event.type === "POSTING" ? [event.posting] : [])
      .sort((a, b) => a.postedAtMs - b.postedAtMs || a.id.localeCompare(b.id));
    prefix = { times: [], cash: [0] };
    for (const posting of postings) {
      prefix.times.push(posting.postedAtMs); prefix.cash.push(prefix.cash.at(-1)! + posting.cashDeltaUsd);
    }
    cache.set(state, prefix);
  }
  const first = index(prefix.times, fromMs, !includeFrom), last = index(prefix.times, toMs, true);
  const cashUsd = prefix.cash[last]! - prefix.cash[first]!;
  return Number.isFinite(cashUsd) ? { known: true as const, cashUsd, reason: null }
    : unknown("PAPER_FUNDING_NONFINITE_CASH_WINDOW");
}
