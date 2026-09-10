"""Post-result diagnostics; never changes the registered selection."""
import csv
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parent
summary=json.loads((ROOT/'results-v1/summary.json').read_text())
lock=json.loads((ROOT/'results-v1/selection-lock.json').read_text())
reg=json.loads((ROOT/'results-v1/registration.json').read_text())
rows=[]
diagnostics={}
for asset, choices in reg['combinations'].items():
    winner=lock['selectedCombination'][asset]
    value=lock['worstScenarioDevelopmentUtility'][winner]
    tied=[c['id'] for c in choices if lock['worstScenarioDevelopmentUtility'][c['id']]==value]
    varying={part:sorted({c[part] if part=='entry' else c[part]['id'] for c in choices if c['id'] in tied})
             for part in ('entry','holding','exit')}
    diagnostics[asset]=dict(developmentWinner=winner,exactUtilityTies=tied,
      stageValuesWithinDevelopmentTies=varying,
      interpretation='Lexical tie-breaking is deterministic; it does not establish superiority of tied component values.')
    for c in choices:
        key=c['id']
        perf=summary['performance'][key]
        row=dict(asset=asset,combination=key,entry=c['entry'],holding=c['holding']['id'],exit=c['exit']['id'],
                 selectedInDevelopment=key==winner,baseline=key==summary['baseline'][asset],
                 worstDevelopmentUtility=lock['worstScenarioDevelopmentUtility'][key])
        for period in ('development','later_2025','recent_2026','continuous'):
            for case in ('base','combined'):
                run=perf[period][case]
                for field in ('netPnlUsd','feesUsd','grossReferenceEdgeUsd','adversePriceCostUsd',
                              'naturalCompletedEpisodes','terminalSales','priorClosePeakToDailyLowDrawdownUsd'):
                    row[period+'_'+case+'_'+field]=run[field]
        rows.append(row)
with (ROOT/'comparison.csv').open('w') as f:
    writer=csv.DictWriter(f,fieldnames=list(rows[0]))
    writer.writeheader(); writer.writerows(rows)
(ROOT/'diagnostics.json').write_text(json.dumps(diagnostics,indent=2)+'\n')
print(json.dumps(diagnostics,indent=2))
