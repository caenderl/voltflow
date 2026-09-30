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
# Rollback (needs an explicit TARGET - never defaults to `all`):
#   --rollback           put each TARGET back on the image it ran before the
#                        last deploy (`:previous`); running it again rolls forward
#   --rollback-to TAG    put each TARGET on a kept build, e.g. 1.4.7-befc896
#   --list-tags          show the kept builds per service on the server
#
# Every deploy tags the images it builds as <version>-<commit> (plus -dirty
# for an uncommitted tree) next to :latest, and first tags whatever is RUNNING
# on the server as :previous. The newest KEEP_TAGS builds per service are kept
# (default 5); older ones are untagged so the weekly `image prune` frees them.
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
KEEP_TAGS="${KEEP_TAGS:-5}"

COLLECTORS=(collector-meter collector-sma collector-wallbox)
PUSH_ENV=0; PRUNE=0; DRY=0; DEPLOY_ALL=0
ROLLBACK=""; LIST_TAGS=0
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
    --rollback)                   ROLLBACK="previous" ;;
    --rollback-to)                shift; ROLLBACK="${1:?--rollback-to needs a tag}" ;;
    --list-tags)                  LIST_TAGS=1 ;;
    # Print the header comment block (robust to its length: stop at first non-#).
    -h|--help)                    awk 'NR>1{ if(/^#/){sub(/^# ?/,"");print} else exit }' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done
