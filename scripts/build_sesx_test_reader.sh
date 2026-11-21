#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 1 ]]; then
  printf 'usage: %s BUILD_DIRECTORY\n' "$0" >&2
  exit 2
fi

build_root=$1
source_root="$build_root/source"
reader_commit=18119aba6fe3ea7c9b6528a160cb3d2cc7c8c300
reader_repo=https://github.com/atmosfar/audition_session_to_reaper_project_converter.git

if [[ -e "$build_root" ]]; then
  printf 'refusing to reuse an existing SESX test-reader directory\n' >&2
  exit 2
fi

mkdir -p "$build_root"
git init --quiet "$source_root"
git -C "$source_root" remote add origin "$reader_repo"
git -C "$source_root" fetch --quiet --depth=1 origin "$reader_commit"
git -C "$source_root" checkout --quiet --detach FETCH_HEAD
test "$(git -C "$source_root" rev-parse HEAD)" = "$reader_commit"
python -m pip install --quiet --disable-pip-version-check 'rpp==0.5' >/dev/null
test -f "$source_root/convert_sesx_to_rpp.py"
printf '%s\n' "$source_root/convert_sesx_to_rpp.py"
python -c 'from pathlib import Path; import rpp; print(Path(rpp.__file__).parent.parent)'
