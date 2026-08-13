#!/usr/bin/env bash
# Configure a dedicated PAODO Docker host with many small automatically allocated networks.
#
# Safe defaults:
#   - preserves every existing daemon.json setting;
#   - validates the candidate before replacing the live file;
#   - keeps a timestamped backup;
#   - restarts Docker only in --apply mode;
#   - proves that a newly allocated network comes from the configured pool.
set -euo pipefail

CONFIG_PATH="${DOCKER_DAEMON_CONFIG:-/etc/docker/daemon.json}"
POOL_BASE="${PAODO_DOCKER_POOL_BASE:-10.240.0.0/16}"
POOL_SIZE="${PAODO_DOCKER_POOL_SIZE:-28}"
MODE="${1:---check}"

usage() {
  printf 'Usage: %s [--check|--apply]\n' "$0"
}

if [[ "$MODE" != "--check" && "$MODE" != "--apply" ]]; then
  usage >&2
  exit 2
fi

for command in jq dockerd docker python3; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'Required command is missing: %s\n' "$command" >&2
    exit 1
  fi
done

if ! [[ "$POOL_SIZE" =~ ^[0-9]+$ ]] || (( POOL_SIZE < 16 || POOL_SIZE > 29 )); then
  printf 'PAODO_DOCKER_POOL_SIZE must be an integer between 16 and 29.\n' >&2
  exit 2
fi

if [[ -f "$CONFIG_PATH" ]]; then
  if ! jq -e 'type == "object"' "$CONFIG_PATH" >/dev/null; then
    printf 'Docker daemon configuration is not a valid JSON object: %s\n' "$CONFIG_PATH" >&2
    exit 1
  fi
elif [[ "$MODE" == "--check" ]]; then
  printf 'Docker address pool is not configured.\n'
  exit 1
fi

if [[ -f "$CONFIG_PATH" ]] && jq -e \
  --arg base "$POOL_BASE" \
  --argjson size "$POOL_SIZE" \
  '."default-address-pools" == [{"base": $base, "size": $size}]' \
  "$CONFIG_PATH" >/dev/null; then
  printf 'Docker address pool is configured: %s split into /%s networks.\n' "$POOL_BASE" "$POOL_SIZE"
  exit 0
fi

if [[ "$MODE" == "--check" ]]; then
  printf 'Docker address pool differs from the PAODO profile (%s split into /%s networks).\n' \
    "$POOL_BASE" "$POOL_SIZE"
  exit 1
fi

if (( EUID != 0 )); then
  printf '%s must run as root in --apply mode.\n' "$0" >&2
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
  printf 'systemctl is required to restart Docker.\n' >&2
  exit 1
fi

config_dir="$(dirname "$CONFIG_PATH")"
mkdir -p "$config_dir"
candidate="$(mktemp "${CONFIG_PATH}.paodo-candidate.XXXXXX")"
probe="paodo_ipam_probe_$$"
probe_created=0

cleanup() {
  if (( probe_created == 1 )); then
    docker network rm "$probe" >/dev/null 2>&1 || true
  fi
  rm -f "$candidate"
}
trap cleanup EXIT

if [[ -f "$CONFIG_PATH" ]]; then
  jq \
    --arg base "$POOL_BASE" \
    --argjson size "$POOL_SIZE" \
    '. + {"default-address-pools": [{"base": $base, "size": $size}]}' \
    "$CONFIG_PATH" >"$candidate"
else
  jq -n \
    --arg base "$POOL_BASE" \
    --argjson size "$POOL_SIZE" \
    '{"default-address-pools": [{"base": $base, "size": $size}]}' >"$candidate"
fi

dockerd --validate --config-file "$candidate" >/dev/null

backup=""
if [[ -f "$CONFIG_PATH" ]]; then
  backup="${CONFIG_PATH}.paodo-backup-$(date -u +%Y%m%dT%H%M%SZ)"
  cp -p "$CONFIG_PATH" "$backup"
fi
chmod 0644 "$candidate"
mv "$candidate" "$CONFIG_PATH"

if ! systemctl restart docker; then
  printf 'Docker failed to restart; restoring its previous configuration.\n' >&2
  if [[ -n "$backup" ]]; then
    cp -p "$backup" "$CONFIG_PATH"
  else
    rm -f "$CONFIG_PATH"
  fi
  systemctl restart docker || true
  exit 1
fi

ready=0
for _attempt in $(seq 1 30); do
  if docker info >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if (( ready == 0 )); then
  printf 'Docker did not become ready within 30 seconds. The validated configuration remains at %s.\n' \
    "$CONFIG_PATH" >&2
  exit 1
fi

docker network create --driver bridge --label com.paodo.probe=ipam "$probe" >/dev/null
probe_created=1
probe_subnet="$(docker network inspect "$probe" --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}')"
python3 - "$POOL_BASE" "$POOL_SIZE" "$probe_subnet" <<'PY'
import ipaddress
import sys

pool = ipaddress.ip_network(sys.argv[1], strict=True)
size = int(sys.argv[2])
allocated = ipaddress.ip_network(sys.argv[3], strict=True)
if allocated.prefixlen != size or not allocated.subnet_of(pool):
    raise SystemExit(
        f"Docker allocated {allocated}, expected a /{size} network inside {pool}."
    )
PY

docker network rm "$probe" >/dev/null
probe_created=0
printf 'Docker address pool applied and verified: %s allocated from %s as /%s.\n' \
  "$probe_subnet" "$POOL_BASE" "$POOL_SIZE"
if [[ -n "$backup" ]]; then
  printf 'Previous Docker configuration preserved at %s.\n' "$backup"
fi
