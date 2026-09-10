This verifier checks deployment continuity and active training evidence. It does not deploy, construct a broker, start an engine, submit an order or establish strategy profit.

Run from `/app` in the reviewed final image. Mount the account volume and captured inputs read-only. Mount a separate writable report directory at `/checks-out`; the output's canonical parent must be exactly `/checks-out`, and the output must not already exist.

```sh
node /checks/post-deployment-verify.mjs \
  /checks/before-paper.json /checks/after-paper.json \
  /checks/after-bank.json /checks/import-preflight.json \
  /checks/startup.jsonl /checks/dashboard.json /checks/health.json \
  /checks/runtime-context.json /checks-out/post-deployment.json
```

Capture the existing schema4 paper state before deployment. After deployment, capture the paper state and active model bank, then obtain a fresh dashboard (`/api/dashboard`), health body (`/healthz`) and allowlisted runtime context using `capture-runtime-context.mjs`. The dashboard must be captured after the model bank so its active model counts and training completion times can be compared. Context, dashboard and health timestamps must be at most 60 seconds old when verification begins. Supply logs from this deployment's startup, including the JSON `distributional-training-ready` record; Docker timestamp prefixes are accepted. The runtime context's configured training path must match the startup import path, whose content hash must match the reviewed preflight artifact.

The account checks require the existing funding epoch, product mapping, initial inventory and funding-history prefix to remain intact. New fill activities are reconciled in commit order against funding fill events, recorded execution fees, order quantities and average prices. New funding postings explain cash adjustments. Entries do not debit perpetual trade notional. Missing old activity history without a common anchor fails reconciliation. Cash residual tolerance is one millionth of a dollar; when no cash event exists, cash must match exactly. With no fills, positions must match exactly. All earlier orders and immutable plans must remain, terminal order history cannot change, and permitted nonfill cancellation transitions are reported separately.

A funding-only posting can change cash without a fill. A restart can cancel a prior nonterminal order without changing cash. UTC session rollover and market-price changes can change dashboard/session values without resetting the account. These cases are handled separately; dashboard marked equity is never substituted for durable cash continuity.

The model checks require a successful startup import of the reviewed artifact, the active risk-sizing and efficient-training policy, at least three retained UTC training dates, and running model statistics consistent with the captured bank. Each action's raw retained dates and the latest compatible decision/rejection reasons are reported. Raw dates do not establish conditional support, current entry eligibility or profitability. The existing paper-trial profile remains an unvalidated experiment.

The verifier writes an aggregate report and exits zero only when continuity, model and healthy-runtime checks pass. It exits two for failed checks and writes the available failure evidence. Raw input records, environment variables and credentials are not printed. Funding availability is reported separately from account continuity; preserved unknown funding remains unknown. No historical strategy study is rerun.
