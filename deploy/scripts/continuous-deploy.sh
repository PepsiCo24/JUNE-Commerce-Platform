#!/usr/bin/env bash
# Called over SSH by GitHub Actions; accepts only a tested, immutable main SHA.
set -euo pipefail

fail() { printf '%s\n' "$1" >&2; exit 1; }
[ "$#" -eq 3 ] || fail 'Usage: continuous-deploy.sh CHECKOUT_PATH COMMIT_SHA IMAGE_PREFIX'
checkout_path="$1"
commit_sha="$2"
image_prefix="$3"
[[ "$checkout_path" = /* && "$checkout_path" != / ]] || fail 'Checkout must be an absolute directory'
[[ "$commit_sha" =~ ^[0-9a-f]{40}$ ]] || fail 'Expected a full commit SHA'
[[ "$image_prefix" =~ ^ghcr\.io/[a-z0-9._/-]+$ ]] || fail 'Expected a lowercase GHCR image prefix'
command -v flock >/dev/null || fail 'Install util-linux (flock) on the server'
cd "$checkout_path"
git rev-parse --is-inside-work-tree >/dev/null
[ -f .env ] || fail 'Run the documented first-server setup before enabling deployment'

# GitHub serializes jobs; this lock also protects against another runner/session.
exec 9>"$(git rev-parse --git-path june-deploy.lock)"
flock -w 1800 9 || fail 'Timed out waiting for deployment lock'
[ -z "$(git status --porcelain --untracked-files=no)" ] || fail 'Server has uncommitted tracked changes; refusing to overwrite them'
git fetch --no-tags origin '+refs/heads/main:refs/remotes/origin/main'
latest_sha="$(git rev-parse refs/remotes/origin/main)"
if [ "$commit_sha" != "$latest_sha" ]; then
  printf 'Skipping stale run %s; main is now %s\n' "$commit_sha" "$latest_sha"
  exit 0
fi

previous_sha="$(git rev-parse HEAD)"
[ -s deploy/.state/current-image-tag ] || fail 'Missing successful release state; complete bootstrap first'
previous_tag="$(cat deploy/.state/current-image-tag)"
started_file="$(pwd)/deploy/.state/continuous-deploy-started"
rm -f "$started_file"
trap 'rm -f "$started_file"' EXIT
git checkout --detach "$commit_sha"
export JUNE_IMAGE_PREFIX="$image_prefix"
export JUNE_IMAGE_TAG="$commit_sha"
# Use an ordinary command, not `if bash ...`: deploy.sh must retain errexit.
set +e
NO_ROLLBACK=1 JUNE_DEPLOY_STARTED_FILE="$started_file" bash deploy/scripts/deploy.sh
result=$?
set -e
if [ "$result" -ne 0 ]; then
  # Restore source BEFORE restoring containers so old Compose and Nginx settings
  # are used as well as the old image tag. Database volumes are never recreated.
  git checkout --detach "$previous_sha"
  if [ -f "$started_file" ]; then
    if JUNE_IMAGE_TAG="$previous_tag" docker compose --env-file .env \
      --project-directory "$checkout_path" -f docker-compose.yml \
      up -d --no-deps --force-recreate --wait --wait-timeout 180 worker api web nginx; then
      printf 'Previous application images and configuration restored and healthy.\n'
    else
      printf 'ROLLBACK FAILED: inspect server containers immediately.\n' >&2
    fi
  fi
  printf 'Deployment failed; source restored to %s. Inspect deploy/logs/deploy.log.\n' "$previous_sha" >&2
  exit "$result"
fi
printf 'Server source and application images updated to %s\n' "$commit_sha"
