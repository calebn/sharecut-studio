#!/bin/bash
# Build FFmpeg.framework (arm64 device or arm64 Simulator) from the pins in contracts/ffmpeg-build.json. usage: build_ffmpeg.sh <device|sim>
set -euo pipefail

PLAT=${1:-}
case "$PLAT" in
  device) SDK=iphoneos; PLATFORM_NAME=iPhoneOS ;;
  sim) SDK=iphonesimulator; PLATFORM_NAME=iPhoneSimulator ;;
  *) echo "usage: $0 <device|sim>" >&2; exit 2 ;;
esac
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
command -v xcrun >/dev/null || { echo "xcrun not found: this build needs Xcode and the $PLATFORM_NAME SDK" >&2; exit 1; }

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CONTRACT=$ROOT/contracts/ffmpeg-build.json
GLUE=$ROOT/gui/desktop/src-tauri/ios/ffmpeg
BASE=$ROOT/gui/desktop/src-tauri/ios-ffmpeg
SRC=$BASE/src
BUILD=$BASE/build/$PLAT
OUT=$BASE/out/$PLAT
PREFIX=$BUILD/prefix
FFSRC=$BUILD/ffmpeg-src
WORK=$BUILD/framework
MINOS=17.0
JOBS=${SC_FFMPEG_JOBS:-$(sysctl -n hw.ncpu)}

export LC_ALL=C TZ=UTC ZERO_AR_DATE=1

pin() {
  python3 -I -c 'import json, sys
node = json.load(open(sys.argv[1]))
field = sys.argv[2]
for key in field.split("."):
    if not isinstance(node, dict) or key not in node:
        sys.exit(f"Missing FFmpeg build pin: {field}")
    node = node[key]
if field.endswith("_configure") and not (
    isinstance(node, list) and node and all(
        isinstance(flag, str) and flag.startswith("--")
        and not any(char in flag for char in "\r\n\0")
        for flag in node
    )
):
    sys.exit(f"FFmpeg build pin {field} must be a nonempty list of configure options")
print("\n".join(node) if isinstance(node, list) else node)' "$CONTRACT" "$1"
}

VERSION=$(pin version)
FFDIR=$(pin sources.ffmpeg.directory)
LAME_DIR=$(pin sources.lame.directory)
OPUS_DIR=$(pin sources.opus.directory)
LAME_CONFIGURE=$(pin lame_configure)
OPUS_CONFIGURE=$(pin opus_configure)
FFMPEG_CONFIGURE=$(pin ffmpeg_configure)
IOS_CONFIGURE=$(pin ios_ffmpeg_configure)

# Bash 3.2 read needs a NUL terminator to keep all lines in one array.
IFS=$'\n' read -r -d '' -a LAME_FLAGS < <(printf '%s\0' "$LAME_CONFIGURE")
IFS=$'\n' read -r -d '' -a OPUS_FLAGS < <(printf '%s\0' "$OPUS_CONFIGURE")
IFS=$'\n' read -r -d '' -a FFMPEG_FLAGS < <(printf '%s\0' "$FFMPEG_CONFIGURE")
IFS=$'\n' read -r -d '' -a IOS_FLAGS < <(printf '%s\0' "$IOS_CONFIGURE")

if [ "$PLAT" = device ]; then MIN="-miphoneos-version-min=$MINOS"; else MIN="-mios-simulator-version-min=$MINOS"; fi
SYSROOT=$(xcrun --sdk "$SDK" --show-sdk-path)
CLANG=$(xcrun --sdk "$SDK" -f clang)
CC="$CLANG -arch arm64 -isysroot $SYSROOT $MIN"

mkdir -p "$SRC" "$BUILD" "$OUT" "$PREFIX"

PATCHES=$(python3 -I - "$CONTRACT" "$SRC" "$ROOT" <<'PY'
import hashlib, json, subprocess, sys
from pathlib import Path

contract = json.load(open(sys.argv[1]))
src = Path(sys.argv[2])
root = Path(sys.argv[3])


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


for name in ("ffmpeg", "lame", "opus"):
    pinned = contract["sources"][name]
    archive = src / pinned["archive"]
    if not archive.is_file():
        subprocess.run(
            ["curl", "--fail", "--silent", "--show-error", "--location", "--proto", "=https",
             "--max-time", "600", "-o", str(archive) + ".part", pinned["url"]],
            check=True,
        )
        Path(str(archive) + ".part").rename(archive)
    if sha256(archive) != pinned["sha256"]:
        archive.unlink()
        sys.exit("sha256 mismatch for %s; the download was removed" % pinned["archive"])
for patch in contract["patches"]:
    if sha256(root / patch["path"]) != patch["sha256"]:
        sys.exit("sha256 mismatch for patch %s" % patch["name"])
    print(patch["path"])
PY
)

