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

# --- status file for the admin UI --------------------------------------------
# The backend cannot query restic itself (no binary, no repo password, and the
# repo lives in the cloud), so every run drops a summary here for it to read.
# Written on success AND failure — an ok:false file is what makes a broken
# off-site backup visible in the "System" tab instead of silently missing.
STATUS_FILE="${STATUS_FILE:-backups/status.json}"
stage="startup"      # updated before each step, reported when one fails
check_ok="null"      # true/false once `restic check` has run

# $1 = true|false (run succeeded), $2 = failed stage ("" when ok).
# Best-effort by design: a status file we cannot write must never fail a backup.
write_status() {
  command -v jq >/dev/null 2>&1 || { echo "[offsite] jq missing — no status.json" >&2; return 0; }
  local ok="$1" failed="${2:-}" snaps stats tmp

  # Snapshot list, mapped to the shape the frontend consumes. The timestamps
  # carry nanoseconds, which fromdateiso8601 rejects — strip the fraction.
  snaps="$(restic snapshots --json 2>/dev/null | jq -c '
    def secs: sub("\\.[0-9]+"; "") | fromdateiso8601;
    [ .[-20:][] | {
        id: .short_id,
        time: .time,
        tag: (.tags[0] // ""),
        sizeBytes: (.summary.total_bytes_processed // 0),
        addedBytes: (.summary.data_added_packed // null),
        durationSec: (if .summary.backup_end and .summary.backup_start
                      then ((.summary.backup_end | secs) - (.summary.backup_start | secs))
                      else null end)
      } ]' 2>/dev/null)" || snaps=""
  [ -n "$snaps" ] || snaps="[]"

  # raw-data = bytes actually stored in the repo (deduplicated + compressed),
  # i.e. what the cloud bucket really holds — not the restore size.
  stats="$(restic stats --mode raw-data --json 2>/dev/null)" || stats=""
  [ -n "$stats" ] || stats="{}"

  tmp="$STATUS_FILE.part"
  # Guarded like everything else here: under `set -e` an unguarded failure
  # would abort the whole script mid-function, and when called from on_error
  # that means the fail ping never fires — the one thing this must not skip.
  mkdir -p "$(dirname "$STATUS_FILE")" || true
  # Written to a temp file and moved into place so the backend never reads a
  # half-written file.
  if jq -n \
      --arg time "$(date -Iseconds)" \
      --argjson ok "$ok" \
      --arg failed "$failed" \
      --argjson checkOk "$check_ok" \
      --arg repo "${RESTIC_REPOSITORY:-}" \
      --argjson stats "$stats" \
      --argjson snaps "$snaps" \
      --arg kd "$KEEP_DAILY" --arg kw "$KEEP_WEEKLY" --arg km "$KEEP_MONTHLY" \
      '{ time: $time,
         ok: $ok,
         failedStage: (if $failed == "" then null else $failed end),
         checkOk: $checkOk,
         repository: $repo,
         repoSizeBytes: ($stats.total_size // null),
         snapshotCount: ($stats.snapshots_count // null),
         retention: { daily: ($kd | tonumber?), weekly: ($kw | tonumber?), monthly: ($km | tonumber?) },
         snapshots: $snaps }' > "$tmp" 2>/dev/null; then
    mv "$tmp" "$STATUS_FILE"
  else
    rm -f "$tmp"
    echo "[offsite] could not write $STATUS_FILE" >&2
  fi
  return 0
}

on_error() {
  trap - ERR                                   # don't re-enter from the handler
  if [ "$stage" = "check" ]; then check_ok="false"; fi
  write_status false "$stage"
  ping /fail
  exit 1
}
trap on_error ERR

ping /start

# 1) DB dump straight into restic via stdin. Uncompressed SQL deduplicates far
#    better across days than a gzipped file would (a small change no longer
#    rewrites the whole stream); restic compresses the stored blobs itself.
echo "[offsite] backing up database ..."
stage="db"
docker compose -f "$COMPOSE_FILE" exec -T db \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  | restic backup --stdin --stdin-filename voltflow.sql --host voltflow --tag db

# 2) Config needed to rebuild the host from bare metal: credentials (.env) and
#    the TLS bundle. The restic repo is encrypted, so secrets are safe at rest.
echo "[offsite] backing up config (.env, certs) ..."
stage="config"
restic backup --host voltflow --tag config .env certs

# 3) GFS retention + prune (per snapshot group = per path, so db and config
#    each keep their own daily/weekly/monthly set).
echo "[offsite] applying retention (${KEEP_DAILY}d/${KEEP_WEEKLY}w/${KEEP_MONTHLY}m) ..."
stage="retention"
restic forget --host voltflow \
  --keep-daily "$KEEP_DAILY" --keep-weekly "$KEEP_WEEKLY" --keep-monthly "$KEEP_MONTHLY" \
  --prune

# 4) Cheap structural/metadata integrity check every run. A deeper data check
#    (restic check --read-data-subset=…) is worth scheduling weekly.
echo "[offsite] verifying repository ..."
stage="check"
restic check
check_ok="true"

# 5) Leave the summary the admin UI reads (see write_status above).
stage="status"
write_status true ""

ping   # success
echo "[offsite] done."
