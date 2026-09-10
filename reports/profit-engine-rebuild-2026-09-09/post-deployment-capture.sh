#!/usr/bin/env bash
# Capture and verify one deployed paper engine; no account mutation or orders.
set -euo pipefail
cd /home/ec2-user/crypto_trade
deploy_stage_label="${1:-attempt-1}"
deploy_verify_label="${2:-verify-1}"
[[ "$#" -le 2 ]] || exit 2
[[ "$deploy_stage_label" =~ ^[a-zA-Z0-9_-]+$ && "$deploy_verify_label" =~ ^[a-zA-Z0-9_-]+$ ]] || exit 2
deploy_stage_root="/tmp/crypto-risk-training-deployment-20260909/$deploy_stage_label"
deploy_verify_root="$deploy_stage_root/$deploy_verify_label"
deploy_report_root=/home/ec2-user/crypto_trade/reports/profit-engine-rebuild-2026-09-09
deploy_image=sha256:4e5d6e8ecd4e816fdcb550caa11c20ff9172d0aa580ed99deaf4bccf8bca0c1a
test -f "$deploy_stage_root/checks-out/staging.json"
test -f "$deploy_stage_root/checks-out/import-preflight.json"
mkdir -p "$deploy_verify_root/captures" "$deploy_verify_root/checks-out"
test ! -e "$deploy_verify_root/captures/before-paper.json"
test ! -e "$deploy_verify_root/checks-out/post-deployment.json"

docker-compose logs --no-color --timestamps engine > "$deploy_verify_root/captures/startup.jsonl"
docker-compose exec -T engine node --input-type=module \
  < "$deploy_report_root/capture-runtime-context.mjs" > "$deploy_verify_root/captures/context.json"

docker run --rm --network none --read-only --cpus=1 --memory=2g \
  -v crypto_trade_event_data:/archive:ro \
  -v "$deploy_report_root:/checks:ro" \
  -v "$deploy_stage_root/checks-out:/prep:ro" \
  -v "$deploy_verify_root/captures:/capture" \
  "$deploy_image" node /checks/capture-verification-state.mjs /prep/staging.json /capture/context.json

curl --fail --silent --show-error http://127.0.0.1:3001/api/dashboard \
  -o "$deploy_verify_root/captures/dashboard.json"
# A critical runtime returns HTTP503 with useful health evidence. Preserve its
# JSON so the verifier can report continuity and the failed health check.
curl --silent --show-error http://127.0.0.1:3001/healthz \
  -o "$deploy_verify_root/captures/health.json"

docker run --rm --network none --read-only --cpus=1 --memory=2g \
  -v "$deploy_report_root:/checks:ro" \
  -v "$deploy_stage_root/checks-out:/prep:ro" \
  -v "$deploy_verify_root/captures:/capture:ro" \
  -v "$deploy_verify_root/checks-out:/checks-out" \
  "$deploy_image" node /checks/post-deployment-verify.mjs \
  /capture/before-paper.json /capture/after-paper.json /capture/after-bank.json \
  /prep/import-preflight.json /capture/startup.jsonl /capture/dashboard.json /capture/health.json \
  /capture/context.json /checks-out/post-deployment.json