for dir in "$FFDIR" "$LAME_DIR" "$OPUS_DIR"; do
  case "$dir" in
    ""|.|..|*/*) echo "invalid source directory pin: '$dir'" >&2; exit 1 ;;
  esac
done

EXTRACT=$(mktemp -d "$SRC/.extract.XXXXXX")
trap 'rm -rf "$EXTRACT"' EXIT
for name in ffmpeg lame opus; do
  archive=$SRC/$(pin "sources.$name.archive")
  dir=$(pin "sources.$name.directory")
  tar -xf "$archive" -C "$EXTRACT"
  [ -d "$EXTRACT/$dir" ] || { echo "$archive does not contain $dir" >&2; exit 1; }
  rm -rf "${SRC:?}/$dir"
  mv "$EXTRACT/$dir" "$SRC/$dir"
done

rm -rf "$FFSRC"
cp -R "$SRC/$FFDIR" "$FFSRC"
for patch in $PATCHES; do
  (cd "$FFSRC" && patch -p1 --dry-run --batch --quiet < "$ROOT/$patch" && patch -p1 --batch --quiet < "$ROOT/$patch")
done

MAPS="-ffile-prefix-map=$ROOT=/repo -ffile-prefix-map=$SYSROOT=/sdk -ffile-prefix-map=$SRC=/src -ffile-prefix-map=$FFSRC=/src/$FFDIR -ffile-prefix-map=$BUILD=/build -ffile-prefix-map=$OUT=/out -fdebug-prefix-map=$ROOT=/repo -fdebug-prefix-map=$SRC=/src -fdebug-prefix-map=$FFSRC=/src/$FFDIR -fdebug-prefix-map=$BUILD=/build"
FORCE="-include sc_fftools_stdio.h -include sc_exit_map.h -I$GLUE"
OPT_FLAGS="-O2 -fPIC -fvisibility=default"
CFLAGS_CONFIGURE="$OPT_FLAGS $MAPS"
CFLAGS="$CFLAGS_CONFIGURE $FORCE"

# digest <text or @file>...: sha256 over the arguments; an argument starting with @ contributes that file's bytes.
digest() {
  python3 -I -c 'import hashlib, sys
h = hashlib.sha256()
for arg in sys.argv[1:]:
    if arg.startswith("@"):
        h.update(b"file:" + open(arg[1:], "rb").read())
    else:
        h.update(b"text:" + arg.encode())
    h.update(b"\0")
print(h.hexdigest())' "$@"
}

TOOLCHAIN=$("$CLANG" --version 2>&1 | head -n 1 || true)
TOOLCHAIN="$TOOLCHAIN $(xcrun --sdk "$SDK" --show-sdk-version 2>/dev/null || true) $(xcrun --sdk "$SDK" --show-sdk-build-version 2>/dev/null || true)"
FORCE_HEADERS=("@$GLUE/sc_fftools_stdio.h" "@$GLUE/sc_exit_map.h")

# build_dep <name> <source dir> <library> <flag>...: configure, build and install one static dependency into
# $PREFIX, unless $PREFIX/.stamp-<name> already holds the digest of this build's inputs (pins, flags, compiler, forced headers).
build_dep() {
  local name=$1 dir=$2 lib=$3
  shift 3
  local stamp
  stamp=$(digest "$name" "$(pin "sources.$name.sha256")" "$TOOLCHAIN" "$CC" "$CFLAGS" "$@" "${FORCE_HEADERS[@]}")
  if [ -f "$PREFIX/lib/$lib" ] && [ "$(cat "$PREFIX/.stamp-$name" 2>/dev/null)" = "$stamp" ]; then
    echo "$name: reusing $PREFIX/lib/$lib (inputs ${stamp:0:12})"
    return 0
  fi
  echo "$name: building (inputs ${stamp:0:12})"
  rm -f "$PREFIX/.stamp-$name" "$PREFIX/lib/$lib"
  rm -rf "$BUILD/$name"; mkdir -p "$BUILD/$name"; cd "$BUILD/$name"
  "$SRC/$dir/configure" --host=aarch64-apple-darwin --prefix="$PREFIX" "$@" CC="$CC" CFLAGS="$CFLAGS_CONFIGURE" > "$BUILD/$name-configure.log" 2>&1
  # the forced includes go on only after configure: with <stdlib.h> forced in, autoconf's `char strtol(void)` probes fail
  nice -n 10 make -j"$JOBS" CFLAGS="$CFLAGS" > "$BUILD/$name-make.log" 2>&1
  make install > "$BUILD/$name-install.log" 2>&1
  echo "$stamp" > "$PREFIX/.stamp-$name"
}
build_dep lame "$LAME_DIR" libmp3lame.a "${LAME_FLAGS[@]}"
build_dep opus "$OPUS_DIR" libopus.a "${OPUS_FLAGS[@]}"

# lame and opus were built with the exit/stdio forced includes, so their archives reference sc_tool_exit and
# sc_err; configure's link probes for them need a provider. The real ones come from the core at framework link.
cat > "$BUILD/cfg_stub.c" <<'STUB'
#include <stdio.h>
#include <stdlib.h>
FILE *sc_err(void) { return stderr; }
void sc_tool_exit(int code) { _Exit(code); }
STUB
$CC -c "$BUILD/cfg_stub.c" -o "$BUILD/cfg_stub.o"

rm -rf "$BUILD/ffmpeg"; mkdir -p "$BUILD/ffmpeg"; cd "$BUILD/ffmpeg"
export PKG_CONFIG_PATH=$PREFIX/lib/pkgconfig PKG_CONFIG_LIBDIR=$PREFIX/lib/pkgconfig
"$FFSRC/configure" --prefix="$PREFIX" --enable-cross-compile --target-os=darwin --arch=arm64 \
  --cc="$CC" --as="$CC" --ld="$CC" --pkg-config=pkg-config --enable-pic \
  "${FFMPEG_FLAGS[@]}" "${IOS_FLAGS[@]}" \
  --extra-cflags="-I$PREFIX/include $MIN $MAPS" --extra-ldflags="-L$PREFIX/lib $MIN" --extra-libs="$BUILD/cfg_stub.o" > "$BUILD/ffmpeg-configure.log" 2>&1
# configure's probes declare `extern int fn();`, which the real prototypes from the forced <stdlib.h> contradict: add the forced includes to the build only
printf 'CFLAGS+= %s\n' "$FORCE" >> ffbuild/config.mak
SC_ROOT=$ROOT SC_SYSROOT=$SYSROOT SC_CLANG=$CLANG perl -pi -e 's#\Q$ENV{SC_ROOT}\E#REPO#g; s#\Q$ENV{SC_SYSROOT}\E#SDK#g; s#\Q$ENV{SC_CLANG}\E#clang#g' config.h

LIBS="libavdevice libavfilter libavformat libavcodec libswresample libswscale libavutil"
TOOL_OBJS="fftools/cmdutils.o fftools/ffmpeg_dec.o fftools/ffmpeg_demux.o fftools/ffmpeg_enc.o fftools/ffmpeg_filter.o fftools/ffmpeg_hw.o fftools/ffmpeg_mux.o fftools/ffmpeg_mux_init.o fftools/ffmpeg_opt.o fftools/ffmpeg_sched.o fftools/opt_common.o fftools/sync_queue.o fftools/thread_queue.o fftools/graph/graphprint.o fftools/resources/graph.css.o fftools/resources/graph.html.o fftools/resources/resman.o fftools/textformat/avtextformat.o fftools/textformat/tf_compact.o fftools/textformat/tf_default.o fftools/textformat/tf_flat.o fftools/textformat/tf_ini.o fftools/textformat/tf_json.o fftools/textformat/tf_mermaid.o fftools/textformat/tf_xml.o fftools/textformat/tw_avio.o fftools/textformat/tw_buffer.o fftools/textformat/tw_stdout.o"
LIB_ARCHIVES=""
for lib in $LIBS; do LIB_ARCHIVES="$LIB_ARCHIVES $lib/$lib.a"; done
nice -n 10 make -j"$JOBS" $LIB_ARCHIVES $TOOL_OBJS > "$BUILD/ffmpeg-make.log" 2>&1

rm -rf "$WORK"; mkdir -p "$WORK"
TOOL_FLAGS=$(printf 'print:\n\t@echo $(CPPFLAGS) $(CFLAGS)\n' | make -s -f ffbuild/config.mak -f - print)
PLAIN_FLAGS=${TOOL_FLAGS//-include sc_fftools_stdio.h/}
PLAIN_FLAGS=${PLAIN_FLAGS//-include sc_exit_map.h/}
compile_tool() {
  $CC $TOOL_FLAGS -I. -I"$FFSRC" -Wno-missing-prototypes "${@:2}" -c "$1" -o "$WORK/$(basename "$1" .c).o"
}
compile_plain() {
  $CC $PLAIN_FLAGS -I. -I"$FFSRC" "${@:2}" -c "$1" -o "$WORK/$(basename "$1" .c).o"
}
# The build id: the FFmpeg release and the first 16 hex of a digest of what decides the binary: the script, the glue,
# the pinned archives, patches and configure options, the platform and the toolchain. Anything uncomputable gives "unknown".
BUILD_INPUTS=("$PLAT" "$MINOS" "$TOOLCHAIN" "$OPT_FLAGS" "$(pin sources.ffmpeg.sha256)" "$(pin sources.lame.sha256)" "$(pin sources.opus.sha256)" "$LAME_DIR" "$OPUS_DIR" "$LAME_CONFIGURE" "$OPUS_CONFIGURE" "$FFMPEG_CONFIGURE" "$IOS_CONFIGURE" "@$ROOT/scripts/ios/build_ffmpeg.sh")
for patch in $PATCHES; do BUILD_INPUTS+=("@$ROOT/$patch"); done
for source in sc_ffmpeg_core.c sc_ffmpeg_core.h sc_ffmpeg_glue.c sc_ffmpeg_tool.c sc_ffprobe_tool.c sc_fftools_stdio.h sc_exit_map.h; do
  BUILD_INPUTS+=("@$GLUE/$source")
done
BUILD_INPUTS+=("@$GLUE/../native/sc_session_core.inc")
BUILD_ID=unknown
if BUILD_DIGEST=$(digest "${BUILD_INPUTS[@]}") && [[ $VERSION+${BUILD_DIGEST:0:16} =~ ^[A-Za-z0-9._+-]{1,128}$ ]]; then
  BUILD_ID=$VERSION+${BUILD_DIGEST:0:16}
fi
echo "build id: $BUILD_ID"
compile_plain "$GLUE/sc_ffmpeg_core.c" "-DSC_BUILD_ID=\"$BUILD_ID\""
compile_plain "$GLUE/sc_ffmpeg_glue.c"
compile_tool "$GLUE/sc_ffmpeg_tool.c" -Dmain=sc_ffmpeg_main
compile_tool "$GLUE/sc_ffprobe_tool.c" -Dmain=sc_ffprobe_main -Dprogram_name=ffprobe_program_name -Dprogram_birth_year=ffprobe_program_birth_year -Dshow_help_default=ffprobe_show_help_default

printf '_sc_ffmpeg_abi_version\n_sc_ffmpeg_build_id\n_sc_ffmpeg_start\n_sc_ffmpeg_wait\n_sc_ffmpeg_cancel\n' > "$WORK/exports.txt"
FW=$OUT/FFmpeg.framework
rm -rf "$FW"; mkdir -p "$FW"
$CC -dynamiclib -o "$FW/FFmpeg" -install_name @rpath/FFmpeg.framework/FFmpeg -compatibility_version 1 -current_version "$VERSION" \
  -exported_symbols_list "$WORK/exports.txt" -Wl,-dead_strip -Wl,-x \
  "$WORK/sc_ffmpeg_core.o" "$WORK/sc_ffmpeg_glue.o" "$WORK/sc_ffmpeg_tool.o" "$WORK/sc_ffprobe_tool.o" $TOOL_OBJS $LIB_ARCHIVES \
  "$PREFIX/lib/libmp3lame.a" "$PREFIX/lib/libopus.a" -lz -lm -liconv > "$BUILD/framework-link.log" 2>&1

cat > "$FW/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>studio.sharecut.ffmpeg</string>
<key>CFBundleName</key><string>FFmpeg</string>
<key>CFBundleExecutable</key><string>FFmpeg</string>
<key>CFBundlePackageType</key><string>FMWK</string>
<key>CFBundleShortVersionString</key><string>$VERSION</string>
<key>CFBundleVersion</key><string>$VERSION</string>
<key>MinimumOSVersion</key><string>$MINOS</string>
<key>CFBundleSupportedPlatforms</key><array><string>$PLATFORM_NAME</string></array>
</dict></plist>
PLIST

echo "built $PLAT: $FW ($(stat -f %z "$FW/FFmpeg") bytes)"
