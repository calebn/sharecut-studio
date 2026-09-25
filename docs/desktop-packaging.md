# Desktop packaging (Sharecut Studio / Tauri)

Stage 1 host installer: **Tauri 2 + Python sidecar**. The React DAW and FastAPI
engine are unchanged; the native app is a window + process manager.

## Boundaries

| Surface | Location |
|---------|----------|
| Sharecut Studio UI + engine | FOSS — `gui/web`, `src/podcast_mcp` |
| FOSS share (mint + guest against **any** relay) | FOSS — share routes / tunnel **client** |
| Generic `podcast-relay` Compose | FOSS — `deploy/relay` (self-host) |
| Tauri **source** | FOSS — [`gui/desktop/`](../gui/desktop/) |
| Reusable installer build [`release-desktop-build.yml`](../.github/workflows/release-desktop-build.yml) | FOSS YAML; Environment `desktop-signing` secret **values** stay funnel |
| Hosted relay, release publishing, download pages, and account operations | **Private** operations repo |

Rule: if Maya can edit offline, it belongs in the `.app`. If a guest on the
internet needs a public URL, they hit **a** relay (theirs or yours); share HTTP
still runs on the laptop.

## Distribution profile

Desktop product identity and trust policy come from a validated public JSON
profile. The checked-in [`config/distribution.dev.json`](../config/distribution.dev.json)
is safe for contributor builds. A distributor supplies its own profile through
`PODCAST_DISTRIBUTION_PROFILE`; signing keys and deployment credentials stay in
the environment or CI secret store and are rejected as profile fields.

The profile sets the product name, bundle identifier, custom deep-link schemes,
exact allowed HTTPS share origins, support/privacy/repository URLs, optional
release manifest, and optional bootstrap CDN. `scripts/generate_distribution_config.py`
produces the Tauri overlay, while `build.rs` emits the Rust constants used for
deep-link validation and bootstrap fallback. The Tauri host passes the profile's
support, privacy, repository, and optional release-manifest URLs to every Python
sidecar as `PODCAST_DISTRIBUTION_*` values. The sidecar accepts only public HTTPS
values and falls back to safe upstream links (or no release manifest); it never
loads build identity from `relay.yaml` or user preferences. Direct Cargo builds
run the same Python validator before emitting those constants. This keeps the
platform manifest and runtime allowlist in sync.

```bash
podcast config check --mode distributor --distribution-profile ./distribution.json
PODCAST_DISTRIBUTION_PROFILE=./distribution.json make desktop-build
```

## Local checks (CI mirror)

```bash
make test-desktop    # scaffold + sidecar launcher (rustfmt/clippy/rustc --test) + rustfmt + clippy --lib + cargo test --lib
make desktop-build   # freeze sidecar, then .dmg/.nsis/AppImage; signs+notarizes on macOS if APPLE_* is set
```

