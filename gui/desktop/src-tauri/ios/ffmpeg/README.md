# FFmpeg inside the iOS app

This directory holds the C that turns FFmpeg 9.0.2 into `FFmpeg.framework`, the dynamic framework the iOS app embeds so that audio work runs in the app process. iOS cannot spawn a child process, so the Python side calls four exported functions (`sc_ffmpeg_abi_version`, `sc_ffmpeg_start`, `sc_ffmpeg_wait`, `sc_ffmpeg_cancel`) instead of running `ffmpeg` and `ffprobe`. The ABI is described in `docs/desktop-packaging.md`.

## Files

- `sc_ffmpeg_core.h`, `sc_ffmpeg_core.c`: the portable session core: worker thread, queue, descriptor ownership, argv policy, the exit path. It builds and is tested on Linux (`tests/test_ios_ffmpeg_shim.py`) against a fake glue.
- `sc_ffmpeg_glue.c`: the FFmpeg side of the core (`sc_glue_run`, `sc_glue_reset`, `sc_glue_interrupt`) and the `av_log` callback that writes to the session's error stream.
- `sc_ffmpeg_tool.c`, `sc_ffprobe_tool.c`: wrapper translation units. Each includes `fftools/ffmpeg.c` or `fftools/ffprobe.c` so that it can reach their file-scope state, and resets that state before every run. They are compiled with `main` renamed to `sc_ffmpeg_main` and `sc_ffprobe_main`, and ffprobe also with `program_name`, `program_birth_year` and `show_help_default` renamed because ffmpeg and ffprobe define the same names.
- `sc_fftools_stdio.h`: forced include. After it, `stdout`, `stderr`, `printf`, `vprintf`, `puts`, `putchar`, `perror` and `setvbuf` on those streams go to the stream of the running session and never to descriptors 0, 1 and 2 of the app.
- `sc_exit_map.h`: forced include. `exit(code)` becomes `sc_tool_exit(code)` (function-like, so a field named `exit` is untouched).
- `patches/`: two patches against the pinned FFmpeg tree, pinned by sha256 in `contracts/ffmpeg-build.json`. `ffmpeg-opt-reset.patch` adds `sc_ffmpeg_opt_reset()` for the `-y` and `-n` statics of `ffmpeg_opt.c`. `ffprobe-no-exit.patch` turns the five `exit(1)` calls in `ffprobe.c` into error returns.

## Building

On a Mac with Xcode and both iOS SDKs:

    make ios-ffmpeg-device     # arm64 iPhone
    make ios-ffmpeg-sim        # arm64 Simulator
    make ios-ffmpeg            # both

Both call `scripts/ios/build_ffmpeg.sh <device|sim>`. It reads every pin (archives, sha256, configure options, patches) from `contracts/ffmpeg-build.json`, verifies the downloads before extracting, applies the patches to a copy of the tree, builds lame, opus and FFmpeg for arm64 only (there is no x86_64 Simulator build), links the core, glue and wrappers into `FFmpeg.framework`, and exports only the four `sc_ffmpeg_` symbols. Output is `gui/desktop/src-tauri/ios-ffmpeg/out/<device|sim>/FFmpeg.framework`; sources and build trees live next to it under `src/` and `build/`. All three directories are ignored by git. The script copies nothing into the app tree. `scripts/ios/ffmpeg_framework.py assemble` (the second line of each `make ios-ffmpeg-*` recipe) then writes `gui/desktop/src-tauri/ios-payload/FFmpeg.xcframework` from the slices that exist, with the framework's own `ios/ffmpeg/PrivacyInfo.xcprivacy` added to each (its categories and reason codes are copied from the app manifest, not derived from the framework's imports, and are unconfirmed until the Mac privacy check and App Store validation have seen them); the Xcode project links that. `ffmpeg_framework.py check --sdk iphoneos|iphonesimulator` stops a build when the slice is missing.

Build paths are mapped away (`-ffile-prefix-map`, `-fdebug-prefix-map`) and the configuration string embedded in libavutil is rewritten, so the framework carries no path of the build machine.

## Why this is not in cloud CI

The build needs Xcode's clang and the iPhoneOS and iPhoneSimulator SDKs, and CI runs on Linux. Cloud tests cover what is portable: the core against a fake glue under ASan and TSan, the pins in the contract, the patch checksums, the text of the build script and the forced-include headers (`tests/test_ios_ffmpeg_shim.py`, `tests/test_ios_ffmpeg_build.py`). Compiling the wrappers against FFmpeg and running the Simulator scenarios is done on a Mac.

## Known limits

- State is reset by name. `-report` (an open report file in `opt_common.c`) and the function-local `static` throttles of `print_report` are not reset, and `-report` should not be used. A run that ends through `exit()` leaves the heap of the abandoned frames allocated.
- `ffmpeg -n` onto an existing file prints "already exists" and exits 0: FFmpeg maps `AVERROR_EXIT` to 0 in `main`.
- The core rejects `dev/` and `proc/` at the start of an argument token or after a delimiter, and `dev/std`, `proc/self` anywhere; `/srv/x/dev/notes.wav` passes.
- Not fixed here, by decision:
  - M4: the lame and opus builds are reused without a stamp; delete `build/` after changing a pin.
  - M5: a failed open in ffprobe leaks the input context once per failure.
  - M6: `opt_common` and hardware-device globals are not reset after an `sc_tool_exit` unwind.
  - M7: the process-wide `signal(SIGINT, SIG_DFL)` and the `getchar` path are reachable only without `-nostdin`, which the core inserts for ffmpeg only; ffprobe's stdin paths are unverified.
  - L1: the ffprobe banner prints the ffmpeg identity.
  - L2: the error flag of the persistent slot `FILE`s is sticky.
  - L3: the build script word-splits paths with spaces and hardcodes the fftools object list.
  - L5: a non-owner `sc_tool_exit` leaves locks held.
  - H-A: the `SIGUSR2` kick reaches only the worker thread; the Simulator 1 s cancel return was one observation at the probe stage, not a guarantee; the bridge's stdin close at `KILL_GRACE_SEC` is the only backstop and does not cover a demux or mux thread blocked on a stdout or stderr write.
  - CFLAGS is split: the configure probes run without the forced includes, and `make CFLAGS=` for lame and opus replaces their flags and adds them.
  - zlib is linked from the iOS SDK; `contracts/ffmpeg-build.json` still pins a zlib source and a 12.0 deployment target the script never reads.
  - L-1: the `SIGUSR2` kick can land in the worker's own `fflush`, so the tail output of a cancelled session is lost.
  - L-2: a space after a delimiter is not a protocol-word boundary (`concat:a.wav| pipe:0` is accepted); safe only if libav does not trim blanks (unverified).
  - L-4: a cancelled running session returned 0 on the Simulator, not 255 (the Python layer reports -9).
  - L-5: `cfg_stub` in the build script defines no `sc_out`; a probe that needs it fails the first build loudly.

## License and source offer

FFmpeg is built without `--enable-gpl` and is used under the LGPL 2.1 or later; lame is LGPL and opus is BSD. The framework is dynamic and replaceable. `LICENSES/FFMPEG-SOURCE.txt` states versions, URLs, checksums, patches and how to rebuild. Legal review of that text and of the written offer is pending.
