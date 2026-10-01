#!/usr/bin/env bash
# Installs the newest version of the `production` branch on the server.
#
# Run automatically by a timer on the server (every 2 minutes and at every
# start-up) - see DEPLOY-AUTOMATION.md. You can also run it by hand:
#     bash scripts/deploy.sh
#
# Safe to run any time:
#   * if the server already runs the latest code, it does nothing;
#   * after updating it checks the backend is healthy, and if not it goes back
#     to the previous version;
#   * a version that failed is not retried until a newer commit arrives
#     (use FORCE=1 to try it again anyway).
#
# The whole body is inside main(), so bash has read the file completely before
# `git reset` can replace it with a newer copy.
set -euo pipefail

FAILED_FILE="${DEPLOY_FAILED_FILE:-/var/tmp/evide-school-bus-failed-sha}"

healthy() {
  local i
  for i in $(seq 1 30); do
    if docker compose exec -T backend node -e \
      "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
      >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

main() {
  local app_dir branch prev next fetch_err
  app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  branch="${DEPLOY_BRANCH:-production}"
  cd "$app_dir"

  if [ ! -f .env ]; then
    echo "No .env file in $app_dir - not deploying."
    return 1
  fi

  # One deploy at a time (the timer and a manual run could overlap).
  exec 9>"${DEPLOY_LOCK_FILE:-/tmp/evide-school-bus-deploy.lock}"
  if ! flock -w 600 9; then
    echo "Another deploy is still running; giving up."
    return 1
  fi

  if ! fetch_err="$(git fetch --prune origin "$branch" 2>&1)"; then
    echo "Could not fetch '$branch' from GitHub: $(printf '%s' "$fetch_err" | tail -n 1)"
    echo "(Network not ready yet, or the server has no read access: see DEPLOY-AUTOMATION.md step 2.) Will try again later."
    return 0
  fi

  prev="$(git rev-parse HEAD)"
  next="$(git rev-parse "origin/$branch")"

  if [ "$prev" = "$next" ] && [ -z "${FORCE:-}" ]; then
    # Already on the latest code. Just make sure the containers are running.
    docker compose up -d >/dev/null 2>&1 || true
    return 0
  fi

  if [ "$(cat "$FAILED_FILE" 2>/dev/null || true)" = "$next" ] && [ -z "${FORCE:-}" ]; then
    echo "Version ${next:0:7} failed before; waiting for a newer commit on $branch."
    return 0
  fi

  echo "== $(date -u '+%F %T') UTC: updating ${prev:0:7} -> ${next:0:7} ($branch)"
  git checkout -q "$branch" 2>/dev/null || git checkout -q -B "$branch" "origin/$branch"
  git reset --hard "origin/$branch"
  docker compose up -d --build

  if healthy; then
    rm -f "$FAILED_FILE"
    docker image prune -f >/dev/null 2>&1 || true
    echo "Deployed ${next:0:7}. Backend is healthy."
    return 0
  fi

  echo "!! ${next:0:7} did not become healthy. Last backend logs:"
  docker compose logs --tail 40 backend || true
  echo "!! Going back to ${prev:0:7}."
  echo "$next" > "$FAILED_FILE"
  git reset --hard "$prev"
  docker compose up -d --build
  if healthy; then echo "Rolled back to ${prev:0:7}; backend is healthy."; else echo "!! Backend is still not healthy after rolling back. Check: docker compose logs backend"; fi
  return 1
}

main "$@"
exit $?
