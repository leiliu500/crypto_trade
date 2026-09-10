"""Frozen ETH HMM-inspired research targets; no market reads or execution.

The first 90 returns train a regularized three-state Gaussian HMM. Thereafter
the parameters never change and only the forward state filter is updated.
"""
import itertools
import json
import math
from pathlib import Path

SPEC = json.loads(Path(__file__).with_name("hmm-spec.json").read_text())
N = SPEC["stateCount"]
TRAIN = SPEC["trainingReturnCount"]
VAR_FLOOR = SPEC["minimumStandardDeviation"] ** 2
DAY = 86_400_000


def logsumexp(values):
    top = max(values)
    return top + math.log(sum(math.exp(x - top) for x in values))


def emission(value, mean, variance):
    return -.5 * (math.log(2 * math.pi * variance)
                  + (value - mean) ** 2 / variance)


def forward(values, model):
    """Normalized log alpha, normalizers and joint log likelihood."""
    means, variances, transition = model["means"], model["variances"], model["transition"]
    log_a = [[math.log(x) for x in row] for row in transition]
    alphas, normalizers = [], []
    for t, value in enumerate(values):
        predicted = [math.log(model["initial"][j]) if t == 0 else
                     logsumexp([alphas[-1][i] + log_a[i][j] for i in range(N)])
                     for j in range(N)]
        raw = [predicted[j] + emission(value, means[j], variances[j]) for j in range(N)]
        scale = logsumexp(raw)
        alphas.append([x - scale for x in raw])
        normalizers.append(scale)
    return alphas, normalizers, sum(normalizers)


def fit(values):
    """Regularized EM; accepts exactly the initial observed training window."""
    if len(values) != TRAIN or not all(math.isfinite(x) for x in values):
        raise ValueError("HMM_REQUIRES_EXACT_FINITE_TRAINING_WINDOW")
    mean = sum(values) / TRAIN
    global_variance = max(VAR_FLOOR, sum((x - mean) ** 2 for x in values) / TRAIN)
    ordered = sorted(values)
    model = {
        "means": [ordered[math.ceil(q * TRAIN) - 1] for q in SPEC["initialMeansTrainingQuantiles"]],
        "variances": [global_variance] * N,
        "transition": [[SPEC["initialTransitionDiagonal"] if i == j else
                        SPEC["initialTransitionOffDiagonal"] for j in range(N)] for i in range(N)],
        "initial": list(SPEC["initialStateProbabilities"]),
    }
    prior_weight = SPEC["emissionPseudoObservations"]
    for _ in range(SPEC["trainingIterations"]):
        alphas, scales, _ = forward(values, model)
        log_a = [[math.log(x) for x in row] for row in model["transition"]]
        log_b = [[emission(x, model["means"][j], model["variances"][j])
                  for j in range(N)] for x in values]
        betas = [[0.] * N for _ in values]
        for t in range(TRAIN - 2, -1, -1):
            for i in range(N):
                betas[t][i] = logsumexp([log_a[i][j] + log_b[t + 1][j] + betas[t + 1][j]
                                        for j in range(N)]) - scales[t + 1]
        gammas = []
        for t in range(TRAIN):
            raw = [alphas[t][j] + betas[t][j] for j in range(N)]
            z = logsumexp(raw)
            gammas.append([math.exp(x - z) for x in raw])
        counts = [[SPEC["transitionPseudocountDiagonal"] if i == j else
                   SPEC["transitionPseudocountOffDiagonal"] for j in range(N)] for i in range(N)]
        for t in range(TRAIN - 1):
            raw = [[alphas[t][i] + log_a[i][j] + log_b[t + 1][j] + betas[t + 1][j]
                    for j in range(N)] for i in range(N)]
            z = logsumexp([x for row in raw for x in row])
            for i in range(N):
                for j in range(N):
                    counts[i][j] += math.exp(raw[i][j] - z)
        means, variances = [], []
        for j in range(N):
            weight = sum(row[j] for row in gammas)
            mu = sum(gammas[t][j] * values[t] for t in range(TRAIN)) / (weight + prior_weight)
            variance = (sum(gammas[t][j] * (values[t] - mu) ** 2 for t in range(TRAIN))
                        + prior_weight * (global_variance + mu ** 2)) / (weight + prior_weight)
            means.append(mu)
            variances.append(max(VAR_FLOOR, variance))
        model["means"], model["variances"] = means, variances
        model["transition"] = [[x / sum(row) for x in row] for row in counts]
    order = sorted(range(N), key=lambda j: model["means"][j])
    model = {
        "means": [model["means"][j] for j in order],
        "variances": [model["variances"][j] for j in order],
        "transition": [[model["transition"][i][j] for j in order] for i in order],
        "initial": [model["initial"][j] for j in order],
    }
    alphas, _, likelihood = forward(values, model)
    model["trainingLogLikelihood"] = likelihood
    model["filteredTrainingPosterior"] = [math.exp(x) for x in alphas[-1]]
    return model


