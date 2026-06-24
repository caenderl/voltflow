#!/usr/bin/env bash
# Restore a Voltflow backup into the running DB (TimescaleDB-aware).
#
#   ./scripts/restore.sh backups/voltflow-YYYYMMDD-HHMMSS.sql.gz
# Prod:
#   COMPOSE_FILE=docker-compose.prod.yml COMPOSE_PROJECT_NAME=voltflow-prod \
#     ./scripts/restore.sh <dump.sql.gz>
#
# Best restored into a FRESH database. TimescaleDB needs pre/post_restore around
# the data load so hypertables/aggregates are restored correctly.
set -euo pipefail
cd "$(dirname "$0")/.."

file="${1:?Usage: restore.sh <backup.sql.gz>}"
[ -f "$file" ] || { echo "File not found: $file" >&2; exit 1; }

psql_in() { docker compose exec -T db sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" $*"; }

echo "Preparing TimescaleDB for restore ..."
psql_in '-c "SELECT timescaledb_pre_restore();"'

echo "Loading dump $file ..."
gunzip -c "$file" | docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'

echo "Finalizing ..."
psql_in '-c "SELECT timescaledb_post_restore();"'

echo "Restore complete."
