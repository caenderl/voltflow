#!/usr/bin/env bash
# Deploy the Voltflow prod stack (or a subset) to the server from prebuilt
# amd64 images — WITHOUT DATA LOSS. Cross-builds the images on this machine,
# transfers them via `docker save | ssh | docker load`, syncs the bundle and
# runs the prebuilt images on the server with `docker compose up -d`.
#
# Usage:
#   scripts/deploy.sh [TARGET ...] [options]
#
# TARGET:
#   all            collector + backend + frontend   (default if omitted)
#   app            backend + frontend  (UI/API update, leaves collector running)
#   backend | frontend | collector   pick individual services
#
# Options:
#   --env          also push the local .env to the server (default: keep server's)
#   --prune        `docker image prune -f` on the server afterwards (old layers)
#   --dry-run      print every step without building/transferring/deploying
#   -h, --help     show this header
#
# Safety: never runs `down` and never `-v`. The `db` service is never built or
# transferred; its container is only (re)started if needed and its named volume
# `voltflow-db-data` is never touched -> no data loss.
#
# Config via env vars:
#   SERVER        ssh alias/host         (default: voltflow)
#   REMOTE_DIR    dir under remote $HOME (default: voltflow)
#   COMPOSE_FILE  compose file           (default: docker-compose.prod.yml)
set -euo pipefail
cd "$(dirname "$0")/.."

SERVER="${SERVER:-voltflow}"
REMOTE_DIR="${REMOTE_DIR:-voltflow}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
PLATFORM="linux/amd64"

PUSH_ENV=0; PRUNE=0; DRY=0
services=()

while [ $# -gt 0 ]; do
  case "$1" in
    all)                          services=(collector backend frontend) ;;
    app)                          services+=(backend frontend) ;;
    backend|frontend|collector)   services+=("$1") ;;
    --env)                        PUSH_ENV=1 ;;
    --prune)                      PRUNE=1 ;;
    --dry-run)                    DRY=1 ;;
    -h|--help)                    sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done
[ ${#services[@]} -eq 0 ] && services=(collector backend frontend)

# de-duplicate while preserving order (e.g. `app frontend`)
mapfile -t services < <(printf '%s\n' "${services[@]}" | awk '!seen[$0]++')

images=()
for s in "${services[@]}"; do images+=("voltflow-$s:latest"); done

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
run()  { echo "+ $*"; [ "$DRY" -eq 1 ] || "$@"; }

step "Deploy [${services[*]}] -> $SERVER:~/$REMOTE_DIR (platform $PLATFORM)"

# 0) Pre-flight: the bundle sync (step 3) ships the TLS cert for nginx; fail
# fast BEFORE building/transferring images instead of aborting mid-deploy
# with the new images already loaded on the server.
if [ ! -f certs/voltflow.crt ] || [ ! -f certs/voltflow.key ]; then
  echo "ERROR: certs/voltflow.crt / certs/voltflow.key missing (gitignored, per-machine)." >&2
  echo "       Generate them with mkcert - see README, 'HTTPS-Zertifikat' section." >&2
  exit 1
fi

# 1) Cross-build the selected images for amd64
run docker buildx bake -f "$COMPOSE_FILE" --set "*.platform=$PLATFORM" --load "${services[@]}"

# 2) Transfer images to the server's Docker engine (no registry)
step "Transfer images: ${images[*]}"
if [ "$DRY" -eq 1 ]; then
  echo "+ docker save ${images[*]} | gzip | ssh $SERVER 'gunzip | docker load'"
else
  docker save "${images[@]}" | gzip | ssh "$SERVER" 'gunzip | docker load'
fi

# 3) Sync the deploy bundle (compose always; init.sql/certs harmless; .env opt-in)
step "Sync bundle"
run ssh "$SERVER" "mkdir -p ~/$REMOTE_DIR/db ~/$REMOTE_DIR/certs"
run scp "$COMPOSE_FILE" "$SERVER:$REMOTE_DIR/$COMPOSE_FILE"
run scp db/init.sql "$SERVER:$REMOTE_DIR/db/init.sql"
run scp certs/voltflow.crt certs/voltflow.key "$SERVER:$REMOTE_DIR/certs/"
# nginx-unprivileged runs as a non-root user; scp preserves the local 600 mode
# on the key, which that user can't read - relax it on the server copy only.
run ssh "$SERVER" "chmod 644 ~/$REMOTE_DIR/certs/voltflow.key"
if [ "$PUSH_ENV" -eq 1 ]; then
  run scp .env "$SERVER:$REMOTE_DIR/.env"
else
  echo "  (.env not pushed; use --env to override)"
fi

# 4) Start / update on the server — never `down`, never `-v`
step "Start/update on server"
if [ ${#services[@]} -eq 3 ]; then
  run ssh "$SERVER" "cd ~/$REMOTE_DIR && docker compose -f $COMPOSE_FILE up -d"
else
  run ssh "$SERVER" "cd ~/$REMOTE_DIR && docker compose -f $COMPOSE_FILE up -d ${services[*]}"
fi

[ "$PRUNE" -eq 1 ] && run ssh "$SERVER" "docker image prune -f"

step "Status"
run ssh "$SERVER" "cd ~/$REMOTE_DIR && docker compose -f $COMPOSE_FILE ps --format 'table {{.Name}}\t{{.Status}}'"

step "Done."
