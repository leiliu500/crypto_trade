const trusted = new WeakSet();
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const positive = (value) => finite(value) && value > 0;
const nonnegative = (value) => finite(value) && value >= 0;
const timestamp = (value) => nonnegative(value) && Number.isSafeInteger(value)
    && value <= 8_640_000_000_000_000;
const identifier = (value) => typeof value === "string" && value.length > 0
    && value.length <= 240 && value.trim() === value;
const near = (a, b) => Math.abs(a - b)
    <= 32 * Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
function seal(account) {
    for (const receipt of account.receipts)
        Object.freeze(receipt);
    Object.freeze(account.receipts);
    Object.freeze(account);
    trusted.add(account);
    return account;
}
export function createSpotAccount(initialCashUsd = 100_000) {
    if (!positive(initialCashUsd))
        throw new Error("SPOT_INVALID_INITIAL_CASH");
    return seal({ initialCashUsd, cashUsd: initialCashUsd, quantity: 0, entryCostUsd: 0,
        realizedNetUsd: 0, feesUsd: 0, receipts: [] });
}
function checkFill(fill) {
    if (!fill || !identifier(fill.id) || !["buy", "sell"].includes(fill.side)
        || !positive(fill.quantity) || !positive(fill.price) || !nonnegative(fill.feeBps) || fill.feeBps >= 10_000
        || !timestamp(fill.timestampMs))
        throw new Error("SPOT_INVALID_FILL");
}
function sameFill(a, b) {
    return a.id === b.id && a.side === b.side && a.quantity === b.quantity && a.price === b.price
        && a.feeBps === b.feeBps && a.timestampMs === b.timestampMs;
}
function transact(account, fill) {
    if (fill.timestampMs < (account.receipts.at(-1)?.timestampMs ?? 0))
        throw new Error("SPOT_REVERSED_FILL_TIME");
    const notional = fill.quantity * fill.price;
    const fee = notional * (fill.feeBps / 10_000);
    if (!positive(notional) || !nonnegative(fee))
        throw new Error("SPOT_ARITHMETIC_OVERFLOW");
    let cashUsd, quantity, entryCostUsd;
    let realizedNetUsd = account.realizedNetUsd;
    if (fill.side === "buy") {
        const debit = notional + fee;
        // Tolerance never grants extra buying power or forgives a cash deficit.
        if (debit > account.cashUsd)
            throw new Error("SPOT_INSUFFICIENT_CASH");
        cashUsd = account.cashUsd - debit;
        quantity = account.quantity + fill.quantity;
        entryCostUsd = account.entryCostUsd + debit;
        if (cashUsd === account.cashUsd || quantity === account.quantity || entryCostUsd === account.entryCostUsd)
            throw new Error("SPOT_UNREPRESENTABLE_FILL");
    }
    else {
        if (fill.quantity > account.quantity)
            throw new Error("SPOT_INSUFFICIENT_INVENTORY");
        const allocatedCost = fill.quantity === account.quantity ? account.entryCostUsd
            : account.entryCostUsd * (fill.quantity / account.quantity);
        const proceeds = notional - fee;
        cashUsd = account.cashUsd + proceeds;
        quantity = account.quantity - fill.quantity;
        entryCostUsd = account.entryCostUsd - allocatedCost;
        realizedNetUsd += proceeds - allocatedCost;
        if (quantity === account.quantity || proceeds !== 0 && cashUsd === account.cashUsd)
            throw new Error("SPOT_UNREPRESENTABLE_FILL");
    }
    const feesUsd = account.feesUsd + fee;
    if (![cashUsd, quantity, entryCostUsd, feesUsd].every(nonnegative) || !finite(realizedNetUsd))
        throw new Error("SPOT_ARITHMETIC_OVERFLOW_OR_CASH_DEFICIT");
    return seal({ initialCashUsd: account.initialCashUsd, cashUsd, quantity, entryCostUsd,
        realizedNetUsd, feesUsd, receipts: [...account.receipts, { ...fill }] });
}
/** Restored JSON is reconciled to its receipts; rounded aggregates cannot create capital. */
function checkedAccount(account) {
    if (!account || typeof account !== "object")
        throw new Error("SPOT_INVALID_ACCOUNT");
    if (trusted.has(account))
        return account;
    if (!positive(account.initialCashUsd) || !Array.isArray(account.receipts)
        || ![account.cashUsd, account.quantity, account.entryCostUsd, account.feesUsd].every(nonnegative)
        || !finite(account.realizedNetUsd))
        throw new Error("SPOT_INVALID_ACCOUNT");
    let restored = createSpotAccount(account.initialCashUsd);
    const seen = new Set();
    for (const fill of account.receipts) {
        checkFill(fill);
        if (seen.has(fill.id))
            throw new Error("SPOT_DUPLICATE_RECEIPT");
        seen.add(fill.id);
        restored = transact(restored, fill);
    }
    const fields = ["cashUsd", "quantity", "entryCostUsd", "realizedNetUsd", "feesUsd"];
    if (fields.some(field => !near(restored[field], account[field])))
        throw new Error("SPOT_ACCOUNT_RECONCILIATION_FAILED");
    return restored;
}
export function applySpotFill(account, fill) {
    const current = checkedAccount(account);
    checkFill(fill);
    const previous = current.receipts.find(receipt => receipt.id === fill.id);
    if (previous) {
        if (sameFill(previous, fill))
            return current;
        throw new Error("SPOT_CONFLICTING_FILL_ID");
    }
    return transact(current, fill);
}
export function markSpotAccount(account, bid, exitFeeBps) {
    const current = checkedAccount(account);
    if (!positive(bid) || !nonnegative(exitFeeBps) || exitFeeBps >= 10_000)
        throw new Error("SPOT_INVALID_MARK");
    const inventoryValue = current.quantity * bid;
    const exitFee = inventoryValue * (exitFeeBps / 10_000);
    const equityUsd = current.cashUsd + inventoryValue;
    const liquidationEquityUsd = current.cashUsd + (inventoryValue - exitFee);
    const unrealizedNetUsd = inventoryValue - exitFee - current.entryCostUsd;
    const netPnlUsd = liquidationEquityUsd - current.initialCashUsd;
    if (![equityUsd, liquidationEquityUsd, unrealizedNetUsd, netPnlUsd].every(finite))
        throw new Error("SPOT_ARITHMETIC_OVERFLOW");
    return { equityUsd, liquidationEquityUsd, unrealizedNetUsd, netPnlUsd };
}
function validDepth(levels, direction, tickSize) {
    return Array.isArray(levels) && levels.length > 0 && levels.every((level, i) => {
        if (!Array.isArray(level) || level.length !== 2 || !positive(level[0]) || !positive(level[1]))
            return false;
        const ticks = level[0] / tickSize;
        return Number.isSafeInteger(Math.round(ticks)) && near(ticks, Math.round(ticks))
            && (i === 0 || direction * (level[0] - levels[i - 1][0]) > 0);
    });
}
function sweep(levels, quantity) {
    let remaining = quantity, notional = 0;
    for (const [price, displayed] of levels) {
        const executed = Math.min(displayed, remaining);
        notional += executed * price;
        remaining -= executed;
        if (remaining === 0)
            break;
    }
    return remaining === 0 && positive(notional) ? notional / quantity : null;
}
/**
 * Simulated marketable IOC: fresh, uncrossed L2, a 10 bps collar from the best price,
 * and at most 5% of total displayed quantity inside that collar. The book walk uses
 * actual displayed levels; it adds no invented depth or separate slippage charge.
 * Partial quantity is allowed, subject to exchange lot and minimum-order rules.
 */
