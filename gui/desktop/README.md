# ShareCut Studio desktop (Tauri 2)

Native host shell for ShareCut Studio. **Does not rewrite the DAW** — it spawns the
existing FastAPI viewer (`podcast gui`) and, in **production**, waits until the
sidecar listen file, sock→pid ownership, and token-gated `/api/health` succeed,
then navigates the WebView to `http://127.0.0.1:<discovered-port>/`
(splash first — WebView2 otherwise sticks on connection-refused). `tauri dev`
still uses `devUrl` on :8765 (start `podcast gui` in another terminal).

## What ships in the `.app`

| In | Out |
|----|-----|
| Tauri window + this Rust crate | `podcast-relay` / Caddy / Terraform |
| Python sidecar (frozen CPython + `gui` extra + `web-dist`) | Node.js toolchain; torch / joinqc |
| Prebuilt `gui/web/dist` (served by FastAPI) | tests, docs sites |
| Bundled FFmpeg; optional first-run Whisper download | |

See [docs/desktop-packaging.md](../../docs/desktop-packaging.md).

## Dev

```bash
# Terminal A — API + SPA
uv sync --extra gui
cd gui/web && npm ci && npm run build && cd ../..
podcast gui --no-open

# Terminal B — native window (optional; browser also works)
cd gui/desktop && npm ci
# requires Rust + Xcode CLT (macOS) / WebView2 (Windows) / webkit2gtk (Linux)
npm run tauri -- dev
```

Contributor path without Tauri: open `http://127.0.0.1:8765/` in a browser.
`tauri dev` uses the bash [`binaries/sharecut-sidecar`](binaries/sharecut-sidecar) (or `podcast` on PATH).

Local MCP: with the DAW running, **Connect agent…** copies `http://127.0.0.1:<port>/mcp`
(the window origin; `:8765` for `podcast gui` / `tauri dev`).

## Local CI mirror

Same checks as the path-filtered GitHub `desktop` workflow (no installer):

```bash
# rustup component add rustfmt clippy   # once
make test-desktop
```

Optional full bundle (platform WebView deps required). Freezes the sidecar first.
Unsigned unless `APPLE_*` signing env vars are set — see
[desktop-packaging.md § Local codesign](../../docs/desktop-packaging.md#local-codesign-and-notarization):

```bash
make desktop-build
```

Windows NSIS + Linux AppImage + macOS Intel and Apple Silicon DMGs: iron Linux in Docker first
(`make desktop-linux-appimage-docker`), then GitHub **Actions → release-desktop → Run workflow**
(no push/PR/tag; installer CI is manual). Leave **sign** unchecked for unsigned
dogfood; check it only when Environment `desktop-signing` secrets exist (see
[desktop-packaging.md § CI signing funnel](../../docs/desktop-packaging.md#ci-signing-funnel)).
The Intel job is native `macos-15-intel` and the Apple Silicon job is native
`macos-15`; each checks `uname -m`, so neither is Rosetta-built. Download the
artifacts and upload to object storage; do not put object storage credentials or signing certs
in this repo. An operator can still build a notarized DMG locally with
`make desktop-build` on a Mac with `APPLE_*`.

## In-app updates

Builds whose distribution profile sets `updater_endpoint` and `updater_public_key` check for signed updates through `tauri-plugin-updater`. Profiles without them (the dev profile) register no plugin, no menu item, and make no update request.

- The Rust host injects the endpoint and key into the plugin config at startup (`updater::inject_config`); `tauri.conf.json` carries no `plugins.updater` block and no `bundle.createUpdaterArtifacts`. The updater bundle is signed after the build by `scripts/desktop/sign_updater_artifacts.sh`, so the build never sees the signing key.
- Everything runs natively from the **Check for Updates…** menu item (app menu on macOS, app menu on Linux, **Help** on Windows) and a quiet check after the engine passes health. The webview gets no updater command, so `capabilities/default.json`, the CSP, and `remote.urls` are unchanged.
- An update is never installed, and the app never relaunches for one, while the `sc_close_guard` marker is present or unreadable. The guard is read at click time, after the download, and inside the exit request. There is no override. Failures while the guard is active are logged, not shown, so no modal covers a recording. Decisions live in `src/update.rs`; `src/updater.rs` is the plugin glue.
- Flow: download and verify, re-check the guard, check the install folder is writable, stop the engine, install, relaunch. The engine is stopped before the swap on every platform; if the install then fails, the host starts the engine again on the old version and the item reads **Update failed — retry…** (only if that restart fails does the message say to restart the app). If a recording starts during the download, the install is skipped and the download discarded. On macOS the app or its folder must be owned by the current user. After files are replaced the menu item reads **Restart to Finish Update…**.
- If the install folder is not writable (a disk image, a translocated app, a read-only AppImage folder), the host does not self-install and shows a notice instead of the plugin's unbounded administrator prompt.
- The check has a 30 second timeout. The download has only connect and read-stall limits.
- Linux installs outside an AppImage (`.deb`/`.rpm`) only show a message that a new package is available.

## AppImage command line tools

Run the AppImage itself with `--cli <podcast arguments>` or `--mcp <podcast-mcp arguments>`. The native **Install Command Line Tools…** menu installs `~/.local/bin/podcast` and `podcast-mcp` wrappers that invoke the absolute AppImage path. The first successful engine launch offers this once. Keep the AppImage at that path, or use the menu to remove the wrappers before moving it and reinstall them afterward. Existing unrelated files and links are left alone.

## Deep links

- Review URLs stay **`https://sharecut.studio/r/{token}`** (browser-first for guests). Do not mint `sharecut://`-only links.
- Record URLs are **`https://sharecut.studio/rec/{token}`**.
- Custom schemes and exact HTTPS share origins come from the selected distribution profile. The host app opens the validated HTTPS URL in the system browser.
- Share tokens must use the current lowercase coolname slug format.
- Parse/allowlist is in `src-tauri/src/share_url.rs` (`ShareDeepLink.prefix`). Desktop open is `main.rs` + `tauri-plugin-shell`. macOS registration is config-only (`Info.plist`); Windows/Linux need the single-instance plugin so a second process is not spawned.
- Record microphone: `Info.plist` `NSMicrophoneUsageDescription` + `Entitlements.plist` `audio-input`. WebView handler (macOS `requestMediaCapturePermissionForOrigin`, Windows `PermissionRequested`) allows mic only for `http://127.0.0.1:{engine-port}` (`allow_engine_microphone` in `share_url.rs`). Linux/AppImage does not install that handler (WebKitGTK default prompt; record-in-browser is the supported guest path). Camera and deny-by-default WebView policy stay v1.

Desktop builds select a pinned prebuilt FFmpeg 9.0.2 pair under `sharecut-runtime/ffmpeg`. The shared importer admits the archive and verifies media capabilities and system-only linkage before fresh or reused freezes complete. The production target catalog pins each hosted archive and original manifest. See [desktop packaging](../../docs/desktop-packaging.md#bundled-native-audio-tools).
