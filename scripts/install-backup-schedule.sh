#!/usr/bin/env bash
# Installs a nightly systemd timer that runs backup-offsite.sh. Opt-in: run this once when you
# commission a box (nothing schedules on its own). Idempotent — re-run to update time or user.
#
#   bash scripts/install-backup-schedule.sh          # 03:<stable-per-host-minute> nightly
#   BACKUP_HOUR=4 BACKUP_MINUTE=30 bash scripts/install-backup-schedule.sh
#   bash scripts/install-backup-schedule.sh --uninstall
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE=/etc/systemd/system/paodo-backup.service
TIMER=/etc/systemd/system/paodo-backup.timer

[ "$(id -u)" = 0 ] || exec sudo -E bash "$0" "$@"

if [ "${1:-}" = "--uninstall" ]; then
  systemctl disable --now paodo-backup.timer 2>/dev/null || true
  rm -f "$SERVICE" "$TIMER"
  systemctl daemon-reload
  echo "removed paodo-backup timer and service"
  exit 0
fi

command -v restic >/dev/null || { echo "restic is not installed — see doc/backup-restic.md" >&2; exit 1; }
[ -f "$REPO_DIR/scripts/backup-offsite.sh" ] || { echo "backup-offsite.sh not found under $REPO_DIR" >&2; exit 1; }

RUN_USER="${BACKUP_USER:-$(stat -c %U "$REPO_DIR")}"
HOUR="${BACKUP_HOUR:-3}"
MIN="${BACKUP_MINUTE:-$(( $(hostname | cksum | cut -d' ' -f1) % 60 ))}"
CAL="$(printf '*-*-* %02d:%02d:00' "$HOUR" "$MIN")"

cat > "$SERVICE" <<EOF
[Unit]
Description=PAODO offsite backup (restic)
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$RUN_USER
WorkingDirectory=$REPO_DIR
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/usr/bin/bash $REPO_DIR/scripts/backup-offsite.sh
EOF

cat > "$TIMER" <<EOF
[Unit]
Description=Nightly PAODO offsite backup

[Timer]
OnCalendar=$CAL
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now paodo-backup.timer
echo "installed paodo-backup.timer at $CAL (user=$RUN_USER, repo=$REPO_DIR)"
systemctl list-timers paodo-backup.timer --no-pager 2>/dev/null || true
