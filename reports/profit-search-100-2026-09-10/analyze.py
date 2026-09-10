"""Additional diagnostics for the already-selected candidate; never reselects."""
import importlib.util
import json
from pathlib import Path
import random

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[1]
spec = importlib.util.spec_from_file_location('profit_search', REPO/'tools/profit-search.py')
search = importlib.util.module_from_spec(spec)
spec.loader.exec_module(search)


def bootstrap(candidate, baseline, block=14, count=20000):
    assert [r['date'] for r in candidate['daily']] == [r['date'] for r in baseline['daily']]
    values = [a['pnlUsd']-b['pnlUsd'] for a,b in zip(candidate['daily'], baseline['daily'])]
    n = len(values)
    full, remainder = divmod(n, block)
    blocks = [sum(values[(i+k)%n] for k in range(block)) for i in range(n)]
    rng, samples = random.Random(20260910100), []
    for _ in range(count):
        total = sum(blocks[rng.randrange(n)] for _ in range(full))
        start = rng.randrange(n)
        samples.append(total + sum(values[(start+k)%n] for k in range(remainder)))
    samples.sort()
    return dict(observedExcessNetUsd=sum(values), nominalOneSided95LowerNetUsd=samples[int(.05*count)],
                hundredTrialAdjustedLowerNetUsd=samples[int(.05/100*count)],
                blockDays=block, repetitions=count,
                limitations='Descriptive circular moving block bootstrap. Sparse episodes, nonstationarity and prior unknown searches invalidate a global confidence guarantee. The 100-trial tail has only about ten replicates below it.')


def main():
    screen = ROOT/'screen'
    if (ROOT/'selected-diagnostics.json').exists():
        raise FileExistsError('Diagnostic artifact already exists; preserve completed study')
    summary = json.loads((screen/'summary.json').read_text())
    chosen = summary['selected']['candidate']
    ledgers = json.loads((screen/'ledgers'/(chosen['id']+'.json')).read_text())
    common, data = search.read_common(), search.read_common().load_data(False)
    confidence, concentration = {}, {}
    for period in ('later_2025', 'recent_2026'):
        start, end = search.PERIODS[period]
        confidence[period], concentration[period] = {}, {}
        for scenario in ('base', 'combined'):
            run = ledgers[period][scenario]
            confidence[period][scenario] = {
                label: bootstrap(run, common.evaluate([target]*len(data['BTC/USD']), data, start, end,
                                                      search.SCENARIOS[scenario], details=True))
                for label, target in [('cash', None), ('buy_hold_btc', 'BTC/USD'), ('buy_hold_eth', 'ETH/USD')]}
            largest = max(t['netPnlUsd'] for t in run['trades'])
            concentration[period][scenario] = dict(
                totalNetUsd=run['netPnlUsd'], largestWinningEpisodeUsd=largest,
                arithmeticNetExcludingLargestWinnerUsd=run['netPnlUsd']-largest,
                terminalEpisodes=sum(t['exitReason']=='terminal' for t in run['trades']),
                caveat='Arithmetic fragility diagnostic, not a counterfactual replay or adjusted expectancy.')
    signal = search.targets(chosen, data)
    continuous = {s:common.evaluate(signal, data, '2025-01-01', '2026-09-10', settings, details=True)
                  for s,settings in search.SCENARIOS.items()}
    baselines = {label: {s:common.evaluate([target]*len(signal), data, '2025-01-01', '2026-09-10', settings)
                          for s,settings in search.SCENARIOS.items()}
                 for label,target in [('cash',None),('buy_hold_btc','BTC/USD'),('buy_hold_eth','ETH/USD')]}
    all_results = json.loads((screen/'all-results.json').read_text())
    neighbors = {r['candidate']['id']:r['summary'] for r in all_results
                 if r['candidate']['family']=='sma_eth' and r['candidate']['lookbackDays'] in (20,30,40,50,60)}
    result = dict(selectedId=chosen['id'], confidence=confidence, concentration=concentration,
                  continuousSameAccount=continuous, continuousBaselines=baselines,
                  neighborStability=neighbors,
                  zeroActivityAllRunsIds=[r['candidate']['id'] for r in all_results
                    if all(x['closedTrades']==0 for p in r['runs'].values() for x in p.values())],
                  structurallyInactiveIds=['pullback_btc-090','pullback_eth-090'],
                  structuralReason='At lookback90 the pullback average and required uptrend average coincide; close>trend contradicts z<-1. Retained as failed configurations, never substituted.',
                  validatedProfitable=False, sourceHashes={str(p.relative_to(REPO)):search.sha(p) for p in
                      [Path(__file__),screen/'summary.json',screen/'all-results.json',screen/'development-lock.json']})
    search.save(ROOT/'selected-diagnostics.json', result)
    print(json.dumps(dict(selectedId=chosen['id'], continuousNetUsd={s:r['netPnlUsd'] for s,r in continuous.items()},
                          zeroActivityConfigurations=len(result['zeroActivityAllRunsIds']), confidence=confidence['recent_2026']['base']),indent=2))


if __name__=='__main__':
    main()
