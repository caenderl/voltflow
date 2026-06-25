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
# Dump to a temp file first and only promote it on success. Otherwise a failed
# pg_dump (DB down, wrong project, auth) would leave a valid-looking but empty
# .gz behind that rotation could later keep in place of real backups.
tmp="$file.part"
trap 'rm -f "$tmp"' EXIT
# pg_dump runs inside the db container; credentials come from its POSTGRES_* env.
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' | gzip > "$tmp"
mv "$tmp" "$file"

# Rotation: keep only the newest $KEEP dumps
ls -1t "$BACKUP_DIR"/voltflow-*.sql.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

echo "Done ($(du -h "$file" | cut -f1)). Latest backups:"
ls -1t "$BACKUP_DIR"/voltflow-*.sql.gz | head -5
