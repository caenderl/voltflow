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
#   all              3 collectors + backend + frontend   (default if omitted)
#   app              backend + frontend  (UI/API update, leaves collectors running)
#   collector        all 3 collector containers (meter + sma + wallbox)
#   collector-meter | collector-sma | collector-wallbox   pick one collector
#   backend | frontend                                    pick one service
#
# Options:
#   --env          also push the local .env to the server (default: keep server's)
#   --prune        `docker image prune -f` on the server afterwards (old layers)
#   --dry-run      print every step without building/transferring/deploying
#   -h, --help     show this header
#
# Safety: never runs `down` and never `-v`. The `db` service is never built or
# transferred; its container is only (re)started if needed and its named volume
# `voltflow-db-data` is never touched -> no data loss. A full deploy adds
# `--remove-orphans` so the pre-split `collector` monolith container is cleaned
# up (otherwise it keeps a second Anker MQTT session alive alongside
# collector-meter); partial deploys never touch other containers.
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

COLLECTORS=(collector-meter collector-sma collector-wallbox)
PUSH_ENV=0; PRUNE=0; DRY=0; DEPLOY_ALL=0
services=()

while [ $# -gt 0 ]; do
  case "$1" in
    all)                          services=("${COLLECTORS[@]}" backend frontend); DEPLOY_ALL=1 ;;
    app)                          services+=(backend frontend) ;;
    collector)                    services+=("${COLLECTORS[@]}") ;;
    collector-meter|collector-sma|collector-wallbox|backend|frontend)
                                  services+=("$1") ;;
    --env)                        PUSH_ENV=1 ;;
    --prune)                      PRUNE=1 ;;
    --dry-run)                    DRY=1 ;;
    # Print the header comment block (robust to its length: stop at first non-#).
    -h|--help)                    awk 'NR>1{ if(/^#/){sub(/^# ?/,"");print} else exit }' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done
if [ ${#services[@]} -eq 0 ]; then
  services=("${COLLECTORS[@]}" backend frontend); DEPLOY_ALL=1
fi

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
if [ "$DEPLOY_ALL" -eq 1 ]; then
  # Full deploy: start everything and drop orphans (e.g. the pre-split monolith
  # `collector` container) so it can't keep a second Anker session alive.
  run ssh "$SERVER" "cd ~/$REMOTE_DIR && docker compose -f $COMPOSE_FILE up -d --remove-orphans"
else
  run ssh "$SERVER" "cd ~/$REMOTE_DIR && docker compose -f $COMPOSE_FILE up -d ${services[*]}"
fi

[ "$PRUNE" -eq 1 ] && run ssh "$SERVER" "docker image prune -f"

step "Status"
run ssh "$SERVER" "cd ~/$REMOTE_DIR && docker compose -f $COMPOSE_FILE ps --format 'table {{.Name}}\t{{.Status}}'"

step "Done."
