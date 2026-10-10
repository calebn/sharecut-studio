#!/usr/bin/env bash
# Build the unsigned Linux AppImage inside Ubuntu 22.04 (GHA-shaped).
# Does not dispatch GitHub Actions. Re-run until linuxdeploy succeeds, then
# workflow_dispatch release-desktop for the amd64 artifact testers download.
set -euo pipefail

CALLER_DIR="$PWD"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${SHARECUT_LINUX_APPIMAGE_IMAGE:-sharecut-linux-amd64-appimage:local}"
DOCKERFILE="$ROOT/gui/desktop/Dockerfile.linux-appimage"
BASE_IMAGE="${SHARECUT_LINUX_BASE_IMAGE:-}"
CACHE="${TMPDIR:-/tmp}/sharecut-linux-amd64-rootfs"
PLATFORM="linux/amd64"
UBUNTU_BASE_URL="https://cdimage.ubuntu.com/ubuntu-base/releases/22.04/release/ubuntu-base-22.04.5-base-amd64.tar.gz"

PROFILE_ENV_ARGS=()
PROFILE_MOUNT_ARGS=()
if [[ -n "${PODCAST_DISTRIBUTION_PROFILE:-}" ]]; then
  DIST_PROFILE="$PODCAST_DISTRIBUTION_PROFILE"
  if [[ "$DIST_PROFILE" != /* ]]; then
    DIST_PROFILE="$CALLER_DIR/$DIST_PROFILE"
  fi
  if [[ ! -f "$DIST_PROFILE" ]]; then
    echo "error: distribution profile not found: $DIST_PROFILE" >&2
    exit 1
  fi
  DIST_PROFILE="$(cd "$(dirname "$DIST_PROFILE")" && pwd -P)/$(basename "$DIST_PROFILE")"
  case "$DIST_PROFILE" in
    "$ROOT"/*)
      CONTAINER_DIST_PROFILE="/src/${DIST_PROFILE#"$ROOT"/}"
      ;;
    *)
      CONTAINER_DIST_PROFILE="/run/sharecut/distribution.json"
      PROFILE_MOUNT_ARGS=(-v "$DIST_PROFILE:$CONTAINER_DIST_PROFILE:ro")
      ;;
  esac
  PROFILE_ENV_ARGS=(-e "PODCAST_DISTRIBUTION_PROFILE=$CONTAINER_DIST_PROFILE")
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker not found" >&2
  exit 1
fi

image_is_amd64() {
  [[ "$(docker image inspect --format '{{.Architecture}}' "$1" 2>/dev/null)" == amd64 ]]
}

ensure_base_image() {
  if [[ -n "$BASE_IMAGE" ]]; then
    if ! image_is_amd64 "$BASE_IMAGE"; then
      echo "error: base image must be amd64: $BASE_IMAGE" >&2
      exit 1
    fi
    return 0
  fi
  if image_is_amd64 ubuntu:22.04; then
    BASE_IMAGE="ubuntu:22.04"
    return 0
  fi
  # Docker Hub metadata/layer pulls often hang on this Mac; Ubuntu archive curl works.
  if docker image inspect sharecut-ubuntu-amd64:22.04 >/dev/null 2>&1; then
    if ! image_is_amd64 sharecut-ubuntu-amd64:22.04; then
      echo "error: cached base image must be amd64: sharecut-ubuntu-amd64:22.04" >&2
      exit 1
    fi
  else
    echo "==> import Ubuntu 22.04 rootfs (Docker Hub pull skipped)"
    mkdir -p "$CACHE"
    tarball="$CACHE/ubuntu-base-22.04.5-base-amd64.tar.gz"
    if [[ ! -s "$tarball" ]]; then
      curl -fL --retry 3 --retry-delay 2 -o "${tarball}.partial" "$UBUNTU_BASE_URL"
      mv -f "${tarball}.partial" "$tarball"
    fi
    docker import --platform "$PLATFORM" "$tarball" sharecut-ubuntu-amd64:22.04
  fi
  BASE_IMAGE="sharecut-ubuntu-amd64:22.04"
}

ensure_base_image
if [[ "${SHARECUT_LINUX_REBUILD_IMAGE:-}" == "1" ]] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "==> docker build $IMAGE (FROM $BASE_IMAGE)"
  docker build --platform "$PLATFORM" --build-arg "BASE_IMAGE=$BASE_IMAGE" -f "$DOCKERFILE" -t "$IMAGE" "$ROOT/gui/desktop"
else
  if ! image_is_amd64 "$IMAGE"; then
    echo "error: cached AppImage image must be amd64: $IMAGE" >&2
    exit 1
  fi
  echo "==> reuse image $IMAGE (set SHARECUT_LINUX_REBUILD_IMAGE=1 to rebuild)"
fi

mkdir -p "$ROOT/gui/desktop/dist-linux"
DEB_DIR="${TMPDIR:-/tmp}/sharecut-linux-amd64-debs"
mkdir -p "$DEB_DIR"

# Architecture: all. Pin SHA-256; GHA uses apt-get instead of these debs.
download_pinned_deb() {
  local dest="$1" url="$2" sha="$3"
  if [[ -s "$dest" ]] && echo "${sha}  ${dest}" | shasum -a 256 -c - >/dev/null 2>&1; then
    return 0
  fi
  echo "==> download $(basename "$dest")"
  curl -fL --retry 3 -o "${dest}.partial" "$url"
  echo "${sha}  ${dest}.partial" | shasum -a 256 -c -
  mv -f "${dest}.partial" "$dest"
}

download_pinned_deb "$DEB_DIR/xdg-utils_all.deb" \
  "https://archive.ubuntu.com/ubuntu/pool/main/x/xdg-utils/xdg-utils_1.1.3-4.1ubuntu3_all.deb" \
  "499ad8b146f8d6f092ada8f878e7c6d93239caf29ce92c1381fe94e314169986"
download_pinned_deb "$DEB_DIR/sensible-utils_all.deb" \
  "https://archive.ubuntu.com/ubuntu/pool/main/s/sensible-utils/sensible-utils_0.0.17_all.deb" \
  "68fa82f5a319ffe48f51ea874117be3d6781c5f6b2ac4f172485fa690ebde4a3"

echo "==> docker run AppImage (Linux volumes for sidecar + cargo; Mac FS is case-insensitive)"
docker run --platform "$PLATFORM" --rm \
  -e APPIMAGE_EXTRACT_AND_RUN=1 \
  -e NO_STRIP=true \
  -e REBUILD_SIDECAR="${REBUILD_SIDECAR:-}" \
  -e SHARECUT_SIDECAR_OUT=/src/gui/desktop/binaries \
  -e CARGO_TARGET_DIR=/cargo-target \
  -e SHARECUT_APPIMAGE_OUT=/out \
  ${PROFILE_ENV_ARGS[@]+"${PROFILE_ENV_ARGS[@]}"} \
  -v "$ROOT:/src" \
  ${PROFILE_MOUNT_ARGS[@]+"${PROFILE_MOUNT_ARGS[@]}"} \
  -v "$ROOT/gui/desktop/dist-linux:/out" \
  -v "$DEB_DIR:/opt/sharecut-debs:ro" \
  -v sharecut-linux-amd64-sidecar:/src/gui/desktop/binaries \
  -v sharecut-linux-amd64-cargo-registry:/root/.cargo/registry \
  -v sharecut-linux-amd64-cargo-git:/root/.cargo/git \
  -v sharecut-linux-amd64-cargo-target:/cargo-target \
  -v sharecut-linux-amd64-uv:/root/.cache/uv \
  -v sharecut-linux-amd64-npm:/root/.npm \
  -v sharecut-linux-amd64-desktop-node-modules:/src/gui/desktop/node_modules \
  -w /src \
  "$IMAGE" \
  ./scripts/build_linux_appimage.sh
