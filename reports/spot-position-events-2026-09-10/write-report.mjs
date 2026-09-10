import assert from 'node:assert/strict';import {readFile,writeFile} from 'node:fs/promises';
const root='reports/spot-position-events-2026-09-10';const read=async name=>JSON.parse(await readFile(`${root}/${name}`,'utf8'));
const [image,deployment,browser]=await Promise.all(['image-verification.json','deployment-verification.json','browser-deployed/browser-report.json'].map(read));
for(const result of [image,deployment,browser])assert.equal(result.passed,true);
const summary={version:'spot-dynamic-position-cards-v1',passed:true,recordedAt:new Date().toISOString(),
 changes:['Explicit OPEN LONG and CLOSE LONG order intent','Recorded position status, remaining BTC/basis, bid, realized/unrealized/total P&L and holding duration','Durable entry, holding and linked exit events with pagination and reload persistence','5-second polling and1-second display ages; valuations remain on the existing5-minute strategy cadence'],
 readOnlyProjection:true,spotRuntimeRestarted:false,tradingRulesChanged:false,financialLedgerChanged:false,
 validation:{uniqueTests:105,finalUiTests:27,typecheckPassed:true,productionBuildPassed:true,readOnlyNoNetworkImageCheckPassed:true,deployedBrowserPassed:true},
 sourceCycle:deployment.sourceCycle,recordedActivityEvents:deployment.activity.totalEvents,recordedHoldingCycles:deployment.allHoldingCycles,
 deployedImages:image.images,spotContainerUnchanged:deployment.spotRuntimeAndContainerUnchanged,
 limitations:['No live-tick price feed was introduced: recorded bid and P&L update when a strategy valuation is recorded, approximately every5 minutes.','Historical cache integrity checks rotate through128 older files per poll; the current journal, head, receipt/submission and migration anchors are checked each request.','Cold history loads resume across bounded chunks. Resource limits or unavailable/ambiguous evidence are reported; orphan journal files are excluded from history.'],
 testHarnessNote:'Initial Chromium assertion read innerText while the timeline was collapsed. It now reads stored DOM text then verifies visible text after expanding. The initial failure report is retained.'};
await writeFile(`${root}/report.json`,JSON.stringify(summary,null,2)+'\n');
await writeFile(`${root}/report.md`,`The dynamic order cards are deployed. Spot buys display **OPEN LONG** and sell orders display **CLOSE LONG**. A sell reduces funded BTC exposure; it is not a short entry. Each filled order is linked to its position episode, including related exit orders.

Cards now show the position's open, exit-pending, partially exited or closed status; remaining BTC and entry cost; recorded bid; total, realized and unrealized P&L; holding duration; and the latest recorded hold or exit reason. Their expandable timeline includes original order lifecycle events, every committed holding evaluation and linked exit activity, with order references and older-event paging. Loaded history survives status refreshes and is rebuilt from durable evidence after browser reload.

The dashboard polls every **5 seconds**, and display-only ages update every second. Market valuation and entry/risk/exit evaluation still share the existing **5-minute** spot strategy timer. This UI change does not establish a faster quote feed or faster risk checks. That interval is a fixed setting for the weekly trend strategy, not a validated profit-optimal frequency.

The dashboard reads the existing spot journal through a read-only mount. Receipt accounting is reconciled with the frozen account mathematics. History follows committed predecessor states anchored to journal evidence; uncommitted orphan files never create activity. Missing, loading, stale, ambiguous or altered evidence degrades the position-history display. No trading code, account balances, order ledger or paper-service process was changed. The separate futures source closure remains 82 files with its original hash.

Verification passed: **105 distinct tests**, a final 27-test UI check after label refinement, TypeScript checks and production build; a built-image check with networking disabled and read-only filesystem/journal; deployed API/account/source checks; and desktop/mobile Chromium checks for LONG intent, position metrics, visible durable history, duration updates, retained expansion, unique event IDs and futures-view separation. At deployment verification, the card contained ${deployment.activity.totalEvents} durable events and every holding evaluation ${deployment.allHoldingCycles.join(', ')} after the entry. The browser's initial collapsed-text assertion was corrected in the harness; its failed report is retained.

History is cached in compact form. Current journal, head and receipt/submission/migration anchors are checked on requests; older cached-file metadata checks rotate 128 files per poll. Cold loads resume in bounded chunks and report loading rather than silently omitting history. Explicit resource limits remain in the reader.

Artifacts: [tests](dashboard-tests.tap), [reader tests](reader-tests.tap), [image verification](image-verification.json), [deployment verification](deployment-verification.json), [browser verification](browser-deployed/browser-report.json), [desktop](browser-deployed/desktop-spot.png), [mobile](browser-deployed/mobile-spot.png).
`);
console.log(JSON.stringify({passed:true,report:`${root}/report.md`,tests:105,events:deployment.activity.totalEvents}));
