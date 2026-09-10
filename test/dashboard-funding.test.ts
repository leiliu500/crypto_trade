import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

async function sources() {
  const app = await readFile("src/dashboard/public/app.js", "utf8");
  return { app, utility: app.slice(0, app.indexOf("function setConnection")),
    funding: app.slice(app.indexOf("function rollingPnlDetailHtml"), app.indexOf("function filtered")),
    session: app.slice(app.indexOf("function sessionPnlBreakdownHtml"), app.indexOf("function renderLiveness")) };
}

test("dashboard distinguishes posted model funding cash from unsettled accrual and preserves unknown amounts", async () => {
  const { utility, funding } = await sources();
  const html = runInNewContext(`${utility}\n${funding}\nrollingPnlDetailHtml({fundingIncluded:true,
    fundingCash24hUsd:-1.23456,fundingCashUtcSessionUsd:-.23456,fundingUnsettledAccrualUsd:.05},true)`) as string;
  assert.match(html, /After fill fees and posted paper funding/);
  assert.match(html, /Paper funding cash · 24h -\$1\.23456 · UTC day -\$0\.23456/);
  assert.match(html, /Unsettled funding accrual \+\$0\.05000 · excluded from cash P&amp;L/);
  const unknown = runInNewContext(`${utility}\n${funding}\nrollingPnlDetailHtml({fundingIncluded:true,
    fundingCash24hUsd:null,fundingCashUtcSessionUsd:null,fundingUnsettledAccrualUsd:null,
    reason:'<missing funding>'},false)`) as string;
  assert.match(unknown, /&lt;missing funding&gt;/);
  assert.match(unknown, /24h Unknown · UTC day Unknown/);
  assert.match(unknown, /Unsettled funding accrual Unknown/);
  assert.doesNotMatch(unknown, /\$0\.00000/);
});

test("account breakdown shows its funding cash separately and never adds open accrual to realized profit", async () => {
  const { utility, session } = await sources();
  const html = runInNewContext(`${utility}\n${session}\nsessionPnlBreakdownHtml({
    grossPricePnl:1,entryFee:.1,exitFee:.1,realizedPnl:-.2,unrealizedPnl:.5,totalPnl:.3},
    {fundingIncluded:true,utcSessionNetPnlUsd:-.2,fundingCashUtcSessionUsd:-1,fundingUnsettledAccrualUsd:99})`) as string;
  assert.match(html, /Posted paper funding cash · UTC day/); assert.match(html, /-\$1\.00000/);
  assert.match(html, /Realized account P&amp;L after fill fees and posted funding/); assert.match(html, /-\$0\.20000/);
  assert.match(html, /Total UTC-day P&amp;L · unsettled funding excluded/); assert.match(html, /\+\$0\.30000/);
  assert.doesNotMatch(html, /99\.00000/);
});

test("missing funding hides stale account session totals while retaining the known execution breakdown", async () => {
  const { utility, session } = await sources();
  const html = runInNewContext(`${utility}\n${session}\nsessionPnlBreakdownHtml({
    grossPricePnl:1,entryFee:.1,exitFee:.1,realizedPnl:123,unrealizedPnl:.5,totalPnl:123.5},
    {fundingIncluded:true,utcSessionNetPnlUsd:null,fundingCashUtcSessionUsd:null})`) as string;
  assert.match(html, /Gross price gain/); assert.match(html, /\+\$1\.00000/);
  assert.match(html, /Open mark P&amp;L/); assert.match(html, /\+\$0\.50000/);
  assert.equal((html.match(/Unknown/g) ?? []).length, 3);
  assert.doesNotMatch(html, /123\.00000|123\.50000/);
});

test("trade-level fee accounting is labeled price-only even when the account includes funding", async () => {
  const { app, utility } = await sources();
  const trade = app.slice(app.indexOf("function renderRealizedPnlBreakdown"), app.indexOf("function groupOrderCards"));
  const html = runInNewContext(`${utility}\n${trade}\nrenderRealizedPnlBreakdown({active:false,
    realizedBreakdown:{grossPricePnl:1,entryFee:.1,exitFee:.1,realizedPnl:.8}})`) as string;
  assert.match(html, /Price P&amp;L after fill fees/); assert.match(html, /\+\$0\.80000/);
  assert.doesNotMatch(html, /Actual realized P&amp;L|posted funding/);
  assert.match(app, /Realized trade P&amp;L · funding excluded/);
});
