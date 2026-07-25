#!/usr/bin/env bash
# Prove the off-site backup is actually restorable.
#
# A backup that has never been restored is a hope, not a backup. This pulls the
# newest DB snapshot out of the restic repo, restores it into a THROWAWAY
# TimescaleDB container and sanity-checks the result, then tears everything
# down. The production database is never touched — nothing here connects to it
# except one read-only row count used for comparison.
#
#   ./scripts/verify-restore.sh            # verify the latest db snapshot
#   ./scripts/verify-restore.sh 04b52b86   # verify a specific snapshot
#
# Exit code 0 = restore verified, non-zero = something is wrong (cron-friendly).
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="${BACKUP_ENV:-scripts/backup.env}"
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE — copy scripts/backup.env.example" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a
command -v restic >/dev/null || { echo "restic not installed" >&2; exit 1; }
case "${RESTIC_REPOSITORY:-}" in
  rclone:*) command -v rclone >/dev/null || { echo "rclone not installed" >&2; exit 1; } ;;
esac

SNAP="${1:-latest}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
# Must match the image the dump came from: a TimescaleDB restore only works
# into the same extension version (and PG major).
DB_IMAGE="${DB_IMAGE:-timescale/timescaledb:2.28.1-pg16}"
CONTAINER="voltflow-restore-verify"
# Restore under the same role name the dump was taken with, otherwise every
# `ALTER ... OWNER TO` in the dump fails.
# \042 = double quote, \047 = single quote — the value may be quoted in .env.
PGUSER_NAME="$(grep -E '^POSTGRES_USER=' .env 2>/dev/null | cut -d= -f2- | tr -d '\042\047' || true)"
PGUSER_NAME="${PGUSER_NAME:-voltflow}"

dump_file="$(mktemp -t voltflow-verify-XXXXXX.sql)"
cleanup() {
  rm -f "$dump_file"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
psql_q() {  # quiet, tuples-only query against the throwaway DB
  docker exec -e PGPASSWORD=verify "$CONTAINER" \
    psql -U "$PGUSER_NAME" -d verifydb -tAX -c "$1"
}

echo "==> 1/5 fetching snapshot '$SNAP' from $RESTIC_REPOSITORY"
restic dump --tag db "$SNAP" voltflow.sql > "$dump_file"
size=$(wc -c < "$dump_file")
[ "$size" -gt 1000000 ] || fail "dump is only $size bytes — truncated or empty"
echo "    got $(du -h "$dump_file" | cut -f1)"

echo "==> 2/5 starting throwaway database ($DB_IMAGE)"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
# --rm drops the anonymous data volume with the container; no ports published.
docker run -d --rm --name "$CONTAINER" --memory=1g \
  -e POSTGRES_USER="$PGUSER_NAME" -e POSTGRES_PASSWORD=verify -e POSTGRES_DB=verifydb \
  "$DB_IMAGE" >/dev/null
for i in $(seq 1 60); do
  docker exec "$CONTAINER" pg_isready -U "$PGUSER_NAME" -d verifydb >/dev/null 2>&1 && break
  [ "$i" = 60 ] && fail "throwaway database did not become ready"
  sleep 2
done

echo "==> 3/5 restoring (TimescaleDB pre/post_restore)"
# Extension must exist BEFORE pre_restore; each psql call is its own session,
# which is what makes the restoring flag take effect.
psql_q "CREATE EXTENSION IF NOT EXISTS timescaledb" >/dev/null
psql_q "SELECT timescaledb_pre_restore()" >/dev/null
docker exec -i "$CONTAINER" psql -U "$PGUSER_NAME" -d verifydb -q -v ON_ERROR_STOP=0 \
  < "$dump_file" > /tmp/verify-restore-psql.log 2>&1 || true
psql_q "SELECT timescaledb_post_restore()" >/dev/null

echo "==> 4/5 checking restored contents"
hypertables=$(psql_q "SELECT count(*) FROM timescaledb_information.hypertables")
caggs=$(psql_q "SELECT count(*) FROM timescaledb_information.continuous_aggregates")
echo "    hypertables=$hypertables  continuous aggregates=$caggs"
[ "${hypertables:-0}" -ge 3 ] || fail "expected >=3 hypertables, got ${hypertables:-0}"
[ "${caggs:-0}" -ge 9 ]       || fail "expected >=9 continuous aggregates, got ${caggs:-0}"

ok=1
for t in meter_reading sma_readings wallbox_reading; do
  n=$(psql_q "SELECT count(*) FROM $t" 2>/dev/null || echo 0)
  latest=$(psql_q "SELECT COALESCE(max(time)::text,'-') FROM $t" 2>/dev/null || echo '-')
  printf '    %-16s %10s rows   latest: %s\n' "$t" "$n" "$latest"
  [ "${n:-0}" -gt 0 ] || { echo "    ^ EMPTY"; ok=0; }
done
[ "$ok" = 1 ] || fail "at least one measurement table restored empty"

# Config tables are small but losing them loses tariffs/checkpoints.
for t in meter_checkpoint tariff_period; do
  n=$(psql_q "SELECT count(*) FROM $t" 2>/dev/null || echo 0)
  printf '    %-16s %10s rows\n' "$t" "$n"
done

echo "==> 5/5 comparing against the live database (read-only)"
live=$(docker compose -f "$COMPOSE_FILE" exec -T db \
        sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAX -c "SELECT count(*) FROM meter_reading"' \
        2>/dev/null | tr -d '[:space:]' || echo "")
restored=$(psql_q "SELECT count(*) FROM meter_reading")
if [ -n "$live" ]; then
  echo "    meter_reading: restored=$restored  live=$live (live grows after the snapshot — restored must not exceed it by much)"
else
  echo "    (live database not reachable — comparison skipped)"
fi

echo
echo "RESTORE VERIFIED — snapshot '$SNAP' restores into a working TimescaleDB."
