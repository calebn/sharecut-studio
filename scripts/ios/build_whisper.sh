#!/bin/bash
# Build Whisper.framework (arm64 device or arm64 Simulator) from the pins in contracts/whisper-build.json. usage: build_whisper.sh <device|sim|host>
# host builds the same sources and glue with the host cc and c++ into libsc_whisper.so (libsc_whisper.dylib on a Mac); it is the Linux proof, not shipped.
set -euo pipefail

PLAT=${1:-}
case "$PLAT" in
  device) SDK=iphoneos; PLATFORM_NAME=iPhoneOS ;;
  sim) SDK=iphonesimulator; PLATFORM_NAME=iPhoneSimulator ;;
  host) ;;
  *) echo "usage: $0 <device|sim|host>" >&2; exit 2 ;;
esac
if [ "$PLAT" != host ]; then
  export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  command -v xcrun >/dev/null || { echo "xcrun not found: this build needs Xcode and the $PLATFORM_NAME SDK" >&2; exit 1; }
fi
command -v cmake >/dev/null || { echo "cmake not found" >&2; exit 1; }

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CONTRACT=$ROOT/contracts/whisper-build.json
GLUE=$ROOT/gui/desktop/src-tauri/ios/whisper
BASE=${SC_WHISPER_WORKDIR:-$ROOT/gui/desktop/src-tauri/ios-whisper}
SRC=$BASE/src
BUILD=$BASE/build/$PLAT
OUT=$BASE/out/$PLAT
WSRC=$BUILD/whisper-src
WORK=$BUILD/glue
MINOS=$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["minos"])' "$CONTRACT")
JOBS=${SC_WHISPER_JOBS:-$(getconf _NPROCESSORS_ONLN)}

export LC_ALL=C TZ=UTC ZERO_AR_DATE=1

pin() {
  python3 -I -c 'import json, sys
node = json.load(open(sys.argv[1]))
for key in sys.argv[2].split("."):
    node = node[key]
print("\n".join(node) if isinstance(node, list) else node)' "$CONTRACT" "$1"
}

if [ "$PLAT" = host ]; then
  CC="${SC_WHISPER_CC:-cc}"
  CXX="${SC_WHISPER_CXX:-c++}"
  SYSROOT=/
  LIB_DEFS="-D_GNU_SOURCE"
  CMAKE_PLAT=()
else
  if [ "$PLAT" = device ]; then MIN="-miphoneos-version-min=$MINOS"; else MIN="-mios-simulator-version-min=$MINOS"; fi
  SYSROOT=$(xcrun --sdk "$SDK" --show-sdk-path)
  CC="$(xcrun --sdk "$SDK" -f clang) -arch arm64 -isysroot $SYSROOT $MIN"
  CXX="$(xcrun --sdk "$SDK" -f clang++) -arch arm64 -isysroot $SYSROOT $MIN"
  LIB_DEFS=""
  CMAKE_PLAT=(-DCMAKE_SYSTEM_NAME=iOS "-DCMAKE_OSX_SYSROOT=$SDK" -DCMAKE_OSX_ARCHITECTURES=arm64 "-DCMAKE_OSX_DEPLOYMENT_TARGET=$MINOS")
fi

mkdir -p "$SRC" "$BUILD" "$OUT"

