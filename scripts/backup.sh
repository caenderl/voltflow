#!/usr/bin/env bash
# Dump the Voltflow TimescaleDB to a gzipped SQL file with rotation.
#
# Dev (default, docker-compose.yml):
#   ./scripts/backup.sh
# Prod (Raspberry Pi):
#   COMPOSE_FILE=docker-compose.prod.yml COMPOSE_PROJECT_NAME=voltflow-prod ./scripts/backup.sh
#
# Env:
#   BACKUP_DIR (default ./backups)   KEEP (default 14 newest dumps)
set -euo pipefail
cd "$(dirname "$0")/.."

BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP="${KEEP:-14}"
mkdir -p "$BACKUP_DIR"

ts=$(date +%Y%m%d-%H%M%S)
file="$BACKUP_DIR/voltflow-$ts.sql.gz"

echo "Dumping database -> $file"
# pg_dump runs inside the db container; credentials come from its POSTGRES_* env.
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' | gzip > "$file"

# Rotation: keep only the newest $KEEP dumps
ls -1t "$BACKUP_DIR"/voltflow-*.sql.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

echo "Done ($(du -h "$file" | cut -f1)). Latest backups:"
ls -1t "$BACKUP_DIR"/voltflow-*.sql.gz | head -5