def filter_step(posterior, value, model):
    predicted = [sum(posterior[i] * model["transition"][i][j] for i in range(N)) for j in range(N)]
    raw = [math.log(predicted[j]) + emission(value, model["means"][j], model["variances"][j])
           for j in range(N)]
    z = logsumexp(raw)
    return [math.exp(x - z) for x in raw]


def expected_log_growth(posterior, model):
    total = 0.
    state = list(posterior)
    for _ in range(SPEC["forecastHorizonDays"]):
        state = [sum(state[i] * model["transition"][i][j] for i in range(N)) for j in range(N)]
        total += sum(state[j] * model["means"][j] for j in range(N))
    return total


def generate(data):
    """Return ETH/USD or None targets aligned to input bars; fills are external."""
    bars = data.get(SPEC["symbol"], [])
    if not isinstance(bars, list):
        raise ValueError("HMM_BARS_MUST_BE_LIST")
    for i, bar in enumerate(bars):
        close, stamp = bar.get("close"), bar.get("openMs")
        if (isinstance(close, bool) or not isinstance(close, (int, float))
                or not math.isfinite(close) or close <= 0
                or isinstance(stamp, bool) or not isinstance(stamp, int)
                or i > 0 and stamp - bars[i - 1]["openMs"] != DAY):
            raise ValueError("HMM_INVALID_OR_NONCONTIGUOUS_BARS")
    if "BTC/USD" in data:
        if len(data["BTC/USD"]) != len(bars) or any(
                a.get("openMs") != b.get("openMs") for a, b in zip(data["BTC/USD"], bars)):
            raise ValueError("HMM_MISALIGNED_SYMBOL_TIMESTAMPS")
    targets = [None] * len(bars)
    if len(bars) <= TRAIN:
        return targets
    returns = [math.log(bars[i]["close"]) - math.log(bars[i - 1]["close"])
               for i in range(1, len(bars))]
    model = fit(returns[:TRAIN])
    posterior = model["filteredTrainingPosterior"]
    fee, slip = SPEC["entryFeeBpsReference"] / 10_000, SPEC["adversePriceBpsReference"] / 10_000
    hurdle = math.log((1 + fee) * (1 + slip) / ((1 - fee) * (1 - slip)))
    held = None
    for i in range(TRAIN, len(bars)):
        if i > TRAIN:
            posterior = filter_step(posterior, returns[i - 1], model)
        growth = expected_log_growth(posterior, model)
        if growth > hurdle:
            held = SPEC["symbol"]
        elif growth <= SPEC["exitLogHurdle"]:
            held = None
        targets[i] = held
    return targets


