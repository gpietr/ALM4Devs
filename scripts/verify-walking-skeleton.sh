#!/usr/bin/env bash
# Runs the full BACKLOG.md item 0 checklist end to end against a running
# `docker compose up` stack. Requires: docker, curl, jq, bun (for the host-side DB
# scripts), and a `.env` file (copy .env.example and adjust if needed).
#
# Usage:
#   docker compose up -d --build
#   docker compose --profile migrate run --rm migrate
#   ./scripts/verify-walking-skeleton.sh

set -euo pipefail
cd "$(dirname "$0")/.."

BASE_URL="${BASE_URL:-http://localhost:3000}"
COOKIE_JAR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR"' EXIT

pass() { echo "  OK: $1"; }
fail() { echo "  FAILED: $1" >&2; exit 1; }

echo "== 1. Services reachable =="
curl -sf -o /dev/null "$BASE_URL" || fail "web is not responding at $BASE_URL"
pass "web responds"

echo "== 2. RLS cross-tenant isolation (via bun run db:seed) =="
bun run db:seed || fail "RLS check failed - see output above"
pass "tenant A cannot read tenant B's rows"

echo "== 3 & 4. Sign-up, session cookie, protected tRPC call =="
TENANT_ID="$(bun run scripts/create-tenant.ts "Verification Tenant")"
[ -n "$TENANT_ID" ] || fail "could not create a tenant"
echo "  using tenant $TENANT_ID"

EMAIL="verify-$(date +%s)@example.com"
SIGNUP_RESPONSE="$(curl -sS -c "$COOKIE_JAR" -X POST "$BASE_URL/api/auth/sign-up/email" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"correct horse battery staple\",\"name\":\"Verify Script\",\"tenantId\":\"$TENANT_ID\"}")"
echo "$SIGNUP_RESPONSE" | jq -e '.user.id' >/dev/null || fail "sign-up did not return a user: $SIGNUP_RESPONSE"
pass "signed up ($EMAIL)"

ME_RESPONSE="$(curl -sS -b "$COOKIE_JAR" "$BASE_URL/api/trpc/me")"
echo "$ME_RESPONSE" | jq -e '.result.data.userId' >/dev/null || fail "protected tRPC call failed: $ME_RESPONSE"
pass "protected tRPC call (/api/trpc/me) succeeded with session cookie"

echo "== 5. Audit log immutability (via bun run verify:audit-immutability) =="
bun run verify:audit-immutability || fail "audit log immutability check failed - see output above"
pass "audit_log UPDATE rejected as designed"

echo "== 6. pg-boss round trip + local storage round trip =="
PING_MESSAGE="ping-$(date +%s)"
JOB_RESPONSE="$(curl -sS -X POST "$BASE_URL/api/jobs/ping" \
  -H 'Content-Type: application/json' \
  -d "{\"message\":\"$PING_MESSAGE\"}")"
echo "$JOB_RESPONSE" | jq -e '.jobId' >/dev/null || fail "enqueue failed: $JOB_RESPONSE"
echo "  enqueued job, waiting for worker to process it..."
sleep 3
PROCESSED="$(docker compose exec -T postgres psql -U postgres -d galm -tAc \
  "select count(*) from job_pings where message = '$PING_MESSAGE'")"
[ "$PROCESSED" -ge 1 ] || fail "worker never processed the ping job (job_pings has no matching row)"
pass "pg-boss enqueue (web) -> process (worker) round trip confirmed"

UPLOAD_BODY="hello from the walking skeleton $(date +%s)"
UPLOAD_RESPONSE="$(curl -sS -b "$COOKIE_JAR" -X POST "$BASE_URL/api/storage/upload" \
  --data-raw "$UPLOAD_BODY")"
FILE_URL="$(echo "$UPLOAD_RESPONSE" | jq -r '.url')"
[ -n "$FILE_URL" ] && [ "$FILE_URL" != "null" ] || fail "upload did not return a url: $UPLOAD_RESPONSE"
DOWNLOADED="$(curl -sS "$BASE_URL$FILE_URL")"
[ "$DOWNLOADED" = "$UPLOAD_BODY" ] || fail "downloaded bytes did not match uploaded bytes"
pass "local-filesystem storage round trip confirmed (upload -> signed URL -> read back)"

echo
echo "All BACKLOG.md item 0 checks passed."
