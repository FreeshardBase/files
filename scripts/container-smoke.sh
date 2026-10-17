#!/usr/bin/env bash
# Container smoke test (#300): builds the image with podman, checks that it refuses to start without its secrets, starts
# it on a temporary volume, answers /healthz, runs the server as uid 1000, takes one file up and down again through the
# API with a session from the fake IdP, and stops cleanly. `pnpm smoke:container` runs it; without podman it is skipped
# (exit 0) with a message saying so. Needs node and curl on the host; the image build needs network access.
set -euo pipefail

if ! command -v podman >/dev/null 2>&1; then
  echo "container smoke SKIPPED: podman is not installed, so the image was neither built nor started"
  exit 0
fi

cd "$(dirname "$0")/.."
IMAGE=localhost/freeshard-files:smoke
NAME="files-smoke-$$"
VOLUME="files-smoke-$$"
WORK="$(mktemp -d)"
IDP_PID=""

cleanup() {
  podman rm -f "$NAME" >/dev/null 2>&1 || true # handled: the container may never have started
  podman volume rm -f "$VOLUME" >/dev/null 2>&1 || true # handled: the volume may never have been created
  if [ -n "$IDP_PID" ]; then kill "$IDP_PID" 2>/dev/null || true; fi # handled: the IdP may already have exited
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() { echo "container smoke FAILED: $*" >&2; exit 1; }
free_port() { node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }

echo "== build"
# --format docker keeps the HEALTHCHECK, which the OCI format drops.
podman build --format docker -t "$IMAGE" . >"$WORK/build.log" 2>&1 || { tail -40 "$WORK/build.log"; fail "image build"; }

echo "== refuses to start without secrets"
if podman run --rm --network none "$IMAGE" >"$WORK/nosecrets.log" 2>&1; then fail "started without any configuration"; fi
grep -q "FILES_SESSION_SECRET" "$WORK/nosecrets.log" || { cat "$WORK/nosecrets.log"; fail "no message naming the missing secret"; }

echo "== fake IdP"
server/node_modules/.bin/tsx scripts/smoke/fake-idp.ts >"$WORK/idp.out" 2>"$WORK/idp.err" &
IDP_PID=$!
for _ in $(seq 1 100); do [ -s "$WORK/idp.out" ] && break; sleep 0.1; done
ISSUER="$(head -1 "$WORK/idp.out")"
[ -n "$ISSUER" ] || { cat "$WORK/idp.err"; fail "fake IdP did not start"; }

echo "== start"
PORT="$(free_port)"
BASE="http://127.0.0.1:$PORT"
podman volume create "$VOLUME" >/dev/null
# Host network: the server reaches the IdP on the host's loopback, and http is accepted only for loopback URLs.
podman run -d --name "$NAME" --network host -v "$VOLUME:/data" \
  -e FILES_PORT="$PORT" -e FILES_PUBLIC_URL="$BASE" \
  -e FILES_SESSION_SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" \
  -e FILES_ENCRYPTION_KEY="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" \
  -e FILES_OIDC_ISSUER="$ISSUER" -e FILES_OIDC_CLIENT_ID=files -e FILES_OIDC_CLIENT_SECRET=files-secret \
  "$IMAGE" >/dev/null

echo "== /healthz"
healthy=""
for _ in $(seq 1 100); do
  if curl -fsS "$BASE/healthz" >"$WORK/health.json" 2>/dev/null; then healthy=1; break; fi # handled: retried until the server listens
  sleep 0.2
done
[ -n "$healthy" ] || { podman logs "$NAME"; fail "/healthz never answered"; }
grep -q '"status":"ok"' "$WORK/health.json" || fail "/healthz answered $(cat "$WORK/health.json")"
podman healthcheck run "$NAME" >/dev/null || fail "the image's HEALTHCHECK failed"

echo "== runs as uid 1000"
podman exec "$NAME" cat /proc/1/status | grep -Eq '^Uid:\s+1000\s+1000' || fail "the server does not run as uid 1000"

echo "== login through the fake IdP"
JAR="$WORK/cookies"
IDP_URL="$(curl -fsS -o /dev/null -c "$JAR" -w '%{redirect_url}' "$BASE/auth/login?login_hint=testuser")"
CALLBACK="$(curl -fsS -o /dev/null -w '%{redirect_url}' "$IDP_URL")"
curl -fsS -o /dev/null -b "$JAR" -c "$JAR" "$CALLBACK"
CSRF="$(curl -fsS -b "$JAR" "$BASE/api/v1/me" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).csrfToken))")"
[ -n "$CSRF" ] || fail "no session after login"

echo "== upload and download one file"
head -c 1048576 /dev/urandom >"$WORK/up.bin"
curl -fsS -o /dev/null -b "$JAR" -X PUT -H 'content-type: application/octet-stream' -H "origin: $BASE" -H "x-csrf-token: $CSRF" \
  --data-binary @"$WORK/up.bin" "$BASE/api/v1/sources/home/content?path=/smoke.bin&onCollision=fail" || fail "upload"
curl -fsS -b "$JAR" -o "$WORK/down.bin" "$BASE/api/v1/sources/home/content?path=/smoke.bin&download=1" || fail "download"
cmp -s "$WORK/up.bin" "$WORK/down.bin" || fail "the downloaded file differs from the uploaded one"

echo "== stop"
podman stop -t 15 "$NAME" >/dev/null
[ "$(podman inspect -f '{{.State.ExitCode}}' "$NAME")" = "0" ] || { podman logs "$NAME"; fail "the server did not shut down cleanly"; }

echo "container smoke PASSED"
