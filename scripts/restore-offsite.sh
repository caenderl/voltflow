#!/usr/bin/env bash
# Restore a Voltflow DB dump from the off-site restic repo.
#
#   scripts/restore-offsite.sh [SNAPSHOT]     # default: latest
#   scripts/restore-offsite.sh snapshots      # list available snapshots
#
# Produces a gzipped SQL dump alongside the repo, then hand it to the existing
# TimescaleDB-aware restore.sh into a FRESH database (see README for the
# DROP DATABASE … WITH (FORCE) + recreate step that must precede a restore).
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="${BACKUP_ENV:-scripts/backup.env}"
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE — copy scripts/backup.env.example" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a
command -v restic >/dev/null || { echo "restic not installed" >&2; exit 1; }

if [ "${1:-}" = "snapshots" ]; then
  exec restic snapshots --tag db --host voltflow
fi

snap="${1:-latest}"
out="restore-$(date +%Y%m%d-%H%M%S).sql.gz"

echo "Restoring DB snapshot '$snap' -> $out"
restic dump "$snap" voltflow.sql | gzip > "$out"
echo "Wrote $out ($(du -h "$out" | cut -f1))."
echo
echo "Next — load into a FRESH database (data-safe path):"
echo "  COMPOSE_FILE=docker-compose.prod.yml ./scripts/restore.sh $out"
echo "(recreate the DB first if it already holds data — see README, 'Datensicherheit')."