WDIR=$(pin sources.whisper.directory)
PATCHES=$(python3 -I - "$CONTRACT" "$SRC" "$ROOT" "${SC_WHISPER_SOURCE_TARBALL:-}" <<'PY'
import hashlib, json, shutil, subprocess, sys
from pathlib import Path

contract = json.load(open(sys.argv[1]))
src = Path(sys.argv[2])
root = Path(sys.argv[3])
local = sys.argv[4]


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


pinned = contract["sources"]["whisper"]
archive = src / pinned["archive"]
if not archive.is_file():
    if local:
        shutil.copyfile(local, str(archive) + ".part")
    else:
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

# a fresh extraction every run, so a stale or edited tree is never built after the pin changes
rm -rf "$SRC/$WDIR" "$WSRC"
tar -xf "$SRC/$(pin sources.whisper.archive)" -C "$SRC"
cp -Rp "$SRC/$WDIR" "$WSRC"
for patch in $PATCHES; do
  (cd "$WSRC" && patch -p1 --fuzz=0 --dry-run --batch --quiet < "$ROOT/$patch" && patch -p1 --fuzz=0 --batch --quiet < "$ROOT/$patch")
done

MAPS="-ffile-prefix-map=$ROOT=/repo -ffile-prefix-map=$SYSROOT=/sdk -ffile-prefix-map=$SRC=/src -ffile-prefix-map=$WSRC=/src/$WDIR -ffile-prefix-map=$BUILD=/build -ffile-prefix-map=$OUT=/out -fdebug-prefix-map=$ROOT=/repo -fdebug-prefix-map=$WSRC=/src/$WDIR"
VIS="-fvisibility=hidden -ffunction-sections -fdata-sections"
FORCE="-include sc_whisper_exit_map.h -I$GLUE"

# the forced exit map goes on the library build only: CMake's own probes would not link against sc_tool_exit
# a fresh build tree every run, so a stale .a is never linked
rm -rf "$BUILD/cmake"
mkdir -p "$BUILD/cmake"
cmake -S "$WSRC" -B "$BUILD/cmake" ${CMAKE_PLAT[@]+"${CMAKE_PLAT[@]}"} $(pin cmake_configure) \
  "-DCMAKE_C_COMPILER=${CC%% *}" "-DCMAKE_CXX_COMPILER=${CXX%% *}" \
  "-DCMAKE_C_FLAGS=-fPIC $LIB_DEFS $VIS $MAPS $FORCE" "-DCMAKE_CXX_FLAGS=-fPIC $LIB_DEFS $VIS -fvisibility-inlines-hidden $MAPS $FORCE" \
  > "$BUILD/cmake-configure.log" 2>&1
nice -n 10 cmake --build "$BUILD/cmake" --target whisper -j "$JOBS" > "$BUILD/cmake-build.log" 2>&1
LIBS=$(find "$BUILD/cmake" -name 'lib*.a' | LC_ALL=C sort)

rm -rf "$WORK"; mkdir -p "$WORK"
INC="-I$GLUE -I$WSRC/include -I$WSRC/ggml/include -I$WSRC/examples -I$WSRC/examples/cli"
CXXF="-std=c++17 -O2 -fPIC $LIB_DEFS $VIS -fvisibility-inlines-hidden $MAPS -DMA_NO_RUNTIME_LINKING"
OBJS=()
compile_plain() {
  $CC -std=c11 -O2 -fPIC $VIS $MAPS -c "$1" -o "$WORK/$(basename "$1").o"
  OBJS+=("$WORK/$(basename "$1").o")
}
compile_glue() {
  $CXX $CXXF $INC -c "$1" -o "$WORK/$(basename "$1").o"
  OBJS+=("$WORK/$(basename "$1").o")
}
# -DNDEBUG on the cli sources: a failing assert there (stb_vorbis, miniaudio) would call libSystem abort() and end the app
compile_tool() {
  $CXX $CXXF $INC -DNDEBUG -include sc_whisper_stdio.h -include sc_whisper_exit_map.h "${@:2}" -c "$1" -o "$WORK/$(basename "$1").o"
  OBJS+=("$WORK/$(basename "$1").o")
}
compile_plain "$GLUE/sc_whisper_core.c"
compile_glue "$GLUE/sc_whisper_glue.cpp"
compile_tool "$GLUE/sc_whisper_cli.cpp" -Dmain=sc_whisper_cli_main
for source in $(pin cli_sources); do compile_tool "$WSRC/$source"; done

exports_check() {
  local listed
  listed=$("$@" | awk '{print $NF}' | sed 's/^_//' | grep '^sc_' | LC_ALL=C sort | tr '\n' ' ')
  local expected
  expected=$(pin exports | LC_ALL=C sort | tr '\n' ' ')
  [ "$listed" = "$expected" ] || { echo "exported sc_ symbols are: $listed; expected: $expected" >&2; exit 1; }
}

pin exports | sed 's/^/_/' > "$WORK/exports.txt"
if [ "$PLAT" = host ]; then
  pin exports | sed 's/^/  /; s/$/;/' | { echo "{ global:"; cat; echo "local: *; };"; } > "$WORK/exports.map"
  case "$(uname -s)" in
    Darwin) LIBFILE=libsc_whisper.dylib ;;
    *) LIBFILE=libsc_whisper.so ;;
  esac
  rm -f "$OUT/$LIBFILE"
  if [ "$(uname -s)" = Darwin ]; then
    $CXX -dynamiclib -o "$OUT/$LIBFILE" -exported_symbols_list "$WORK/exports.txt" -Wl,-dead_strip "${OBJS[@]}" $LIBS -framework Accelerate -lc++ -lm > "$BUILD/link.log" 2>&1
    exports_check nm -gU "$OUT/$LIBFILE"
  else
    $CXX -shared -o "$OUT/$LIBFILE" -Wl,--version-script="$WORK/exports.map" -Wl,--gc-sections "${OBJS[@]}" -Wl,--start-group $LIBS -Wl,--end-group -lpthread -lm -ldl > "$BUILD/link.log" 2>&1
    exports_check nm -D --defined-only "$OUT/$LIBFILE"
  fi
  echo "built host: $OUT/$LIBFILE"
  exit 0
fi

FW=$OUT/Whisper.framework
rm -rf "$FW"; mkdir -p "$FW"
$CXX -dynamiclib -o "$FW/Whisper" -install_name @rpath/Whisper.framework/Whisper -compatibility_version 1 -current_version "$(pin version)" \
  -exported_symbols_list "$WORK/exports.txt" -Wl,-dead_strip -Wl,-x \
  "${OBJS[@]}" $LIBS -framework Accelerate -lc++ -lm > "$BUILD/framework-link.log" 2>&1
exports_check xcrun --sdk "$SDK" nm -gU "$FW/Whisper"

cat > "$FW/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>studio.sharecut.whisper</string>
<key>CFBundleName</key><string>Whisper</string>
<key>CFBundleExecutable</key><string>Whisper</string>
<key>CFBundlePackageType</key><string>FMWK</string>
<key>CFBundleShortVersionString</key><string>$(pin version)</string>
<key>CFBundleVersion</key><string>$(pin version)</string>
<key>MinimumOSVersion</key><string>$MINOS</string>
<key>CFBundleSupportedPlatforms</key><array><string>$PLATFORM_NAME</string></array>
</dict></plist>
PLIST

echo "built $PLAT: $FW ($(stat -f %z "$FW/Whisper") bytes)"
