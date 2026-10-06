#!/usr/bin/env bash
# Mirror `.github/workflows/deploy-config.yml` (local + CI): validate every Caddyfile with the
# real caddy binary and every Compose file with `docker compose config`, using placeholder env.
# Needs a running Docker daemon with the Compose plugin. No network beyond pulling CADDY_IMAGE.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Official image pinned by manifest-list digest (2-alpine = caddy v2.11.7, linux/amd64 + linux/arm64).
# Bump deliberately: pull the new tag, copy its digest here, re-run this script.
CADDY_IMAGE="caddy@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f"

# Placeholders only. The token is a non-secret string that satisfies the 32-char guard.
export RELAY_DOMAIN="relay.example.com"
export RELAY_IMAGE="podcast-relay:ci-placeholder"
export PODCAST_RELAY_HOST_TOKENS="ci-placeholder-token-not-a-secret-0123456789"

caddyfiles=()
while IFS= read -r f; do caddyfiles+=("$f"); done < <(find deploy -type f -name 'Caddyfile*' | sort)
composefiles=()
while IFS= read -r f; do composefiles+=("$f"); done < <(find deploy -type f -name 'docker-compose*.yml' | sort)
test "${#caddyfiles[@]}" -gt 0 || { echo "no Caddyfile found under deploy/" >&2; exit 1; }
test "${#composefiles[@]}" -gt 0 || { echo "no compose file found under deploy/" >&2; exit 1; }

echo "==> caddy version (${CADDY_IMAGE})"
docker run --rm "$CADDY_IMAGE" caddy version

for f in "${caddyfiles[@]}"; do
  echo "==> caddy validate ${f}"
  docker run --rm \
    -e RELAY_DOMAIN \
    -v "${ROOT}/${f}:/etc/caddy/Caddyfile:ro" \
    "$CADDY_IMAGE" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
done

for f in "${composefiles[@]}"; do
  echo "==> docker compose config ${f}"
  docker compose -f "$f" config -q
done

echo "==> docker compose config (production + build overlay)"
docker compose -f deploy/relay/docker-compose.prod.yml -f deploy/relay/docker-compose.build.yml config -q

# Production must fail closed: each operator-supplied variable is required, with no default.
for var in RELAY_DOMAIN RELAY_IMAGE PODCAST_RELAY_HOST_TOKENS; do
  echo "==> production compose fails closed without ${var}"
  if err="$(env -u "$var" docker compose -f deploy/relay/docker-compose.prod.yml config -q 2>&1)"; then
    echo "production compose rendered without ${var}" >&2
    exit 1
  fi
  case "$err" in
    *"set ${var}"*) echo "    rejected: ${err}" ;;
    *) echo "production compose failed without ${var}, but not on the required-variable guard:" >&2
       echo "$err" >&2
       exit 1 ;;
  esac
done

echo "deploy config OK"
