#!/usr/bin/env bash
# Regenerate the collector lockfiles (apps/collector/requirements-<c>.lock).
#
#   scripts/lock-collector-deps.sh               # all three: meter sma wallbox
#   scripts/lock-collector-deps.sh sma           # just one
#
# The .txt files hold the ranges a human edits; the .lock files hold the exact
# versions each image installs, so a rebuild never picks up a new release on
# its own (pysma-plus / pymodbus changes are device-protocol changes, not
# something to take by accident). Resolved inside the image's own base
# (read from its Dockerfile) for linux/amd64, i.e. the wheels prod runs.
#
# anker-solix-api is not in the meter lock: Dockerfile.meter installs it from a
# pinned commit with --no-deps. Its runtime deps are listed in
# requirements-meter.txt, so they are resolved and locked here.
set -euo pipefail
cd "$(dirname "$0")/../apps/collector"

targets=("$@")
[ ${#targets[@]} -gt 0 ] || targets=(meter sma wallbox)

for c in "${targets[@]}"; do
  [ -f "requirements-$c.txt" ] || { echo "Unknown collector: $c" >&2; exit 1; }
  image=$(awk '/^FROM /{print $2; exit}' "Dockerfile.$c")
  echo "Locking $c in $image ..."
  frozen=$(docker run --rm --platform linux/amd64 -v "$PWD:/src:ro" -w /src "$image" \
    sh -c "pip install -q --disable-pip-version-check --root-user-action=ignore \
             -r requirements-$c.txt >/dev/null && pip freeze")
  {
    echo "# GENERATED - exact versions installed into the collector-$c image."
    echo "# Edit requirements-$c.txt (the ranges), then regenerate with"
    echo "#   scripts/lock-collector-deps.sh $c"
    echo "$frozen"
  } > "requirements-$c.lock"
  echo "  wrote requirements-$c.lock ($(echo "$frozen" | wc -l | tr -d ' ') packages)"
done
