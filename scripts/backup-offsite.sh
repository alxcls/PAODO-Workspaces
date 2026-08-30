#!/usr/bin/env bash
# Nightly offsite backup for one box. Builds a full set with the app's own backup:all, then hands it
# to restic, which ships only the changed chunks to S3 and prunes old snapshots. The app's
# set-building code is untouched; restic owns dedup, retention and integrity.
#
# On a box (default overlay), from the repo dir:
#   scripts/backup-offsite.sh
# Locally against `npm run dev`, point it at the dev overlay:
#   COMPOSE_FILES='-f docker-compose.yml -f docker-compose.dev.yml' scripts/backup-offsite.sh
#
# Reads S3_* and paths from the sibling .env. Run once with --init to create the repo, then without
# args each night (see doc/backup-restic.md). Retention: keep the last 7 daily snapshots plus 4 weekly.
set -euo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
ENV_FILE="${ENV_FILE:-$REPO_DIR/.env}"
PASSWORD_FILE="${RESTIC_PASSWORD_FILE:-$REPO_DIR/restic-password}"
COMPOSE_FILES="${COMPOSE_FILES:--f docker-compose.yml -f docker-compose.workspace-api.yml}"
APP_SERVICE="${APP_SERVICE:-app}"
CONTAINER_STAGING="${CONTAINER_STAGING:-/tmp/backup-offsite}"
HOST_STAGING="${HOST_STAGING:-/var/lib/paodo/backup-staging}"
KEEP_DAILY="${KEEP_DAILY:-7}"
KEEP_WEEKLY="${KEEP_WEEKLY:-4}"

log() { printf '[offsite %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() { printf '[offsite] ERROR: %s\n' "$*" >&2; exit 1; }

command -v restic >/dev/null || fail "restic is not installed (see doc/backup-restic.md)."
[ -f "$ENV_FILE" ] || fail "no .env at $ENV_FILE"
[ -f "$PASSWORD_FILE" ] || fail "no restic password file at $PASSWORD_FILE"

getval() { local v; v=$(grep -m1 "^$1=" "$ENV_FILE" | cut -d= -f2-); v=${v%\"}; v=${v#\"}; v=${v%\'}; v=${v#\'}; printf '%s' "$v"; }

S3_ENDPOINT="$(getval S3_ENDPOINT)"
S3_BUCKET="$(getval S3_BUCKET)"
export AWS_ACCESS_KEY_ID; AWS_ACCESS_KEY_ID="$(getval S3_ACCESS_KEY_ID)"
export AWS_SECRET_ACCESS_KEY; AWS_SECRET_ACCESS_KEY="$(getval S3_SECRET_ACCESS_KEY)"
[ -n "$S3_BUCKET" ] || fail "S3_BUCKET is empty in $ENV_FILE"
[ -n "$AWS_ACCESS_KEY_ID" ] && [ -n "$AWS_SECRET_ACCESS_KEY" ] || fail "S3 keys are empty in $ENV_FILE"

host="${S3_ENDPOINT#https://}"; host="${host#http://}"
export RESTIC_REPOSITORY="s3:${host}/${S3_BUCKET}"
export RESTIC_PASSWORD_FILE="$PASSWORD_FILE"

if [ "${1:-}" = "--init" ]; then
  log "initialising restic repo $RESTIC_REPOSITORY"
  restic init
  exit 0
fi

restic snapshots >/dev/null 2>&1 || fail "restic repo $RESTIC_REPOSITORY is unreachable or not initialised — run once with --init (see doc/backup-restic.md)."

cd "$REPO_DIR"
cleanup() {
  docker compose $COMPOSE_FILES exec -T "$APP_SERVICE" rm -rf "$CONTAINER_STAGING" >/dev/null 2>&1 || true
  rm -rf "$HOST_STAGING" 2>/dev/null || true
}
trap cleanup EXIT

log "building set inside the $APP_SERVICE container…"
docker compose $COMPOSE_FILES exec -T "$APP_SERVICE" sh -lc "rm -rf '$CONTAINER_STAGING' && npm run backup:all -- '$CONTAINER_STAGING'"

log "copying set out to the host…"
rm -rf "$HOST_STAGING"; mkdir -p "$HOST_STAGING"
cid="$(docker compose $COMPOSE_FILES ps -q "$APP_SERVICE")"
[ -n "$cid" ] || fail "could not resolve the $APP_SERVICE container id"
docker cp "$cid:$CONTAINER_STAGING/." "$HOST_STAGING/"

log "restic backup → $RESTIC_REPOSITORY"
restic backup "$HOST_STAGING" --tag paodo-set --host "$(hostname)"

log "pruning: keep-daily=$KEEP_DAILY keep-weekly=$KEEP_WEEKLY"
restic forget --tag paodo-set --keep-daily "$KEEP_DAILY" --keep-weekly "$KEEP_WEEKLY" --prune

log "integrity check (structure)…"
restic check

log "done."
