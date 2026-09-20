# Sharecut Studio desktop (Tauri 2)

Native host shell for Sharecut Studio. **Does not rewrite the DAW** — it spawns the
existing FastAPI viewer (`podcast gui`) and, in **production**, waits until the
sidecar listen file, sock→pid ownership, and token-gated `/api/health` succeed,
then navigates the WebView to `http://127.0.0.1:<discovered-port>/`
(splash first — WebView2 otherwise sticks on connection-refused). `tauri dev`
still uses `devUrl` on :8765 (start `podcast gui` in another terminal).

## What ships in the `.app`

| In | Out |
|----|-----|
| Tauri window + this Rust crate | `podcast-relay` / Caddy / Terraform |
| Python sidecar (frozen CPython + `gui` extra + `web-dist`) | Node.js toolchain; torch / speaker / joinqc |
| Prebuilt `gui/web/dist` (served by FastAPI) | tests, docs sites |
| Optional first-run FFmpeg / Whisper (CDN or Hub) | |

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

Windows NSIS + Linux AppImage + macOS Intel DMG: iron Linux in Docker first
(`make desktop-linux-appimage-docker`), then GitHub **Actions → release-desktop → Run workflow**
(no push/PR/tag; installer CI is manual). Leave **sign** unchecked for unsigned
dogfood; check it only when Environment `desktop-signing` secrets exist (see
[desktop-packaging.md § CI signing funnel](../../docs/desktop-packaging.md#ci-signing-funnel)).
The Intel job is native `macos-15-intel` (not Rosetta on arm64). Download the
artifacts and upload to object storage; do not put object storage credentials or signing certs
in this repo. Apple Silicon notarized DMGs can stay `make desktop-build` on a
Mac with `APPLE_*`.

## Deep links

- Review URLs stay **`https://sharecut.studio/r/{token}`** (browser-first for guests). Do not mint `sharecut://`-only links.
- Record URLs are **`https://sharecut.studio/rec/{token}`**.
- Custom schemes and exact HTTPS share origins come from the selected distribution profile. The host app opens the validated HTTPS URL in the system browser.
- Share tokens must use the current lowercase coolname slug format.
- Parse/allowlist is in `src-tauri/src/share_url.rs` (`ShareDeepLink.prefix`). Desktop open is `main.rs` + `tauri-plugin-shell`. macOS registration is config-only (`Info.plist`); Windows/Linux need the single-instance plugin so a second process is not spawned.
- Record microphone: `Info.plist` `NSMicrophoneUsageDescription` + `Entitlements.plist` `audio-input`. WebView handler (macOS `requestMediaCapturePermissionForOrigin`, Windows `PermissionRequested`) allows mic only for `http://127.0.0.1:{engine-port}` (`allow_engine_microphone` in `share_url.rs`). Linux/AppImage does not install that handler (WebKitGTK default prompt; record-in-browser is the supported guest path). Camera and deny-by-default WebView policy stay v1.
