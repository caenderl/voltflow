#!/usr/bin/env bash
# Off-site backup of the Voltflow database (+ .env and certs) to a restic repo.
# restic gives us encryption, deduplication, integrity checks and GFS retention
# in one tool — the pieces the local scripts/backup.sh (fast on-host tier) lacks.
#
# This is the SECOND tier: keep the daily on-host dumps AND push off-site so a
# lost/wiped host does not take every backup with it (3-2-1 rule).
#
# Setup (once, on the server):
#   1) create a private cloud bucket + scoped key (Backblaze B2, S3, MinIO, ...)
#   2) cp scripts/backup.env.example scripts/backup.env  and fill it in
#   3) set -a; . scripts/backup.env; set +a; restic init   # create the repo
#
# Run (prod):
#   COMPOSE_FILE=docker-compose.prod.yml ./scripts/backup-offsite.sh
# Typically chained after backup.sh in cron (see README).
set -euo pipefail
cd "$(dirname "$0")/.."

# Secrets & repo location live outside git (see .gitignore).
ENV_FILE="${BACKUP_ENV:-scripts/backup.env}"
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE — copy scripts/backup.env.example" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a

command -v restic >/dev/null || { echo "restic not installed" >&2; exit 1; }
# The rclone: backend (e.g. Google Drive) shells out to rclone.
case "${RESTIC_REPOSITORY:-}" in
  rclone:*) command -v rclone >/dev/null || { echo "rclone not installed (needed for the rclone: backend)" >&2; exit 1; } ;;
esac

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
# GFS retention (override in backup.env if desired).
KEEP_DAILY="${KEEP_DAILY:-14}"
KEEP_WEEKLY="${KEEP_WEEKLY:-8}"
KEEP_MONTHLY="${KEEP_MONTHLY:-12}"

# Optional dead-man's-switch (e.g. healthchecks.io): ping /start, /fail, success.
HEALTHCHECK_URL="${HEALTHCHECK_URL:-}"
ping() { [ -n "$HEALTHCHECK_URL" ] && curl -fsS -m 10 --retry 3 "$HEALTHCHECK_URL$1" >/dev/null 2>&1 || true; }
trap 'ping /fail' ERR

ping /start

# 1) DB dump straight into restic via stdin. Uncompressed SQL deduplicates far
#    better across days than a gzipped file would (a small change no longer
#    rewrites the whole stream); restic compresses the stored blobs itself.
echo "[offsite] backing up database ..."
docker compose -f "$COMPOSE_FILE" exec -T db \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  | restic backup --stdin --stdin-filename voltflow.sql --host voltflow --tag db

# 2) Config needed to rebuild the host from bare metal: credentials (.env) and
#    the TLS bundle. The restic repo is encrypted, so secrets are safe at rest.
echo "[offsite] backing up config (.env, certs) ..."
restic backup --host voltflow --tag config .env certs

# 3) GFS retention + prune (per snapshot group = per path, so db and config
#    each keep their own daily/weekly/monthly set).
echo "[offsite] applying retention (${KEEP_DAILY}d/${KEEP_WEEKLY}w/${KEEP_MONTHLY}m) ..."
restic forget --host voltflow \
  --keep-daily "$KEEP_DAILY" --keep-weekly "$KEEP_WEEKLY" --keep-monthly "$KEEP_MONTHLY" \
  --prune

# 4) Cheap structural/metadata integrity check every run. A deeper data check
#    (restic check --read-data-subset=…) is worth scheduling weekly.
echo "[offsite] verifying repository ..."
restic check

ping   # success
echo "[offsite] done."