if [ ${#services[@]} -eq 0 ]; then
  if [ -n "$ROLLBACK" ]; then
    # A rollback touches exactly what it is told to - a bare `--rollback`
    # silently restarting all five containers (the meter's MQTT session
    # included) is not a default anyone wants at the moment they need it.
    echo "--rollback needs an explicit TARGET (e.g. app, backend, collector-sma)" >&2
    exit 2
  fi
  services=("${COLLECTORS[@]}" backend frontend); DEPLOY_ALL=1
fi

# de-duplicate while preserving order (e.g. `app frontend`)
mapfile -t services < <(printf '%s\n' "${services[@]}" | awk '!seen[$0]++')

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
run()  { echo "+ $*"; [ "$DRY" -eq 1 ] || "$@"; }

# --- kept builds -------------------------------------------------------------
if [ "$LIST_TAGS" -eq 1 ]; then
  for s in "${services[@]}"; do
    echo "voltflow-$s:"
    ssh "$SERVER" "docker images voltflow-$s --format '  {{.Tag}}\t{{.CreatedSince}}\t{{.ID}}'"
  done
  exit 0
fi

if [ -n "$ROLLBACK" ]; then
  step "Rollback [${services[*]}] -> :$ROLLBACK on $SERVER"
  # Swap: the chosen image becomes :latest, and what is running now becomes
  # :previous - so a second `--rollback` is the way forward again. Checked
  # for every service before anything is retagged, so a missing tag cannot
  # leave the stack half rolled back.
  for s in "${services[@]}"; do
    run ssh "$SERVER" "docker image inspect voltflow-$s:$ROLLBACK >/dev/null" \
      || { echo "voltflow-$s:$ROLLBACK does not exist on $SERVER (see --list-tags)" >&2; exit 1; }
  done
  for s in "${services[@]}"; do
    run ssh "$SERVER" "cd ~/$REMOTE_DIR && \
      cur=\$(docker inspect -f '{{.Image}}' \$(docker compose -f $COMPOSE_FILE ps -q $s) 2>/dev/null); \
      docker tag voltflow-$s:$ROLLBACK voltflow-$s:latest && \
      { [ -z \"\$cur\" ] || docker tag \"\$cur\" voltflow-$s:previous; }"
  done
  run ssh "$SERVER" "cd ~/$REMOTE_DIR && docker compose -f $COMPOSE_FILE up -d ${services[*]}"
  step "Status"
  run ssh "$SERVER" "cd ~/$REMOTE_DIR && docker compose -f $COMPOSE_FILE ps --format 'table {{.Name}}\t{{.Status}}'"
  exit 0
fi

# What this build is: the release version plus the commit it was built from,
# so two deploys of one version (a fix before the bump) never share a tag.
VERSION="$(node -p "require('./package.json').version")"
COMMIT="$(git rev-parse --short HEAD)"
git diff --quiet HEAD -- || COMMIT="$COMMIT-dirty"
BUILD_TAG="$VERSION-$COMMIT"

images=()
for s in "${services[@]}"; do images+=("voltflow-$s:latest" "voltflow-$s:$BUILD_TAG"); done

step "Deploy [${services[*]}] as $BUILD_TAG -> $SERVER:~/$REMOTE_DIR (platform $PLATFORM)"

# 0) Pre-flight: the frontend joins the shared `edge` network (see
# docker-compose.prod.yml) to be reachable from the ingress
# (https://github.com/caenderl/ingress-deploy), which terminates TLS for it.
# No compose file creates `edge`, deliberately, so it does NOT reappear on its
# own after a server rebuild - and without it the frontend container will not
# start at all, taking the whole UI down over a missing one-liner. Fail fast
# BEFORE building/transferring images instead of aborting mid-deploy with the
# new images already loaded on the server.
if [ "$DRY" -eq 0 ] && printf '%s\n' "${services[@]}" | grep -qx frontend; then
  ssh "$SERVER" "docker network inspect edge >/dev/null 2>&1" || {
    echo "ERROR: network 'edge' does not exist on $SERVER." >&2
    echo "       Create it once:  ssh $SERVER docker network create edge" >&2
    echo "       It is the seam between this nginx and the stacks it proxies," >&2
    echo "       owned by neither, so that neither can remove it." >&2
    exit 1; }
fi

# 1) Cross-build the selected images for amd64, and give each its build tag
run docker buildx bake -f "$COMPOSE_FILE" --set "*.platform=$PLATFORM" --load "${services[@]}"
for s in "${services[@]}"; do run docker tag "voltflow-$s:latest" "voltflow-$s:$BUILD_TAG"; done

# 2) Rollback point: tag what is RUNNING as :previous before new images land.
# The container's own image id, not :latest - :latest may already be a build
# that was loaded but never started. A service that is not running yet (first
# deploy) simply has no rollback point.
step "Keep rollback point (:previous)"
for s in "${services[@]}"; do
  run ssh "$SERVER" "cd ~/$REMOTE_DIR && \
    cid=\$(docker compose -f $COMPOSE_FILE ps -q $s 2>/dev/null); \
    if [ -n \"\$cid\" ]; then docker tag \$(docker inspect -f '{{.Image}}' \$cid) voltflow-$s:previous && echo '  voltflow-$s:previous kept'; \
    else echo '  voltflow-$s not running - no rollback point'; fi"
done

# 3) Transfer images to the server's Docker engine (no registry). Both tags go
# along; `docker save` stores the layers once.
step "Transfer images: ${images[*]}"
if [ "$DRY" -eq 1 ]; then
  echo "+ docker save ${images[*]} | gzip | ssh $SERVER 'gunzip | docker load'"
else
  docker save "${images[@]}" | gzip | ssh "$SERVER" 'gunzip | docker load'
fi

# 4) Sync the deploy bundle (compose always; init.sql harmless; .env opt-in).
# TLS lives in the separate ingress repo - nothing to sync for it here.
step "Sync bundle"
run ssh "$SERVER" "mkdir -p ~/$REMOTE_DIR/db"
run scp "$COMPOSE_FILE" "$SERVER:$REMOTE_DIR/$COMPOSE_FILE"
run scp db/init.sql "$SERVER:$REMOTE_DIR/db/init.sql"
if [ "$PUSH_ENV" -eq 1 ]; then
  run scp .env "$SERVER:$REMOTE_DIR/.env"
else
  echo "  (.env not pushed; use --env to override)"
fi

# 5) Start / update on the server — never `down`, never `-v`
step "Start/update on server"
if [ "$DEPLOY_ALL" -eq 1 ]; then
  # Full deploy: start everything and drop orphans (e.g. the pre-split monolith
  # `collector` container) so it can't keep a second Anker session alive.
  run ssh "$SERVER" "cd ~/$REMOTE_DIR && docker compose -f $COMPOSE_FILE up -d --remove-orphans"
else
  run ssh "$SERVER" "cd ~/$REMOTE_DIR && docker compose -f $COMPOSE_FILE up -d ${services[*]}"
fi

# 6) Keep the newest KEEP_TAGS builds per service. Only <version>-<commit>
# tags are counted; :latest and :previous are never touched, and untagging a
# build that one of them still points at leaves that image in place.
step "Keep newest $KEEP_TAGS builds per service"
for s in "${services[@]}"; do
  run ssh "$SERVER" "docker images voltflow-$s --format '{{.Tag}}' \
    | grep -E '^[0-9]+\.[0-9]+\.[0-9]+' | sort -V | head -n -$KEEP_TAGS \
    | xargs -r -I{} docker rmi voltflow-$s:{}"
done

[ "$PRUNE" -eq 1 ] && run ssh "$SERVER" "docker image prune -f"

step "Status"
run ssh "$SERVER" "cd ~/$REMOTE_DIR && docker compose -f $COMPOSE_FILE ps --format 'table {{.Name}}\t{{.Status}}'"

step "Done."
