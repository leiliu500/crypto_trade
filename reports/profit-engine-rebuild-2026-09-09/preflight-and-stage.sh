#!/usr/bin/env bash
# Verify and stage the finished artifact; this does not deploy or change .env.
set -euo pipefail
cd /home/ec2-user/crypto_trade
deploy_run_label="${1:-attempt-1}"
[[ "$#" -le 1 ]] || exit 2
[[ "$deploy_run_label" =~ ^[a-zA-Z0-9_-]+$ ]] || exit 2
deploy_run_root="/tmp/crypto-risk-training-deployment-20260909/$deploy_run_label"
deploy_report_root=/home/ec2-user/crypto_trade/reports/profit-engine-rebuild-2026-09-09
deploy_artifact_root=/tmp/distribution-risk-v2-full-20260909/out
deploy_image=sha256:4e5d6e8ecd4e816fdcb550caa11c20ff9172d0aa580ed99deaf4bccf8bca0c1a
test -f "$deploy_artifact_root/full-training.json"
test -f "$deploy_report_root/distribution-training-v2/full-artifact-audit.json"
mkdir -p "$deploy_run_root/captures" "$deploy_run_root/checks-out"
test ! -e "$deploy_run_root/checks-out/import-preflight.json"
test ! -e "$deploy_run_root/checks-out/staging.json"

docker-compose exec -T engine node --input-type=module \
  < "$deploy_report_root/capture-runtime-context.mjs" > "$deploy_run_root/captures/context.json"
deploy_bank_path="$(python3 - "$deploy_run_root/captures/context.json" <<'PY'
import json
from pathlib import PurePosixPath
import sys
value = json.load(open(sys.argv[1]))['stateFile']
if not isinstance(value, str) or str(PurePosixPath(value).parent) != '/app/data':
    raise SystemExit('Captured state must be a direct /app/data file')
print('/archive/' + PurePosixPath(value).name)
PY
)"
curl --fail --silent --show-error http://127.0.0.1:3001/api/dashboard \
  -o "$deploy_run_root/captures/dashboard.json"

docker run --rm --network none --read-only --cpus=1 --memory=2g \
  -v crypto_trade_event_data:/archive:ro \
  -v "$deploy_artifact_root:/imports:ro" \
  -v "$deploy_report_root:/checks:ro" \
  -v "$deploy_run_root/captures:/capture:ro" \
  -v "$deploy_run_root/checks-out:/checks-out" \
  "$deploy_image" node /checks/import-preflight.mjs \
  /imports/full-training.json \
  "$deploy_bank_path" \
  /capture/context.json /capture/dashboard.json /checks-out/import-preflight.json

docker run --rm --network none --read-only --cpus=1 --memory=2g \
  -v crypto_trade_event_data:/app/data \
  -v "$deploy_artifact_root:/imports:ro" \
  -v "$deploy_report_root:/checks:ro" \
  -v "$deploy_run_root/captures:/capture:ro" \
  -v "$deploy_run_root/checks-out:/checks-out" \
  "$deploy_image" node /checks/stage-import.mjs \
  /imports/full-training.json /checks/distribution-training-v2/full-artifact-audit.json \
  /checks-out/import-preflight.json /capture/context.json /checks-out/staging.json
