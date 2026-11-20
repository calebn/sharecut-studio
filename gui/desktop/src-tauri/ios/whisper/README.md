# whisper.cpp inside the iOS app

This directory holds the C and C++ that turns whisper.cpp 1.9.5 (tag `v1.9.5`) into `Whisper.framework`, the dynamic framework the iOS app embeds so that transcription runs in the app process. iOS cannot spawn `whisper-cli`, so the Python side calls four exported functions (`sc_whisper_abi_version`, `sc_whisper_start`, `sc_whisper_wait`, `sc_whisper_cancel`) with the argv it would give the CLI. The ABI is described in `docs/desktop-packaging.md`.

## Files

- `sc_whisper_core.h`, `sc_whisper_core.c`: the whisper side of the session core: it accepts `whisper-cli` as `argv[0]`, applies the argv policy and exports the four symbols. The queue, worker thread, descriptor ownership and exit path are `ios/native/sc_session_core.inc`, shared with the FFmpeg core (`ios/ffmpeg/sc_ffmpeg_core.c`). It builds and is tested on Linux (`tests/test_ios_whisper_shim.py`) against a fake glue.
- `sc_whisper_glue.cpp`: `sc_glue_run` (runs the cli main, turns an uncaught C++ exception into exit 1), `sc_glue_reset` (clears the cancel latch, routes `whisper_log_set` and so the ggml log to the session's error stream) and `sc_glue_interrupt` (sets the latch).
- `sc_whisper_cli.cpp`: wrapper translation unit that includes `examples/cli/cli.cpp`; compiled with `main` renamed to `sc_whisper_cli_main`.
- `sc_whisper_stdio.h`: forced include for the cli wrapper and the example sources. After it, `stdout`, `stderr` and printf go to the stream of the running session and never to descriptors 1 and 2 of the app. Checked by grep over the v1.9.5 `examples/cli`, `common.cpp`, `common-whisper.cpp` and `grammar-parser.cpp`: they use only `printf` and `fprintf` on `stdout` and `stderr` (no `std::cout`, `std::cerr`, `std::clog`, `puts`, `fputs`, `fwrite`, `putchar` or `write(1`), and the one read of `stdin` (`fread` in `common-whisper.cpp`) is reached only by `-f -`, which the argv policy rejects. The stream scope is the cli sources only; whisper.cpp and ggml in the static libraries log through `whisper_log_set` and ggml's log callback, which `sc_glue_reset` routes to the session's error stream.
- `sc_whisper_exit_map.h`: forced include for the CMake library translation units and the cli translation units (the glue and core files do not call `exit` or `abort`). `exit(code)` becomes `sc_tool_exit(code)` and `abort()` becomes `sc_tool_exit(134)`, in C and C++ (`std::exit` too). `_Exit`, `_exit` and `quick_exit` are not mapped because nothing reachable calls them: grep over the same cli sources finds only `exit(0)` and `exit(1)` calls, and the one `_Exit` in the tree is in the child branch of ggml's `ggml_print_backtrace`, which the patch compiles out of iOS builds. The cli translation units are compiled with `-DNDEBUG`, because a failing `assert` in the bundled stb_vorbis or miniaudio would call libSystem `abort()` (not remapped) and end the app; the CMake libraries build as Release, which defines it too.
- `patches/whisper-cli-hooks.patch`: pinned by sha256 in `contracts/whisper-build.json`. It makes the cli's abort and encoder-begin callbacks read the latch (`sc_whisper_aborted`), drops `ggml_backend_load_all()` (it scans directories and `dlopen`s any `libggml-*` it finds; the CPU and Accelerate backends are linked in), turns the unknown-language `exit(0)` into `exit(1)`, replaces the `system()` call of an unused function in `common-whisper.cpp`, and compiles ggml's debugger-attaching `ggml_print_backtrace` (`fork`, `execlp`, `waitpid`) out of iOS builds, because iOS forbids starting processes and App Review flags those imports.

## Argv policy

`argv[0]` must be exactly `whisper-cli`, otherwise `sc_whisper_start` returns `-EINVAL`. The remaining arguments may only be the flags the Python engine passes: `-ojf`, `-np`, and `-m`, `-f`, `-of`, `-l`, `-t`, `--prompt` with one value each. Anything else (so every positional argument is rejected), a missing value, and, as the value of `-m`, `-f` or `-of`, `-`, an empty string, `@...`, a path that begins with a `dev` or `proc` directory, after an optional `./` or `/`, or that has one right after one of the delimiters `=` `:` `,` `;` `[` `]` `(` `)` `|` or a space (`/dev/stdin`, `/dev/fd/0`, `/proc/self/fd/0`; a directory named `dev` deeper in an ordinary path is not refused) or a path with a `..` component make the session exit 1 with one `sc_whisper:` line on its error stream and run nothing. The path checks are the FFmpeg policy's (`has_device_dir`, `has_dotdot_component`, in `ios/native/sc_session_core.inc`) and run on the path text only, lower-cased, with quotes and backslashes removed and `//` and `/./` collapsed; they do not resolve symlinks. There is no descriptor or path rewriting: whisper reads and writes by path, and no accepted path spells fd 0. A symlink the app itself creates to a device is not followed by the check, so the app must not create one.

## Cancel

`sc_whisper_cancel` sets the latch, closes the session's own copies of the caller's descriptors, sends `SIGUSR2` to a running worker once, and returns. The latch is polled by ggml between graph nodes (`abort_callback`) and before every encoder window (`encoder_begin_callback`). A run stopped through these callbacks may still return normally with a partial result, so the core reports `255` for a session that was cancelled while running, whatever value the tool returned, with two exceptions that report `1`: the tool returned a value outside 0..255, or `sc_tool_exit` ended it on a thread other than the worker. A session cancelled while still queued never runs and reports `255`. Model loading and a single ggml node are not interruptible, so `sc_whisper_wait` can lag a cancel by that long; the Python bridge abandons a session that outlasts its 5 s grace.

## Building

On a Mac with Xcode and both iOS SDKs, `scripts/ios/build_whisper.sh <device|sim>` reads the archive URL, archive sha256, patch and minimum iOS version from `contracts/whisper-build.json` (the `commit` field is a record for humans, the script does not check it), verifies the tarball and the patch before extracting, extracts into a freshly removed directory on every run (so an edited or stale tree is never built), applies the patch with `patch -p1 --fuzz=0` to a copy of the tree, builds into a CMake tree that is removed first, builds the whisper.cpp and ggml static libraries with CMake for arm64 (CPU and Accelerate, no Metal, no OpenMP, no dynamic backends), compiles the glue and the example sources, links them into `Whisper.framework` (libc++ and Accelerate come from the SDK), and fails unless `nm -gU` lists exactly the four `sc_whisper_` symbols among the `sc_` names; the linker's exported-symbols list and the IPA bundle check keep every other symbol out. Output is `gui/desktop/src-tauri/ios-whisper/out/<device|sim>/Whisper.framework`, with sources and build trees beside it under `src/` and `build/`.

The tarball is `codeload.github.com/ggml-org/whisper.cpp/tar.gz/refs/tags/v1.9.5` (9,626,464 bytes). Its sha256 in the contract was measured on the Mac from the download, identical from codeload and from the archive URL. `SC_WHISPER_SOURCE_TARBALL` names a local copy to use instead of downloading it; it is checked against the same sha256.

## Host proof (no Mac)

`scripts/ios/build_whisper.sh host` builds the same sources, patch and glue with the host `cc`, `c++` and `cmake` into `libsc_whisper.so` (`SC_WHISPER_WORKDIR` moves the work tree out of the repository). `scripts/ios/whisper_host_check.py` then drives it through `sc_whisper_start`, `sc_whisper_wait` and `sc_whisper_cancel` with ctypes. This needs a model and a speech WAV, so it is a manual check and not part of CI:

    SC_WHISPER_WORKDIR=/tmp/whisper-host scripts/ios/build_whisper.sh host
    curl -L -o /tmp/ggml-tiny.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin
    python3 -I scripts/ios/whisper_host_check.py --lib /tmp/whisper-host/out/host/libsc_whisper.so \
        --model /tmp/ggml-tiny.en.bin --wav /tmp/whisper-host/src/whisper.cpp-1.9.5/samples/jfk.wav \
        --host-cli /path/to/whisper-cli

It transcribes the WAV twice and compares the `-ojf` segments with a whisper-cli built from the same tag, then checks a wrong `argv[0]`, an unsupported flag, a missing model, an unknown language (an `exit()` that must not end the process), cancels at 0, 1 and 3 s into a long input (exit 255, latency under the grace, double cancel, cancel from another thread, `-ESRCH` after the claim) and a session after a cancel.

## Why this is not in cloud CI

The iOS build needs Xcode's clang and the iPhoneOS and iPhoneSimulator SDKs, and CI runs on Linux. Cloud tests cover what is portable: the core against a fake glue under ASan (`tests/test_ios_whisper_shim.py`, with `SC_SHIM_SANITIZER=address`), the pins, the patch checksum and, when `SC_WHISPER_SOURCE_TARBALL` is set, that the patch applies to the pinned tree, and the text of the build script (`tests/test_ios_whisper_build.py`). Compiling for iOS, the export check on the iOS slices, the Simulator and device runs and their timings are done on a Mac.

## Known limits

- `sc_tool_exit` called from a ggml worker thread (a `GGML_ABORT` inside a compute thread) ends that thread only; the rest of the compute barrier can then wait forever. Input errors are checked before compute, but a corrupt model is not proven safe.
- The unwind by `siglongjmp` skips C++ destructors, as in the FFmpeg shim. The cli itself leaks its whisper context on a few early error returns (grammar, DTW preset), which the argv policy makes unreachable.
- `std::terminate` (an uncaught exception on a ggml thread) still ends the process.
- The single worker runs one session at a time, so one model is resident at a time; peak memory and jetsam behaviour on a device are unmeasured.
- Privacy-manifest categories for this framework's imports (`clock_gettime`, `sysctlbyname`, `stat`) are unconfirmed until the Mac privacy check has seen the iOS slice.

## License

whisper.cpp and ggml are MIT licensed; the notice must ship in the app (`LICENSES/WHISPER-SOURCE.txt`).
