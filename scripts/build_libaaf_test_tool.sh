#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 1 ]]; then
  printf 'usage: %s BUILD_DIRECTORY\n' "$0" >&2
  exit 2
fi

build_root=$1
source_root="$build_root/source"
libaaf_commit=9ff583a36fbc37eef553482446b02aa21ccb1457

if [[ -e "$source_root" || -e "$build_root/build" ]]; then
  printf 'refusing to reuse an existing LibAAF test-tool directory\n' >&2
  exit 2
fi

mkdir -p "$build_root"
git init --quiet "$source_root"
git -C "$source_root" remote add origin https://github.com/agfline/LibAAF.git
git -C "$source_root" fetch --quiet --depth=1 origin "$libaaf_commit"
git -C "$source_root" checkout --quiet --detach FETCH_HEAD
test "$(git -C "$source_root" rev-parse HEAD)" = "$libaaf_commit"

cmake -S "$source_root" -B "$build_root/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS="-include limits.h"
cmake --build "$build_root/build" --target aaftool --parallel 2
test -x "$build_root/build/bin/aaftool"
printf '%s\n' "$build_root/build/bin/aaftool"