def self_test():
    checks = []

    def check(name, result):
        if not result:
            raise AssertionError(name)
        checks.append(name)

    fixed = {"means": [-.02, 0., .025], "variances": [.0001] * N,
             "transition": [[.90, .08, .02], [.05, .90, .05], [.02, .08, .90]],
             "initial": [1 / N] * N}
    values = [-.01, .005, .02, .025]
    alphas, _, likelihood = forward(values, fixed)
    joint_by_last = [0.] * N
    for states in itertools.product(range(N), repeat=len(values)):
        probability = fixed["initial"][states[0]]
        for t, value in enumerate(values):
            if t:
                probability *= fixed["transition"][states[t - 1]][states[t]]
            probability *= math.exp(emission(value, fixed["means"][states[t]], fixed["variances"][states[t]]))
        joint_by_last[states[-1]] += probability
    total = sum(joint_by_last)
    check("forward_likelihood_matches_exhaustive_latent_path_sum", abs(math.log(total) - likelihood) < 1e-11)
    check("forward_posterior_matches_exhaustive_latent_path_sum", all(
        abs(math.exp(alphas[-1][j]) - joint_by_last[j] / total) < 1e-11 for j in range(N)))
    sequential = [math.exp(emission(values[0], fixed["means"][j], fixed["variances"][j])) / N for j in range(N)]
    sequential = [x / sum(sequential) for x in sequential]
    for value in values[1:]:
        sequential = filter_step(sequential, value, fixed)
    check("online_filter_matches_batch_forward_filter", all(abs(sequential[j] - math.exp(alphas[-1][j])) < 1e-11 for j in range(N)))
    constant = {**fixed, "means": [.002] * N}
    check("multiday_expectation_matches_constant_mean_identity", abs(expected_log_growth([.2, .3, .5], constant) - .028) < 1e-12)
    signal = filter_step([1 / N] * N, .06, fixed)
    check("positive_observation_updates_toward_positive_emission_state", signal[2] > .999)
    training = [-.025 + .001 * math.sin(i) for i in range(30)] + [
        .001 * math.sin(i) for i in range(30)] + [.03 + .001 * math.sin(i) for i in range(30)]
    fitted = fit(training)
    check("trained_rows_remain_stochastic", all(abs(sum(row) - 1) < 1e-12 and min(row) > 0 for row in fitted["transition"]))
    check("trained_gaussian_variances_are_finite_and_floored", all(math.isfinite(x) and x >= VAR_FLOOR for x in fitted["variances"]))
    check("training_recovers_ordered_positive_and_negative_regimes", fitted["means"][0] < -.01 and fitted["means"][2] > .01)
    check("training_is_deterministic", fit(training) == fitted)
    synthetic_returns = training + [.03] * 45 + [-.03] * 70 + [.03] * 70 + [-.03] * 40
    price = 100.
    bars = [{"openMs": 0, "close": price}]
    for r in synthetic_returns:
        price *= math.exp(r)
        bars.append({"openMs": len(bars) * DAY, "close": price})
    data = {"ETH/USD": bars, "BTC/USD": [dict(b) for b in bars]}
    before = json.dumps(data, sort_keys=True)
    targets = generate(data)
    check("cash_before_training_complete", all(t is None for t in targets[:TRAIN]))
    check("synthetic_positive_state_generates_entry", "ETH/USD" in targets[TRAIN:TRAIN + 45])
    check("synthetic_negative_state_generates_exit", targets[TRAIN + 100] is None)
    for size in (0, 50, 90, 91, 92, 100, 150, 200, len(bars) - 1):
        prefix = {s: b[:size] for s, b in data.items()}
        check(f"target_prefix_invariance_{size}", generate(prefix) == targets[:size])
    check("input_data_unchanged", before == json.dumps(data, sort_keys=True))
    invalid = {"ETH/USD": [{"openMs": 0, "close": float("nan")} ]}
    try:
        generate(invalid)
        rejected = False
    except ValueError:
        rejected = True
    check("nonfinite_observation_rejected", rejected)
    return {"status": "PASS", "checksPassed": len(checks), "checks": checks,
            "historicalPerformanceEvaluated": False, "originalMathematics": False,
            "requested10000SystemsComplete": False}


if __name__ == "__main__":
    import sys
    if sys.argv[1:] != ["--self-test"]:
        raise SystemExit("Usage: python3 hmm.py --self-test")
    print(json.dumps(self_test(), indent=2))