export function planSpotPaperFill(input) {
    let visibleNotionalUsd = 0;
    const deny = (reason) => ({ fill: null, reason, visibleNotionalUsd });
    if (!input || !["buy", "sell"].includes(input.side) || !identifier(input.id)
        || !timestamp(input.nowMs) || !nonnegative(input.feeBps) || input.feeBps >= 10_000
        || input.budgetUsd !== undefined && !positive(input.budgetUsd)
        || input.quantity !== undefined && (!positive(input.quantity) || input.side !== "sell"))
        return deny("INVALID_INPUT");
    let account;
    try {
        account = checkedAccount(input.account);
    }
    catch {
        return deny("INVALID_ACCOUNT");
    }
    if (account.receipts.some(fill => fill.id === input.id))
        return deny("FILL_ID_ALREADY_USED");
    if (input.nowMs < (account.receipts.at(-1)?.timestampMs ?? 0))
        return deny("REVERSED_FILL_TIME");
    const { book, rules, side } = input;
    if (!rules || ![rules.lotSize, rules.minimumQuantity, rules.tickSize].every(positive)
        || !nonnegative(rules.minimumNotionalUsd))
        return deny("INVALID_RULES");
    if (!book || !timestamp(book.receivedAtMs) || book.receivedAtMs > input.nowMs
        || input.nowMs - book.receivedAtMs > 5_000)
        return deny("STALE_OR_FUTURE_BOOK");
    if (!validDepth(book.bids, -1, rules.tickSize) || !validDepth(book.asks, 1, rules.tickSize)
        || book.bids[0][0] >= book.asks[0][0])
        return deny("INVALID_BOOK");
    const depth = side === "buy" ? book.asks : book.bids;
    const best = depth[0][0];
    // Compare quoted price distances; no rounding may widen the price collar.
    const levels = depth.filter(([price]) => side === "buy" ? price - best <= best * 0.001
        : best - price <= best * 0.001);
    let visibleQuantity = 0;
    for (const [price, quantity] of levels) {
        visibleQuantity += quantity;
        visibleNotionalUsd += price * quantity;
    }
    if (!positive(visibleQuantity) || !positive(visibleNotionalUsd)) {
        visibleNotionalUsd = 0;
        return deny("INVALID_BOOK_ARITHMETIC");
    }
    const quantityCap = Math.min(visibleQuantity * 0.05, side === "sell" ? Math.min(account.quantity, input.quantity ?? account.quantity) : Infinity);
    const lots = Math.floor(quantityCap / rules.lotSize);
    if (!Number.isSafeInteger(lots))
        return deny("UNREPRESENTABLE_LOT_COUNT");
    const budget = side === "buy" ? Math.min(account.cashUsd, input.budgetUsd ?? account.cashUsd)
        : input.budgetUsd ?? Infinity;
    // Search discrete lots against the same quantity * VWAP arithmetic used by the ledger.
    // This keeps fee-inclusive purchases strictly within available cash despite roundoff.
    const candidate = (count) => {
        const quantity = count * rules.lotSize;
        if (!(quantity > 0) || quantity > quantityCap)
            return null;
        const price = sweep(levels, quantity);
        if (price === null || !positive(price))
            return null;
        const notional = quantity * price, fee = notional * (input.feeBps / 10_000);
        if (!positive(notional) || !nonnegative(fee))
            return null;
        if (side === "buy" ? notional + fee > budget : notional > budget || account.cashUsd + (notional - fee) < 0)
            return null;
        return { id: input.id, side, quantity, price, feeBps: input.feeBps, timestampMs: input.nowMs };
    };
    let low = 0, high = lots;
    while (low < high) {
        const middle = low + Math.ceil((high - low) / 2);
        if (candidate(middle))
            low = middle;
        else
            high = middle - 1;
    }
    const fill = candidate(low);
    if (!fill || fill.quantity < rules.minimumQuantity || fill.quantity * fill.price < rules.minimumNotionalUsd)
        return deny("BELOW_MINIMUM_EXECUTABLE_ORDER");
    // A paper plan must also be representable by the actual receipt ledger.
    try {
        applySpotFill(account, fill);
    }
    catch {
        return deny("UNREPRESENTABLE_FILL");
    }
    return { fill, reason: "PAPER_FILL_PLANNED", visibleNotionalUsd };
}
//# sourceMappingURL=account.js.map