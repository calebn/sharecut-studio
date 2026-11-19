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
for key in sys.argv[2].split("."):
    node = node[key]
print("\n".join(node) if isinstance(node, list) else node)' "$CONTRACT" "$1"
}

if [ "$PLAT" = device ]; then MIN="-miphoneos-version-min=$MINOS"; else MIN="-mios-simulator-version-min=$MINOS"; fi
SYSROOT=$(xcrun --sdk "$SDK" --show-sdk-path)
CLANG=$(xcrun --sdk "$SDK" -f clang)
CC="$CLANG -arch arm64 -isysroot $SYSROOT $MIN"

mkdir -p "$SRC" "$BUILD" "$OUT" "$PREFIX"

FFDIR=$(pin sources.ffmpeg.directory)
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

for name in ffmpeg lame opus; do
  archive=$SRC/$(pin "sources.$name.archive")
  dir=$SRC/$(pin "sources.$name.directory")
  [ -d "$dir" ] || tar -xf "$archive" -C "$SRC"
done

rm -rf "$FFSRC"
cp -R "$SRC/$FFDIR" "$FFSRC"
for patch in $PATCHES; do
  (cd "$FFSRC" && patch -p1 --dry-run --batch --quiet < "$ROOT/$patch" && patch -p1 --batch --quiet < "$ROOT/$patch")
done

MAPS="-ffile-prefix-map=$ROOT=/repo -ffile-prefix-map=$SYSROOT=/sdk -ffile-prefix-map=$SRC=/src -ffile-prefix-map=$FFSRC=/src/$FFDIR -ffile-prefix-map=$BUILD=/build -ffile-prefix-map=$OUT=/out -fdebug-prefix-map=$ROOT=/repo -fdebug-prefix-map=$SRC=/src -fdebug-prefix-map=$FFSRC=/src/$FFDIR -fdebug-prefix-map=$BUILD=/build"
FORCE="-include sc_fftools_stdio.h -include sc_exit_map.h -I$GLUE"
CFLAGS_CONFIGURE="-O2 -fPIC -fvisibility=default $MAPS"
CFLAGS="$CFLAGS_CONFIGURE $FORCE"

if [ ! -f "$PREFIX/lib/libmp3lame.a" ]; then
  rm -rf "$BUILD/lame"; mkdir -p "$BUILD/lame"; cd "$BUILD/lame"
  "$SRC/$(pin sources.lame.directory)/configure" --host=aarch64-apple-darwin --prefix="$PREFIX" $(pin lame_configure) CC="$CC" CFLAGS="$CFLAGS_CONFIGURE" > "$BUILD/lame-configure.log" 2>&1
  # the forced includes go on only after configure: with <stdlib.h> forced in, autoconf's `char strtol(void)` probes fail
  nice -n 10 make -j"$JOBS" CFLAGS="$CFLAGS" > "$BUILD/lame-make.log" 2>&1
  make install > "$BUILD/lame-install.log" 2>&1
fi
if [ ! -f "$PREFIX/lib/libopus.a" ]; then
  rm -rf "$BUILD/opus"; mkdir -p "$BUILD/opus"; cd "$BUILD/opus"
  "$SRC/$(pin sources.opus.directory)/configure" --host=aarch64-apple-darwin --prefix="$PREFIX" $(pin opus_configure) CC="$CC" CFLAGS="$CFLAGS_CONFIGURE" > "$BUILD/opus-configure.log" 2>&1
  # the forced includes go on only after configure: with <stdlib.h> forced in, autoconf's `char strtol(void)` probes fail
  nice -n 10 make -j"$JOBS" CFLAGS="$CFLAGS" > "$BUILD/opus-make.log" 2>&1
  make install > "$BUILD/opus-install.log" 2>&1
fi

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
  $(pin ffmpeg_configure) \
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
  $CC $PLAIN_FLAGS -I. -I"$FFSRC" -c "$1" -o "$WORK/$(basename "$1" .c).o"
}
compile_plain "$GLUE/sc_ffmpeg_core.c"
compile_plain "$GLUE/sc_ffmpeg_glue.c"
compile_tool "$GLUE/sc_ffmpeg_tool.c" -Dmain=sc_ffmpeg_main
compile_tool "$GLUE/sc_ffprobe_tool.c" -Dmain=sc_ffprobe_main -Dprogram_name=ffprobe_program_name -Dprogram_birth_year=ffprobe_program_birth_year -Dshow_help_default=ffprobe_show_help_default

printf '_sc_ffmpeg_abi_version\n_sc_ffmpeg_start\n_sc_ffmpeg_wait\n_sc_ffmpeg_cancel\n' > "$WORK/exports.txt"
FW=$OUT/FFmpeg.framework
rm -rf "$FW"; mkdir -p "$FW"
$CC -dynamiclib -o "$FW/FFmpeg" -install_name @rpath/FFmpeg.framework/FFmpeg -compatibility_version 1 -current_version "$(pin version)" \
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
<key>CFBundleShortVersionString</key><string>$(pin version)</string>
<key>CFBundleVersion</key><string>$(pin version)</string>
<key>MinimumOSVersion</key><string>$MINOS</string>
<key>CFBundleSupportedPlatforms</key><array><string>$PLATFORM_NAME</string></array>
</dict></plist>
PLIST

echo "built $PLAT: $FW ($(stat -f %z "$FW/FFmpeg") bytes)"
