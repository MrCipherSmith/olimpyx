#!/usr/bin/env bash
# Deploy Olimpyx from a dedicated checkout while preserving the developer tree
# and its gitignored runtime configuration.
set -Eeuo pipefail

source_dir="${OLIMPYX_SOURCE_DIR:-/home/altsay/olimpyx}"
deploy_dir="${OLIMPYX_DEPLOY_DIR:-/home/altsay/olimpyx-deploy}"
state_dir="${OLIMPYX_STATE_DIR:-/home/altsay/.local/state/olimpyx-deploy}"
repo_url="${REPOSITORY_URL:-https://github.com/MrCipherSmith/olimpyx.git}"
deploy_sha="${DEPLOY_SHA:?DEPLOY_SHA is required}"
public_health_url="${OLIMPYX_PUBLIC_HEALTH_URL:-https://olimpyx.mrciphersmith.com/health/ready}"
last_successful_file="$state_dir/last-successful-sha"

if [[ ! "$deploy_sha" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "DEPLOY_SHA must be a full 40-character Git commit SHA" >&2
  exit 2
fi

if [ ! -d "$deploy_dir/.git" ]; then
  git clone "$repo_url" "$deploy_dir"
fi

git config --global --add safe.directory "$deploy_dir" 2>/dev/null || true
git -C "$deploy_dir" fetch --prune origin main
git -C "$deploy_dir" fetch origin "$deploy_sha"

if [ ! -f "$last_successful_file" ]; then
  echo "Missing deployment state: $last_successful_file" >&2
  echo "Bootstrap it with the SHA of the currently verified healthy deployment" >&2
  exit 1
fi
previous_sha="$(cat "$last_successful_file")"
if [[ ! "$previous_sha" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "Invalid last-successful SHA in $last_successful_file" >&2
  exit 1
fi
if ! git -C "$deploy_dir" cat-file -e "${previous_sha}^{commit}" 2>/dev/null; then
  git -C "$deploy_dir" fetch origin "$previous_sha"
fi
git -C "$deploy_dir" cat-file -e "${previous_sha}^{commit}"

sync_runtime_files() {
  if [ -f "$source_dir/compose.override.yaml" ]; then
    cp -f "$source_dir/compose.override.yaml" "$deploy_dir/compose.override.yaml"
  elif [ -f "$deploy_dir/compose.override.yaml" ]; then
    unlink "$deploy_dir/compose.override.yaml"
  fi
  if [ -f "$source_dir/.env" ]; then
    cp -f "$source_dir/.env" "$deploy_dir/.env"
    chmod 0600 "$deploy_dir/.env"
  elif [ -f "$deploy_dir/.env" ]; then
    unlink "$deploy_dir/.env"
  fi
}

compose() {
  local files=(-f "$deploy_dir/compose.yaml")
  if [ -f "$deploy_dir/compose.override.yaml" ]; then
    files+=(-f "$deploy_dir/compose.override.yaml")
  fi
  docker compose --project-name olimpyx "${files[@]}" "$@"
}

wait_for_url() {
  local url="$1"
  local attempts="${2:-30}"
  local index
  for ((index = 1; index <= attempts; index++)); do
    if curl --fail --silent --show-error --max-time 5 "$url" >/dev/null; then
      return 0
    fi
    sleep 2
  done
  echo "Health check failed: $url" >&2
  return 1
}

rollback() {
  local status="$?"
  local rollback_status=0
  trap - ERR
  echo "Deployment failed; rolling back to $previous_sha" >&2
  echo "Logs from the failed deployment:" >&2
  compose logs --tail 100 api web >&2 || true
  set +e
  git -C "$deploy_dir" reset --hard "$previous_sha" || rollback_status=1
  sync_runtime_files || rollback_status=1
  compose build api web || rollback_status=1
  compose up -d --wait --wait-timeout 120 db api web || rollback_status=1
  wait_for_url "http://127.0.0.1:4173/health/ready" 15 || rollback_status=1
  wait_for_url "$public_health_url" 15 || rollback_status=1
  if [ "$rollback_status" -ne 0 ]; then
    echo "Rollback failed; production requires manual recovery" >&2
    compose logs --tail 100 api web >&2 || true
    exit 70
  fi
  echo "Rollback restored $previous_sha" >&2
  exit "$status"
}

trap rollback ERR
git -C "$deploy_dir" reset --hard "$deploy_sha"
sync_runtime_files
compose config --quiet
compose build --pull api web
compose up -d --wait --wait-timeout 120 db api web
wait_for_url "http://127.0.0.1:4173/health/ready"
wait_for_url "$public_health_url"
mkdir -p "$state_dir"
temporary_state="$(mktemp "$state_dir/last-successful-sha.XXXXXX")"
printf '%s\n' "$deploy_sha" > "$temporary_state"
chmod 0600 "$temporary_state"
mv "$temporary_state" "$last_successful_file"
trap - ERR

echo "Olimpyx deployment complete: sha=$deploy_sha"