`make test-desktop` matches `.github/workflows/desktop.yml` via
[`scripts/check_desktop.sh`](../scripts/check_desktop.sh). Needs
[rustup](https://rustup.rs/) with `rustfmt` and `clippy`. Runs
`cargo … --lib --no-default-features` so GTK/WebKit are not required.
It also checks the standalone sidecar launcher (`scripts/sidecar_launcher.rs`,
not a cargo crate): `rustfmt --check`, `clippy-driver -D warnings`, and its
`rustc --test` unit tests. The Windows CI job compiles and tests the launcher's
`cfg(windows)` arms.
On macOS the same script also `clippy --bin sharecut --features app` so
`media_capture.rs` (WKWebView / WebView2 adapters) is typechecked (uses
`--dev-stub` so Tauri's `externalBin` exists). Ubuntu CI cannot compile those
adapters. No Rust coverage % gate — host glue stays thin; Python stays on the
≥95% gate.

## First-run assets

Home screen shows a bootstrap wizard when FFmpeg or Whisper is missing:

- `GET /api/bootstrap/status` (includes `whisper_models` catalog)
- `POST /api/bootstrap/run` with `whisper_model` → SSE `GET /api/bootstrap/events`

Default speech model is **large-v3-turbo**. Users can pick a smaller size in the wizard or via `./install.sh --whisper-model` / `podcast bootstrap --whisper-model`.

Same downloads as `podcast bootstrap` (ffmpeg, whisper; optional rnnoise).
Torch / speaker / joinqc are **not** exposed in the GUI.

**Open project:** Sharecut Studio **Browse…** / Mod+O call `POST /api/project/pick` on the Python sidecar (OS dialog), the same API as a system browser on `http://127.0.0.1:8765`. Paste path remains when no dialog tool is available. The desktop `tauri-plugin-dialog` is reserved for native close confirmation; it is not used as a project picker.

## Closing while recording

While a local host or guest keeper is active or finalizing, the web client
writes `sc_close_guard=host|guest` into its loopback URL. The native Tauri host
reads that marker during `CloseRequested` and `ExitRequested`, prevents the
request synchronously, and displays a role-aware native confirmation dialog.
Host Start arms the marker synchronously before its HTTP request, covering a
server transition that precedes the response. If both Start and its status
check have an uncertain outcome, the guard stays armed until a subsequent
recording command verifies the room state. A newer snapshot timestamp alone
cannot prove that the Start request has finished.
After confirmation it calls `WebviewWindow.destroy()` and exits the app; a
cancel keeps the window and recording open. An unreadable, malformed, or
duplicated marker is treated conservatively and still requires confirmation.
The marker survives a WebView reload until a room snapshot confirms it is safe
to clear, and a failed keeper finalization leaves confirmation armed.
If the microphone disappears as Stop arrives, the guard remains armed until
the local WAV and metadata flush completes. If the main WebView handle is
unavailable, native close and exit requests are blocked conservatively.
An unguarded window close routes through app exit while its WebView is still
available for a final guard check. Guest producers and guests who declined
recording do not receive a keeper warning from room state alone.
A successful retry clears a current keeper finalization warning; an older
session's failed disposal stays armed because a new session cannot repair its
WAV. New/Open project navigation is blocked while the marker is armed, and
Home does not clear a marker carried from a recording room. If a
confirmed native destroy fails, a dialog explains that the room remains open
and offers a retry through the normal Quit control.
On macOS the app menu mirrors Tauri's default items but replaces its native
Quit item with a `Cmd+Q` menu command that calls `AppHandle::exit(0)`, so
the app menu and Cmd+Q take the `ExitRequested` confirmation path. Dock Quit
and OS shutdown can bypass the app menu; they remain best-effort paths.

The loopback page receives no Tauri plugin capability, performs no native IPC,
and never gets permission to destroy a window. `tauri-plugin-dialog` is used
only by Rust for the confirmation dialog. Do not widen
`capabilities/default.json` or add `remote.urls` to support this guard.

Pinned bootstrap assets, when a distributor elects to mirror them, are described
by [`contracts/bootstrap-assets.json`](../contracts/bootstrap-assets.json).

## Platforms

| OS | Bundle | WebView |
|----|--------|---------|
| macOS | `.app` / `.dmg` | WKWebView |
| Windows | `.msi` / NSIS | WebView2 |
| Linux | AppImage / `.deb` | WebKitGTK |

The Python sidecar and bundled `ffmpeg` CLI are **desktop-only**. A later native
iOS/Android app is not an `externalBin` port — in-process libav, same React UI.
Deferred path and interim constraints: [cross-platform-byok.md](cross-platform-byok.md).

The public check workflow is deliberately limited:

| Workflow | When it runs | What it does |
|----------|----------------|--------------|
| [`.github/workflows/desktop.yml`](../.github/workflows/desktop.yml) | PR/main path filter | Portable scaffold (`make test-desktop` / clippy `--lib`) plus a Windows `cargo check` for the WebView2 desktop binary. It does not build installers. |
| [`.github/workflows/release-desktop-build.yml`](../.github/workflows/release-desktop-build.yml) | Reusable `workflow_call` | Builds installer artifacts for a caller. A private operations repository owns dispatch, signing, publishing, and manifests. |

Do not put certs, `.p8` files, or `APPLE_*` / Authenticode **values** in this FOSS tree. Apple Silicon notarized DMGs can still be built locally (see [§ Local codesign and notarization](#local-codesign-and-notarization)). Intel GHA artifacts stay unsigned unless the funnel secrets are present.

## Linux AppImage in Docker (before GHA)

`linuxdeploy` failed twice on GitHub-hosted `ubuntu-22.04` (missing square PNG, then a swallowed `failed to run linuxdeploy`). Docker `--verbose` showed the real error: **`xdg-mime` missing**. Iterate on the same WebKitGTK 4.1 stack locally instead of re-dispatching the expensive workflow:

```bash
make desktop-linux-appimage-docker
```

To exercise a distributor build, pass the same profile used for macOS. The
wrapper resolves a relative path from the caller's directory and mounts an
external profile read-only inside the container:

```bash
PODCAST_DISTRIBUTION_PROFILE=../sharecut-ops/config/distribution.production.json \
  make desktop-linux-appimage-docker
```

That builds [`gui/desktop/Dockerfile.linux-appimage`](../gui/desktop/Dockerfile.linux-appimage) (`ubuntu:22.04`) and runs [`scripts/build_linux_appimage.sh`](../scripts/build_linux_appimage.sh): generate a compact product-name overlay from the selected distribution profile, freeze the sidecar, then run with `NO_STRIP=true` and `APPIMAGE_EXTRACT_AND_RUN=1`. Spaces in product names break AppDir names, so the Linux overlay removes them. The freeze and Cargo target live on **Docker volumes** (Linux case-sensitive FS). Bind-mounting the runtime onto macOS APFS drops `terminfo/N` vs `n` and Tauri’s resource walk fails. Freeze output is slimmed (`--slim-only`) so linuxdeploy does not try to deploy Tcl/Tk from uv CPython. Manylinux wheel `*.libs` dirs are prepended to `LD_LIBRARY_PATH` so linuxdeploy/`ldd` can resolve hashed sibling `.so` files (e.g. ctranslate2’s `libgomp-*.so`). AppImages copy to gitignored `gui/desktop/dist-linux/`. Set `REBUILD_SIDECAR=1` on that make target to redo the volume freeze (new `sidecar_launcher` / `PYTHONHOME` / `.python-home`); otherwise a complete freeze is reused. Skipping smoke with `SKIP_APPIMAGE_SMOKE=1` is for local iteration only — a reused freeze can still ship a stale launcher that never rewrites `pyvenv.cfg`.

If `docker pull ubuntu:22.04` hangs, the wrapper imports Ubuntu’s published jammy rootfs via curl and builds `FROM` that local tag.

Apple Silicon Docker produces an **aarch64** AppImage (native). Testers download **amd64** from GHA; only click **Run workflow** after this Docker recipe succeeds. The Ubuntu job calls the same `build_linux_appimage.sh`.


## Frozen sidecar

Testers do not have `podcast` on PATH. [`scripts/build_sidecar.py`](../scripts/build_sidecar.py) freezes **on each OS** (native `faster-whisper` / CTranslate2 wheels):

- Standalone CPython (`uv python install 3.12`) + venv with `--extra gui,bootstrap` (no torch / joinqc). `bootstrap` is `static-ffmpeg` so first-run FFmpeg download works without a system binary. The venv is created from `uv python find --managed-python --no-project 3.12` under `UV_PYTHON_INSTALL_DIR`, not the repo `.venv`. A Homebrew/framework interpreter plus uv `PYTHONHOME` fails with `ModuleNotFoundError: math` (uv standalone keeps `math` builtin; Homebrew expects `lib-dynload/math*.so`). Freeze then imports `math`, `datetime`, `encodings`, and `uvicorn` before writing `.freeze-complete`.
- Copied `gui/web/dist` as `sharecut-runtime/web-dist`. The freeze and
  `--ensure` reuse paths reject assets containing recording E2E hooks; build
  ordinary web assets after running `make test-web-e2e` before packaging.
- Tiny compiled launcher (`scripts/sidecar_launcher.rs`, **rustc required** for packaged builds) named `sharecut-sidecar-<rustc-host-triple>`. The shell/cmd templates in `build_sidecar.py` are GUI-only `--dry-run` placeholders and never ship.

The launcher sets `PODCAST_GUI_DIST`, `PYTHONHOME` (uv standalone CPython under `sharecut-runtime/python/cpython-*`, preferred via freeze marker `sharecut-runtime/.python-home`), `PODCAST_MAGIC_LINK_PRINT=0`, and `PODCAST_GUI_OPENAPI=0`, rewrites `venv/pyvenv.cfg` `home` / `executable` / `base-executable` to that relocated prefix, then execs `python -P -m podcast_mcp.cli.main gui --host 127.0.0.1 --port <port> --no-open`. Packaged Tauri sets `PODCAST_SIDECAR_EPHEMERAL=1` so that port is `0` (OS-assigned); `podcast gui`, `tauri dev`, and AppImage smoke (sidecar run without the parent env) stay on **8765**. Relocate fixes two failures after AppImage/DMG/NSIS copy: (1) compiled prefix `/install` → `ModuleNotFoundError: No module named 'encodings'`; (2) Windows venv stub still pointing at the GHA path → `No Python at 'D:\a\sharecut-studio\...'`. FastAPI honors `PODCAST_GUI_DIST` in [`gui/static_assets.py`](../src/podcast_mcp/gui/static_assets.py) (`resolve_gui_static_root`). Layout inside the Mac app:

- `Contents/MacOS/sharecut` — Tauri
- `Contents/MacOS/sharecut-sidecar` — launcher (`bundle.externalBin`)
- `Contents/Resources/sharecut-runtime/` — CPython, venv, web dist (`bundle.resources`)

### Packaged CLI (`--cli`)

For packaged diagnostics and maintenance commands, invoke the compiled launcher as `sharecut-sidecar --cli <podcast arguments>` (macOS / Linux). The arguments (non-UTF-8 paths included) are forwarded to `python -P -m podcast_mcp.cli.main`; the invoking terminal's working directory is kept but is **not** added to the module search path (`-P`), and stdin/stdout/stderr are inherited. CLI mode always uses the bundled `PYTHONHOME`, removes `PYTHONPATH` / `PYTHONSTARTUP` / `PYTHONUSERBASE` / `VIRTUAL_ENV`, and sets `PYTHONNOUSERSITE=1`; other variables (including `PODCAST_*`) pass through, as with the pip `podcast` CLI.

The launcher sets `PODCAST_PACKAGED_CLI=1` and does not parse the CLI grammar. Python's `gui` command and `ensure_viewer` (`services/gui_launch.py`, `packaged_cli_gui_refusal`) then refuse with exit code 2 and an instruction to launch or focus the installed app, wherever root options such as `--no-progress` appear, so a packaged CLI call cannot start a second host on `:8765`.

Differences from the app-spawned sidecar: `--cli` does not receive Tauri's `PODCAST_DISTRIBUTION_*` / `PODCAST_BOOTSTRAP_CDN_BASE`, so `--cli doctor` reports default distribution metadata and `--cli bootstrap` fetches from upstream URLs (content is still hash-pinned). `pyvenv.cfg` is only rewritten when its prefix changed, via a temp file + rename, so concurrent `--cli` calls are safe. On **Windows** the launcher is a GUI-subsystem exe, so `--cli` exits 2 with a message (also appended to `sidecar.log`) until a console shim ships ([#97](https://github.com/calebn/sharecut-studio/issues/97)).

Windows puts the launcher next to the exe and the runtime under `resources/sharecut-runtime`. Linux **AppImage** puts the launcher in `usr/bin/` and the freeze at `usr/lib/<productName>/sharecut-runtime` (linuxdeploy). The launcher probes those paths plus macOS `Contents/Resources/`. `spawn_sidecar` looks for `sharecut-sidecar.exe` / `.cmd` (Windows `--dry-run` placeholder only) / bare name. Keep [`gui/desktop/binaries/sharecut-sidecar`](../gui/desktop/binaries/sharecut-sidecar) (bash) in git for `tauri dev`; freeze output under `binaries/sharecut-runtime/` and leftover platform copies (`binaries-linux/`, `binaries-*/`) are gitignored. Slim uses `lib/thread[0-9]*` (Tcl `thread2.*`) rather than `lib/thread*` — on Windows, case-insensitive `Path.glob` would also delete CPython stdlib `Lib/threading.py`. Other `tcl*` / `tk*` slims could still case-fold into unexpected `Lib/` names if the CPython layout changes.

The native window loads a **splash** (`gui/desktop/splash/`) until the packaged sidecar writes a `0600` listen JSON, the OS LISTEN owner of `127.0.0.1:<port>` is that sidecar (or a Windows child), and `GET /api/health` returns HTTP 200 plus `{"ok": true}` with header `X-Sharecut-Boot-Token`. Then the WebView navigates to `http://127.0.0.1:<discovered-port>/` — never a baked `:8765`. Engine navigation is `127.0.0.1` only (`localhost` / `::1` are denied). Packaged **release** does not fall back to PATH `podcast`/`uv` on `:8765` if the bundled sidecar fails to spawn — splash errors instead (`tauri dev` still may). The Tauri host reads that health response across split TCP segments (Windows uvicorn often sends headers, then the tiny JSON body) rather than a single `read()`. Do not set the WebView URL to the engine on first paint — WebView2 (Windows) shows a sticky `ERR_CONNECTION_REFUSED` Edge page if the sidecar is not listening yet. Sidecar stdout/stderr append to `%LOCALAPPDATA%\SharecutStudio\sidecar.log` (Windows), `~/Library/Logs/Sharecut Studio/sidecar.log` (macOS), or `~/.local/state/SharecutStudio/sidecar.log` (Linux); the listen file sits beside the log as `sidecar.listen.<parent-pid>.json`. After `make desktop-linux-appimage-docker` (or a reusable CI build), [`scripts/smoke_linux_appimage.sh`](../scripts/smoke_linux_appimage.sh) extracts the AppImage, runs `sharecut-sidecar --cli --help` and asserts `--cli --no-progress gui` is refused (exit 2), then curls `/api/health` on **:8765** without the parent token env (skip with `SKIP_APPIMAGE_SMOKE=1`). That does not drive WebKit; it catches a dead sidecar, which is the same user-visible failure as connection refused. Packaged CSP includes `frame-ancestors 'none'`; do not add `remote.urls` — the DAW never `invoke`s, and that grant plus `shell:allow-open` is the squat payoff. Edit splash CSP in [`gui/desktop/src-tauri/tauri.conf.json`](../gui/desktop/src-tauri/tauri.conf.json) together with host GUI `GUI_CSP` in [`src/podcast_mcp/gui/middleware_security_headers.py`](../src/podcast_mcp/gui/middleware_security_headers.py) (`frame-ancestors`, `object-src`, `base-uri`). The launcher always passes `--port 8765`; Python `resolved_bind_port` is the only ephemeral-port policy when `PODCAST_SIDECAR_EPHEMERAL` is set.

`make desktop-build` and reusable CI builds freeze the sidecar **before** `tauri build`. `beforeBuildCommand` is [`scripts/tauri_sidecar_hook.py`](../scripts/tauri_sidecar_hook.py) `--ensure` (walks to the repo root from Tauri’s hook cwd, which is `gui/desktop` — Windows cmd cannot expand POSIX `$(git …)`), which reuses the freeze when `sharecut-runtime/.freeze-complete` exists (so a raw `npm run tauri -- build` still cannot ship an empty runtime) but always recompiles the launcher, so a stale or `--dry-run` launcher without `--cli` cannot ship. `rustc` is checked before the freeze starts. `--dry-run` emits GUI-only placeholder launchers (unit tests). `--dev-stub` copies the bash sidecar to the triple name so `tauri dev` can satisfy `externalBin`. Windows NSIS uses the distribution profile's compact product name so packaging tools do not receive spaces.

On macOS, `APPLE_SIGNING_IDENTITY` also signs nested Mach-O in `sharecut-runtime` (`--options runtime --timestamp`) so Apple notarization accepts the bundled `.so` / `python` binaries. `--codesign-only` re-signs an existing freeze.

Local MCP connect copies the WebView origin: packaged builds use the discovered loopback port; `podcast gui` / `tauri dev` stay `http://127.0.0.1:8765/mcp`.

## DMG / `hdiutil` “Resource busy”

Tauri’s macOS DMG step (and our `hdiutil create -srcfolder`) can fail with
**Resource busy** when DiskArbitration is contended (rapid successive creates,
many attached images such as CoreSimulator runtimes).

`make desktop-build` notarizes the **`.app` once** (`tauri build --bundles app`),
then [`scripts/pack_macos_dmg.sh`](../scripts/pack_macos_dmg.sh) retries **only**
`hdiutil` and, if `APPLE_API_*` is set, notarizes the DMG. The temp image path
ends in `.partial.dmg` because `hdiutil create` appends `.dmg` when the dest
has no suffix. Do **not** retry `tauri build --bundles dmg` — that re-signs
the app and re-submits a zip to Apple for several minutes per attempt.

## Build and distribution boundary

`make desktop-build` produces local installer bundles. The reusable
[`release-desktop-build.yml`](../.github/workflows/release-desktop-build.yml) workflow
can produce signed or unsigned artifacts for an authorized caller. Release
publishing, download manifests, CDN configuration, and installer hosting are
operated privately and intentionally have no runbook in this repository.
Private extension runtimes move between preparation and bundle jobs as tar
archives so marker files, executable modes, and symlinks survive artifact
transport. Windows preparation and restore steps convert the runner temp
directory to its Git Bash path before invoking `tar`; native drive paths are
not valid tar targets.

## Local codesign and notarization

Direct-download DMGs need a **Developer ID Application** certificate (not Apple
Development, not App Store Distribution) and Apple notarization. Public CI in
this repo does **not** hold those secrets.

On a Mac that already has the cert in the **login** keychain and an App Store
Connect API `.p8` at `~/.appstoreconnect/private_keys/AuthKey_<KeyID>.p8`:

```bash
export APPLE_SIGNING_IDENTITY='Developer ID Application: Your Name (TEAMID)'
export APPLE_TEAM_ID='TEAMID'
export APPLE_API_KEY='KeyID'   # not the .p8 path; filename is AuthKey_<KeyID>.p8
export APPLE_API_ISSUER='xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
# optional if the .p8 is not in the default directory:
# export APPLE_API_KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_<KeyID>.p8"
make desktop-build
```

Tauri codesigns and notarizes the **`.app`**. Then `pack_macos_dmg.sh` builds,
signs, notarizes, and staples the **DMG** ([Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/)).
Never
commit the `.p8`, `.p12`, or these env values. If Keychain Access shows the leaf
cert as untrusted, install Apple’s [Developer ID G2 CA](https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer)
and [Apple Root CA - G2](https://www.apple.com/certificateauthority/AppleRootCA-G2.cer);
do not set the leaf to Always Trust.

After a successful build:

```bash
APP="gui/desktop/src-tauri/target/release/bundle/macos/Sharecut Studio.app"
DMG=$(ls -1 gui/desktop/src-tauri/target/release/bundle/dmg/Sharecut*Studio*.dmg | head -1)
codesign --verify --deep --strict --verbose=2 "$APP"
spctl --assess --type execute --verbose "$APP"
xcrun stapler validate "$APP"
xcrun stapler validate "$DMG"
shasum -a 256 "$DMG"
```

Expect Gatekeeper **accepted**. The release operator then
publishes the installer and updates its distribution metadata outside this repository.

Mac App Store and Associated Domains entitlement stay deferred. CI signing hooks
are [§ CI signing funnel](#ci-signing-funnel); attaching certs to Environment
`desktop-signing` is owner-only.

## CI signing funnel

Release automation lives in **this** (soon-public) repo as a reusable
[`workflow_call`](../.github/workflows/release-desktop-build.yml). This FOSS tree
never stores secret **values**, certs, key paths, or account identifiers.

The private operations caller invokes this reusable workflow. Default
`sign=false` is an unsigned dogfood build (same artifact names). Set **sign**
when Environment `desktop-signing` is populated.

| Input | Type | Role |
|-------|------|------|
| `version` | string | Informational run label. Bundle version stays `tauri.conf.json`. |
| `sign` | boolean | When true, macOS/Windows legs **fail** unless the source SHA is reachable from protected `main` and that platform's secrets are complete. `sign=false` permits unsigned dogfood builds from a feature branch. Linux never signs. |
| `source_repository` / `source_ref` | string | Optional checkout of another `owner/name` + ref so a private funnel can build this tree. When `source_repository` is set, `source_ref` is required (prefer a full commit SHA). |
| `distribution_profile_json` | string | Public, validated distribution profile supplied by a private release caller. Empty uses the checked-in development profile. Secret-shaped fields are rejected. |
| `extension_artifact_name` / `extension_wheel_sha256` | string | Optional private extension wheel artifact and its exact SHA-256. A nonempty artifact name requires the SHA. The wheel is installed and frozen only in an unsigned, no-permissions Linux/Windows/macOS preparation matrix; signing jobs download its prepared runtime and do not install or import the wheel. |

Secrets (names only; all optional). Store them on GitHub Environment
**`desktop-signing`** — not in git. The reusable job uses that environment only
when `sign` is true **and** the matrix leg is macOS or Windows, so Linux AppImage
and unsigned dispatches do not wait on protection rules.

| Secret | Used for |
|--------|----------|
| `SOURCE_REPOSITORY_SSH_KEY` | Optional read-only deploy key for checking out `source_repository` when the caller token cannot read it. Checkout removes it with `persist-credentials: false` before extension-wheel installation or signing. |
| `APPLE_SIGNING_IDENTITY` | Developer ID Application identity string (same as local `make desktop-build`) |
| `APPLE_CERTIFICATE` | Base64 PKCS#12 of that Developer ID cert (imported into a temp keychain) |
| `APPLE_CERTIFICATE_PASSWORD` | PKCS#12 password |
| `APPLE_TEAM_ID` | Team ID |
| `APPLE_API_KEY` / `APPLE_API_ISSUER` / `APPLE_API_KEY_P8` | App Store Connect API key id, issuer UUID, base64 `.p8` (written to a temp `APPLE_API_KEY_PATH`) |
| `WINDOWS_SIGN_CERT_PFX_B64` / `WINDOWS_SIGN_CERT_PASSWORD` | Authenticode PFX (OV or EV) |

**macOS:** when `sign` and the Apple secrets are set, import the PKCS#12 into a
temporary keychain after both `npm ci` steps. Ordinary builds freeze the sidecar
afterward; extension builds download the already-frozen runtime and use only
`--codesign-only`, which signs nested Mach-O without installing or importing the
wheel. The job then follows the same path as
`make desktop-build` (`tauri build --bundles app` + `pack_macos_dmg.sh`). In an
ordinary build, nested Mach-O in `sharecut-runtime` is signed during freeze when
`APPLE_SIGNING_IDENTITY` is in the environment. The `.app` is checked with
`codesign --verify --deep --strict`. The keychain is deleted in an `always()`
step. Apple Silicon CI is not in this matrix — local operator Mac still covers
arm64.

**Windows:** [`scripts/sign_windows_authenticode.sh`](../scripts/sign_windows_authenticode.sh)
imports the PFX into the current-user store and signs by thumbprint
(`signtool sign /fd sha256 /tr http://timestamp.digicert.com /td sha256 /sha1`)
so the PFX password is not on the `signtool` command line. Sidecar
`sharecut-sidecar-*.exe` is signed **before** `tauri build`, then the NSIS
`*_x64-setup.exe` after; each call also runs `signtool verify /pa`. The inner
`SharecutStudio.exe` payload stays **unsigned** (this repo does not set
`windows.certificateThumbprint` in `tauri.conf.json`, which would bake a
thumbprint into FOSS config). Installer SmartScreen can pass while the launched
binary is still unknown-publisher — a tester residual until a post-compile
sign+repack exists. Azure Trusted Signing is not wired. The DigiCert HTTP
timestamp URL is acceptable for this release job only. GitHub-hosted VMs discard
leftover PFX/keychain files at job end; that bound does not hold on self-hosted
runners.

Signing steps use `set +x` and never print secret env. Each OS job writes
`signed: yes` (job succeeded after verification), `attempted` (signing was
requested but a later step failed), or `no` to the job summary. Windows signed
jobs also note `windows payload exe: unsigned`. Artifact names
(`sharecut-linux-appimage`, `sharecut-windows-nsis`, `sharecut-macos-x64-dmg`)
do not change when signing. Matrix `fail-fast: false`, so one green OS does not
mean the whole signed matrix succeeded.

Private funnel caller (pin the reusable workflow `@` to a full SHA, not
`@main`):

```yaml
jobs:
  bundle:
    uses: calebn/sharecut-studio/.github/workflows/release-desktop-build.yml@0123456789abcdef0123456789abcdef01234567
    with:
      version: "0.1.0"
      sign: true
      source_repository: calebn/sharecut-studio
      source_ref: abc1234567890abcdef1234567890abcdef12345678
      distribution_profile_json: ${{ vars.DISTRIBUTION_PROFILE_JSON }}
      extension_artifact_name: private-extension-wheel
      extension_wheel_sha256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
    secrets: inherit
```

`source_repository`, when set, must be `calebn/sharecut-studio` and `source_ref`
must be a 40-character commit SHA. Before any checked-out repository code, package install,
or secret-bearing step runs, the workflow checks that exact SHA is reachable from the protected
`main` branch. Checkout uses `persist-credentials: false`; a supplied read-only checkout key is
removed before the unsigned extension preparation installs a wheel. A source SHA outside `main` can build
only with `sign=false`; its artifact job has no signing Environment, while Apple, Windows, and
object-store credential paths remain unavailable. PR builds are unsigned.
The caller supplies its validated distribution profile as build metadata. The
reusable build writes it only to the runner temporary directory before exporting
`PODCAST_DISTRIBUTION_PROFILE`.

The caller must store the secret **values** on Environment **`desktop-signing`**
in the **caller** repo. While `sign=true` binds that environment, GitHub
Environment secrets win over repo secrets — `secrets: inherit` of repo-only
secrets will look empty and the job fails closed. Restrict that Environment to
`main`/tags in GitHub settings (not YAML); a `sign=true` dispatch of a feature
branch fails source trust before checkout, so that branch cannot run with the certs.

Funnel callers should set their own `concurrency` group if overlapping runs
would clobber the same artifact names.

Release callers own installer publishing, distribution metadata, and cache
invalidation. This reusable build workflow stops after its Actions artifacts are
available.

## Identity / testers

Bundle identifiers, deep-link schemes, and trust URLs come from the selected
distribution profile. Testers should remove superseded builds when an identifier
changes. Loopback ownership (exclusive bind, ephemeral port, boot-token health,
socket-to-process verification, and WebView allowlisting) is required before
sharing installers.

## Waveforms in the WebView

Clip waveforms rasterize in a module worker, using WebGL2 on an
`OffscreenCanvas` ([waveform.md § Renderer](waveform.md#renderer)). WebView2
(Windows) and current WKWebView (macOS 13+) provide that. Where a webview lacks it (macOS 12 WKWebView,
many WebKitGTK builds on Linux, no GPU), or a GPU context is lost, the worker
falls back to its CPU rasterizer, which draws the same pixels. The main
thread only blits bitmaps either way. `.timeline-area[data-waveform-backend]`
shows which backend ran (`webgl2`, `cpu-worker`, or `none` without
`Worker`).

## Record microphone (WebView)

Recording in the packaged WebView is the same Worklet path as the browser
guest. macOS TCC needs a usage string; hardened runtime needs an audio-input
entitlement. Merge files (Tauri 2 looks next to `tauri.conf.json` and also
accepts `bundle.macOS.infoPlist` /
[`bundle.macOS.entitlements`](https://v2.tauri.app/reference/config/#macosconfig)):

| File | Why |
|------|-----|
| [`gui/desktop/src-tauri/Info.plist`](../gui/desktop/src-tauri/Info.plist) | `NSMicrophoneUsageDescription` only. Camera usage is omitted until video v1. |
| [`gui/desktop/src-tauri/Entitlements.plist`](../gui/desktop/src-tauri/Entitlements.plist) | `com.apple.security.device.audio-input` plus the usual WebView/sidecar CS exceptions (JIT, unsigned executable memory, disable library validation). Not App Sandbox. |

The WebView permission **handler** allows microphone only for the discovered
engine origin `http://127.0.0.1:{port}` (`sharecut::decide_webview_media`,
unit-tested, no Tauri imports). Tauri **2.11.5** has no
`Builder::on_permission_request` (that is the unreleased 2.12 / wry
`with_permission_handler` API — [tauri#14865](https://github.com/tauri-apps/tauri/pull/14865)).
The supported 2.11 hook is [`Webview::with_webview`](https://docs.rs/tauri/2.11.5/tauri/webview/struct.Webview.html#method.with_webview):

- macOS WKWebView: `WKUIDelegate` `requestMediaCapturePermissionForOrigin`
  (forwards other selectors to wry’s delegate via `respondsToSelector:` /
  `methodSignatureForSelector:` / `forwardingTargetForSelector:`).
- Windows WebView2: `PermissionRequested` → allow `Microphone` iff the origin
  predicate passes; deny everything else. COM errors call `SetState(DENY)` so
  the request does not hang.
- **Linux / AppImage: unsupported for the loopback allowlist.** No
  `webkit_permission_request` adapter ships; WebKitGTK’s default prompt applies.
  Record-in-browser is the supported Linux guest path. Porting
  `decide_webview_media` onto WebKitGTK is follow-up.

Do **not** widen `capabilities/default.json` or add `remote.urls`. Full
deny-by-default for camera / geolocation / notifications remains
[v1](../ROADMAP.md#packaging-trust). Handler install failures log to stderr
(`Sharecut Studio: failed to install WebView microphone handler`).

## Deep links

Share links remain HTTPS `/r/{token}` or `/rec/{token}` URLs at an exact origin
listed by the selected distribution profile (browser-first for guests without
the app). Do not mint custom-scheme-only URLs.

The host app registers only the custom schemes listed by the distribution profile.
Parse/allowlist lives in [`gui/desktop/src-tauri/src/share_url.rs`](../gui/desktop/src-tauri/src/share_url.rs)
(`parse_share_deep_link` → token + canonical HTTPS). That module has no Tauri
imports so a later iOS/Android shell can reuse it. Desktop **open** is a
thin adapter: `tauri-plugin-shell` opens the allowlisted URL in the system
browser. The packaged WebView stays splash + `127.0.0.1:{engine}` (loopback
squat). A share deep link is always **guest review**, never “open as a local
project.”

For a profile whose scheme is `example-studio` and share origin is
`https://share.example.test`, `example-studio://r/{token}` constructs
`https://share.example.test/r/{token}`. Tokens must use the current coolname
slug format. Loopback HTTP remains available for development.

**macOS:** schemes come from `tauri.conf.json` → bundled `Info.plist`
`CFBundleURLTypes`. Runtime `register_all()` is unsupported. Launch-by-URL
and clicks while running both use `on_open_url`. `get_current()` is Windows
and Linux argv (cold start of a second process that single-instance then
forwards). `tauri-plugin-single-instance` (registered first, `deep-link`
feature) focuses the existing window so a second Dock launch does not spawn
another sidecar. Test with an installed `.app` under `/Applications` and
`open 'example-studio://r/{token}'` — `tauri dev` does not fully exercise Mac scheme
registration.

**Windows / Linux:** the OS delivers the URL as argv to a new process;
single-instance forwards it into `on_open_url`. Linux AppImage (and Windows
debug) calls `register_all()` so a `.desktop` / protocol handler exists without
an extra launcher. Packaged Windows release uses installer protocol keys from
`tauri.conf.json` instead of `register_all()`, which can rewrite HKCU to a
stale exe path.

**iOS / Android (not built):** `plugins.deep-link.mobile` in
the generated Tauri overlay declares HTTPS + `/r/` + `/rec/` and the profile’s
custom-scheme fallback. `appLink` stays **false** until site-root AASA is
live; flip it to `true` then. A future adapter should navigate `gui/web` to
guest `/r/{token}`, not Safari and not a sidecar. Associated Domains /
site-root AASA remain ROADMAP — do not add the entitlement until that AASA
is live.

Universal Links, if used, are managed by the distributor's web deployment.

## Related

- [`gui/desktop/README.md`](../gui/desktop/README.md)
- [`docs/setup.md`](setup.md) — contributor bootstrap
- [`docs/extension-seams.md`](extension-seams.md) — FOSS collaboration vs hosted provider
- [`docs/host-online-relay.md`](host-online-relay.md) — self-host relay
- [`ROADMAP.md`](../ROADMAP.md) — CDN / sidecar / notarization rows
