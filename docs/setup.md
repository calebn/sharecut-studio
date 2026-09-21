# Setup

## Requirements

- Python 3.11+
- FFmpeg and ffprobe — either a system install on `PATH` (fastest if you already
  have one), or fetched via `podcast bootstrap --component ffmpeg` (see below; works
  the same on macOS, Linux, and Windows, no package manager required)
- [uv](https://github.com/astral-sh/uv) (recommended; `install.sh` falls back to a plain `.venv` + `pip` if not present)
- For the Sharecut Studio viewer only: Node.js 24+ (npm) to build `gui/web`

## Full local install

Recommended contributor path (tests + GUI API + bootstrap FFmpeg helper + relay; **not** the heavy torch extras):

```bash
git clone https://github.com/calebn/sharecut-studio.git && cd sharecut-studio
./install.sh
# Optional: persist a smaller model, or download Whisper during install
# ./install.sh --whisper-model small.en
# ./install.sh --bootstrap-whisper
# PODCAST_WHISPER_MODEL overrides prefs.yaml (and the pipeline YAML default)
source .venv/bin/activate   # or prefix commands with: uv run
podcast doctor
```

`./install.sh` runs `uv sync --extra dev --extra gui --extra bootstrap --extra relay` when `uv` is available (pip fallback installs the same extras). It does **not** put `podcast` on your global `PATH` — use the venv or `uv run`.

If doctor reports missing FFmpeg:

```bash
# System package (preferred when available)
brew install ffmpeg          # macOS
# sudo apt install ffmpeg    # Debian/Ubuntu

# Or fetch a static build into the podcast cache (needs bootstrap extra — already in install.sh)
podcast bootstrap --component ffmpeg
podcast doctor
```

Optional next steps:

```bash
podcast bootstrap --component all          # ffmpeg + whisper model + rnnoise (+ silero check)
cd gui/web && npm ci && npm run build && cd ../..   # Sharecut Studio static assets
make hooks                                          # lint-staged + pre-push make ci gate (needs gui/web npm ci)
podcast gui --project /path/to/episode.project.json
```

## Maximal install (all extras)

For enrollment speaker ID and/or neural join QC, install **every** pip extra. This is much larger than `./install.sh` (Docker clean-room on Linux aarch64: ~6 GB `.venv` from CUDA-flavored `torch`, plus ~0.5 GB after `podcast bootstrap --component all`).

```bash
git clone https://github.com/calebn/sharecut-studio.git && cd sharecut-studio
uv sync --all-extras
source .venv/bin/activate   # or: uv run …
podcast bootstrap --component all
podcast doctor
# Optional Sharecut Studio UI (Node 24+):
cd gui/web && npm ci && npm run build && cd ../..
```

Smaller heavy subsets when you do not need everything:

```bash
uv sync --extra speaker          # torch + speechbrain
uv sync --extra speaker-lite     # resemblyzer (+ numba)
uv sync --extra joinqc           # torch + librosa + transformers
```

Without `uv`:

```bash
python3 -m venv .venv
.venv/bin/pip install -e ".[all]"
source .venv/bin/activate
podcast bootstrap --component all
podcast doctor
```

`podcast bootstrap --component nisqa` is opt-in only (not in `--component all`). The default GitHub release URL may 404; set `PODCAST_MCP_NISQA_MODEL` to an unpacked weights dir when using the neural joinqc path.

## Optional downloads and extras

### Pip extras

| Extra | Adds | When you need it |
|-------|------|------------------|
| *(core)* | typer, faster-whisper, mcp, … | Always — `uv sync` with no extras |
| `dev` | pytest, coverage, mypy, ruff, bandit, vulture, deptry | Running `make test` / `make lint-py` |
| `bootstrap` | `static-ffmpeg` | `podcast bootstrap --component ffmpeg` without a system FFmpeg |
| `gui` | fastapi, uvicorn, httpx, boto3, websockets | `podcast gui` / review share host |
| `relay` | fastapi, uvicorn, websockets | `podcast-relay` edge process |
| `object-store` | boto3 | Optional S3-compatible review media (also pulled by `gui`) |
| `speaker` | torch, speechbrain | Enrollment speaker attribution — **large** |
| `speaker-lite` | resemblyzer (+ numba floor) | Lighter speaker embeddings |
| `joinqc` | torch, librosa, transformers | Optional neural join continuity — **large** |
| `all` | union of runtime extras (not `dev`) | Same as `uv sync --all-extras` for product stacks; add `--extra dev` for tooling — expect multi‑GB torch/CUDA on Linux |

`./install.sh` installs `dev` + `gui` + `bootstrap` + `relay`. It deliberately skips `speaker` / `joinqc` / `all`.

### Bootstrap cache downloads (`podcast bootstrap`)

Assets land under `~/.cache/podcast_mcp/` (override with `PODCAST_MCP_CACHE`):

| Component | What it fetches | Needed for |
|-----------|------------------|------------|
| `ffmpeg` | Static `ffmpeg`/`ffprobe` via CDN when `PODCAST_BOOTSTRAP_CDN_BASE` is set **and** `sha256_by_platform` pins exist; otherwise `static-ffmpeg` | Everything if no system FFmpeg |
| `whisper` | A `faster-whisper` model (`--whisper-model large-v3-turbo` by default) | Required before pipeline/transcribe runs. Pipeline Run will not auto-download; use bootstrap, the Sharecut Studio first-run wizard, or the Pipeline picker. Smaller sizes (`tiny.en` … `medium.en`, `large-v3`) trade accuracy for disk. |
| `rnnoise` | An RNNoise `.rnnn` model | `noise_reduction_rnnoise` FX preset |
| `silero-vad` | Nothing — verifies the model bundled with `faster-whisper` | Optional VAD breath handling |
| `nisqa` | NISQA weights (**opt-in only**; not included in `--component all`) | Neural join QC with `joinqc` extra. Default GitHub release URL may 404; set `PODCAST_MCP_NISQA_MODEL` to an unpacked weights dir if needed |

Optional asset mirror: set `PODCAST_BOOTSTRAP_CDN_BASE` (public HTTPS base, no trailing slash) so FFmpeg/RNNoise try CDN object keys from [`contracts/bootstrap-assets.json`](../contracts/bootstrap-assets.json) before upstream fallbacks. CDN bytes are skipped until the matching `sha256` / `sha256_by_platform` pins are present. `GET /api/bootstrap/status` reports whether an environment override or non-null manifest `cdn_base_default` configured a mirror. Installer manifests and publishing configuration belong to the operator. Whisper still uses `faster-whisper` / Hugging Face until the mirror ships those weights.

```bash
podcast bootstrap --component all      # ffmpeg + whisper (large-v3-turbo) + rnnoise + silero check
podcast bootstrap --component whisper --whisper-model small.en
podcast setup --whisper-model medium.en   # persist without downloading
# Use another downloaded model for one standalone transcription run.
podcast transcribe --project /path/to/episode.project.json --model small.en
podcast bootstrap --component nisqa    # only when using joinqc neural path
```

### npm (Sharecut Studio viewer)

Not fetched by Python bootstrap. After the `gui` extra:

```bash
cd gui/web && npm ci && npm run build
```

Produces `gui/web/dist/` (`index.html` + assets). Required for `podcast gui` HTML UI; CLI/MCP editing works without it.

The development-only component catalog uses the same frontend dependencies:

```bash
cd gui/web && npm ci
npm run storybook        # local catalog on :6006
npm run build-storybook  # static storybook-static/
```

See [design-system.md](design-system.md) for story conventions and the GitHub
Pages prerequisite. Storybook is separate from the app and desktop bundles.

### Sharecut Studio first-run (GUI)

On the host home screen (no `?project=`), Sharecut Studio checks `GET /api/bootstrap/status`
and can download FFmpeg + Whisper via `POST /api/bootstrap/run` (progress on
`GET /api/bootstrap/events` — same progress plane as pipeline jobs; see [progress.md](progress.md)). The wizard lets you pick a Whisper size; default is
**large-v3-turbo** (lowest practical WER, ~1.6 GB). Same assets as `podcast bootstrap`;
torch extras are not offered in the UI. Contributor CLI path is unchanged.

Native window (optional): [`gui/desktop/`](../gui/desktop/) — see
[desktop-packaging.md](desktop-packaging.md). Local CI mirror:
`make test-desktop` (needs rustup + rustfmt/clippy); full installer:
`make desktop-build` (freezes sidecar; unsigned unless `APPLE_*` env is set).
Win/Linux/mac-x64 installers are produced by the reusable `release-desktop-build.yml` workflow. A caller repository supplies an immutable source SHA and may set `sign=true` only when its `desktop-signing` environment is complete; unsigned dogfood callers leave signing disabled.

## macOS (or any OS with a package manager)

```bash
brew install ffmpeg
./install.sh
source .venv/bin/activate
podcast doctor
```

## Any OS, no package manager (idiot-proof path)

Skip the system FFmpeg install entirely and let the app fetch what it needs:

```bash
./install.sh                         # includes bootstrap extra when using the default install
source .venv/bin/activate
podcast bootstrap --component ffmpeg # or: podcast bootstrap --component all
podcast doctor
```

From a pip-only env without `install.sh`:

```bash
pip install "podcast-mcp[bootstrap]"   # or: uv sync --extra bootstrap
podcast bootstrap                       # fetches ffmpeg/ffprobe + whisper model
podcast doctor
```

Resolution order for FFmpeg at runtime is: `PODCAST_MCP_FFMPEG`/`PODCAST_MCP_FFPROBE`
env override → a system install on `PATH` → the bootstrapped copy in the cache
dir → (if truly nothing is found) the literal `ffmpeg`/`ffprobe` command name,
so upgrading FFmpeg is as simple as `brew upgrade ffmpeg` (system takes
precedence) or `podcast bootstrap --component ffmpeg --upgrade` (bumps the
pinned `static-ffmpeg` package's bundled build).

## Reproducible installs

All Python dependencies are declared in [pyproject.toml](../pyproject.toml) (the
equivalent of `package.json`) and pinned exactly in [uv.lock](../uv.lock) (the
equivalent of `package-lock.json`). Nothing the codebase imports should ever rely on a
package that merely *happens* to be present in some other environment (e.g. a
system/base Python) — every third-party import is declared here.

```bash
# Match install.sh (recommended contributor set)
uv sync --extra dev --extra gui --extra bootstrap --extra relay

# Everything including speaker + joinqc (large torch/CUDA wheels on Linux)
uv sync --all-extras

uv run make test       # or: .venv/bin/pytest
```

`uv sync` (no flags) installs only the core runtime dependencies. See [Optional downloads and extras](#optional-downloads-and-extras) for the full extras table.

Note: transcription (`faster-whisper`, core dependency) already ships
`onnxruntime` and a bundled Silero VAD model. Whisper **weights** are not
auto-pulled by pipeline Run or transcription — download them via
`podcast bootstrap --component whisper`, the Sharecut Studio first-run wizard, or
the Pipeline picker before running those steps. Neither needs a speaker
extra. `torch`/`speechbrain` are only for the optional enrollment-based
speaker ID workflow; a fully functional install (transcribe, tighten, mix,
master, export) needs none of `speaker`, `speaker-lite`, or `bootstrap` if
system FFmpeg is on `PATH` (Whisper weights still required for ASR).

Regenerate the lock file after changing `pyproject.toml` dependencies:

```bash
uv lock
```

Without `uv`, `install.sh` creates a plain `.venv` and runs
`pip install -e ".[dev,gui,bootstrap,relay]"`. Add speaker/joinqc manually if needed:
`pip install -e ".[speaker,joinqc]"`.

## MCP and agents

After `./install.sh`, use `source .venv/bin/activate` (or `uv run`) so `podcast` /
`podcast-mcp` resolve. Agent config lives under [.agents/](../.agents/):

| Path | Purpose |
|------|---------|
| [mcp.json](../.agents/mcp.json) | MCP server entry for your client |
| [rules/engineering-standards.md](../.agents/rules/engineering-standards.md) | SOLID/DRY, tests, docs |
| [rules/git-workflow.md](../.agents/rules/git-workflow.md) | Feature branch → PR → `main` |
| [rules/gui-styling.md](../.agents/rules/gui-styling.md) | Theme tokens, rem, `@container`, consent-gated CSS exceptions |
| [skills/](../.agents/skills/) | Episode workflows |

Clients that load project agents from `.agents/` (including Cursor) pick up rules, skills, and MCP from there. Reload MCP after install if your IDE was already open. Point the MCP `command` at the venv binary if the client does not inherit your shell PATH (e.g. `.venv/bin/podcast-mcp`).

**Connecting an external agent?** Copy-paste configurations for Claude Code,
Claude Desktop, Cursor, Windsurf, and Cline: [mcp-setup.md](mcp-setup.md).

**Local GUI URL (recommended when the DAW is open):** run `podcast gui`, open an episode (or **Connect agent…** on home to copy the URL first), **Menu → Connect agent…**, and paste `http://127.0.0.1:8765/mcp` as a Streamable HTTP MCP URL (same shape as Figma desktop). Keep the GUI running. Host MCP is loopback-only. Details: [gui-integration.md](gui-integration.md) § Local host MCP.

## Global skills (optional)

```bash
podcast setup --global-skills
```

Symlinks `.agents/skills/*` into `~/.agents/skills/` for clients that only read a global skills directory.

## Cache

All bootstrapped/downloaded assets live under `~/.cache/podcast_mcp/`
(override the base with `PODCAST_MCP_CACHE`):

| Path | Contents |
|------|----------|
| `whisper/` | `faster-whisper` model weights |
| `prefs.yaml` | Machine Whisper model preference (setup / bootstrap / first-run wizard) |
| `bin/` | Bootstrapped `ffmpeg`/`ffprobe` (only if no system install was found) |
| `models/` | Bootstrapped model assets (RNNoise `.rnnn`; optional NISQA dir) |

Nothing here is committed to the git repo or bundled in the installed
package — fetch via `podcast bootstrap` (or the Sharecut Studio wizard / Pipeline
picker for Whisper). Pipeline Run and transcription do not auto-download
Whisper weights. Keeping assets out of the package/repo is what keeps both
small.

## Play segments

Audition timeline ranges or transcript matches:

```bash
# Processed solo track (edits + FX; uses stem if fresh and not longer than timeline,
# else segment render). Play-cache keys include stem mtime so reassemble invalidates extracts.
podcast play --project /path/to/episode.project.json --source processed:host --start 0 --end 10

# Raw source (alignment checks, no FX)
podcast play --project ... --source track:host --start 0 --end 10

# Full mix (requires render-preview or --rerender)
podcast play --project ... --source premix --start 30 --end 45 --rerender

podcast play --project ... --query "keyword" --padding 1.5
# Captions + clip-skew / stem freshness before audition (timeline seconds)
podcast play context --project ... --start 924 --end 930
podcast play context --project ... --start 924 --end 930 --detail visual

# Before/after history A/B (extract both first, play A→gap→B in one shot; default gap 0.4s)
podcast play ab --project ... --before-index 53 --after-index 55 \
  --source processed:host --start 74 --end 83 --gap 0.4
```

Use `--dry-run` to write `artifacts/play_cache/*.wav` without opening a player (`afplay` on macOS, `ffplay` elsewhere). Response JSON includes `tier`: `raw`, `stem`, `segment_render`, `premix`, or `ab_concat` (history/WAV A/B).

## Sharecut Studio Extensions (self-hosted collaboration / optional provider)

Share, record, remote-MCP, and guest `/r/{token}` routes load through the public [Extensions API](extensions.md). The FOSS `collaboration` extension is enabled by default and does not require an account. A separately installed `online` provider extension can add account/auth surfaces.

```bash
# Pure local Sharecut Studio (no share routes, no share MCP mint tool, no `podcast review share*`)
export PODCAST_EXTENSIONS=
podcast gui --project episode.project.json

# FOSS self-hosted collaboration only
export PODCAST_EXTENSIONS=collaboration

# Provider build (provider package installed separately)
export PODCAST_EXTENSIONS=collaboration,online
```

See [extension-seams.md](extension-seams.md). Self-host relay: [host-online-relay.md](host-online-relay.md) (`podcast-relay` package).

## Configuration boundary

Local editing works without a relay, service account, object store, CDN, or
distribution profile. Configuration is split by responsibility:

| Mode | You provide | Sharecut/FOSS provides |
|------|-------------|------------------------|
| Local | Project files and optional machine preferences | Loopback GUI, editing, pipeline, export, development desktop profile |
| Self-hosted collaboration | Relay domain/TLS, strong host token, and optionally an S3-compatible store | Relay/tunnel protocol, guest UI, local media-proxy fallback, redacted example |
| Desktop distributor | Public identity/trust profile plus private signing and deployment credentials | Validated schema, Tauri overlay generator, reusable build scripts |

Host runtime configuration lives at `~/.config/podcast_mcp/relay.yaml`; copy
[`config/relay.example.yaml`](../config/relay.example.yaml). Relay-field precedence
is explicit CLI/API argument, environment, YAML, then a safe loopback default.
Object-store precedence is environment, YAML, then disabled. The only
object-store environment names are
`PODCAST_OBJECT_STORE_ENDPOINT_URL`, `PODCAST_OBJECT_STORE_REGION`,
`PODCAST_OBJECT_STORE_BUCKET`, `PODCAST_OBJECT_STORE_ACCESS_KEY_ID`,
`PODCAST_OBJECT_STORE_SECRET_ACCESS_KEY`, and optional
`PODCAST_OBJECT_STORE_CDN_ENDPOINT`. Omitting the block keeps media on the host
and proxies it through the tunnel.

Desktop identity is build-time public data. Copy
[`config/distribution.dev.json`](../config/distribution.dev.json), keep it free
of credentials, and set `PODCAST_DISTRIBUTION_PROFILE` while building. The
profile controls product name, bundle identifier, custom schemes, exact HTTPS
share origins, support/privacy/repository URLs, release manifest URL, and the
optional bootstrap CDN base. Rust and Tauri consume generated values from the
same file; the Tauri host injects the public support, privacy, repository, and
release-manifest values into its Python sidecar. Sidecar links accept only public
HTTPS URLs and do not read relay configuration or preferences. Unlisted HTTPS
origins remain rejected.

Validate a mode without contacting any service or printing credentials:

```bash
podcast config check --mode local
podcast config check --mode self-hosted --relay-config ~/.config/podcast_mcp/relay.yaml
podcast config check --mode distributor --distribution-profile ./distribution.json
```

Local mode does not require a distribution profile, so it also works from an
installed wheel that does not include the contributor development profile. Pass
`--distribution-profile` to local mode only when you want that explicit profile
validated.

## Read-only GUI viewer

Install the optional `gui` extra (included in `./install.sh`), build the web UI once, then launch:

```bash
cd gui/web && npm ci && npm run build && cd ../..
podcast gui --project /path/to/episode.project.json
# or background (same as MCP open_gui_tool):
podcast gui --project /path/to/episode.project.json --background
# loopback without --project opens New/Open home (Pass 8)
# Browse… / Mod+O use a host OS file dialog (paste path still works)
podcast gui
```

Agents can call MCP `open_gui_tool` (skill `podcast-open-gui`) instead of blocking on a foreground server.

Development with hot reload:

```bash
# Terminal 1 — API on :8765
podcast gui --project /path/to/episode.project.json --dev --no-open
# or: podcast gui --dev --no-open   # New/Open home on loopback

# Terminal 2 — Vite on :5173 (proxies /api to :8765)
cd gui/web && npm run dev
```

Open `http://127.0.0.1:5173/?project=/absolute/path/to/episode.project.json` (or omit `?project=` for host New/Open).

See [gui-integration.md](gui-integration.md) for layout, ingest, API details, and **local host MCP** (`http://127.0.0.1:8765/mcp`).

### Public review share (optional)

Default bind is loopback (`127.0.0.1`). Prefer the **host-online Docker relay** so you do not bind the laptop publicly — [host-online-relay.md](host-online-relay.md).

LAN-only alternative (prefer the relay when possible):

```bash
export PODCAST_REVIEW_CORS_ORIGINS=https://your-origin.example
# Binding off-loopback auto-enables PODCAST_SESSION_AUTHZ=strict and generates
# PODCAST_SESSION_TOKEN if unset; open the printed URL (includes session_token).
podcast gui --host 0.0.0.0 --port 8765 --project episode.project.json
podcast review publish-version --project episode.project.json --label "Guest v1"
podcast review share --project episode.project.json --version <id> \
  --role commenter --base-url http://YOUR_HOST:8765
```

The global share index / registry is written mode `0600` (see [share-tokens.md](share-tokens.md)).

Guests use `/r/{token}` or `/rec/{token}` only (no `?project=` paths). Use `--role viewer` (or `--capabilities play,view`) for Sharecut Studio; default commenter gets ReviewApp. Mint a recording room with `--kind record` (prints guest + producer `/rec/` URLs). Grant `--with-mcp` for capability-scoped remote MCP at `{base}/mcp/{token}/mcp` — host needs `PODCAST_REMOTE_MCP=1` and usually `podcast tunnel`. (`/r/{token}/mcp` is an accepted alias of the MCP bridge.) Restricted ACL + Google/GitHub login: [share-tokens.md](share-tokens.md) § Identity. See [timeline-comments.md](timeline-comments.md) § Public review share and [host-online-relay.md](host-online-relay.md) § Remote MCP. Share/MCP traffic is rate-limited by default (generous budgets; `PODCAST_RATE_LIMIT=0` / `PODCAST_RELAY_RATE_LIMIT=0` to disable) — see [host-online-relay.md](host-online-relay.md) § Rate limiting.

```bash
PODCAST_REMOTE_MCP=1 podcast gui --project episode.project.json --no-open
podcast review share --project episode.project.json --version <id> \
  --role commenter --with-mcp \
  --base-url https://share.example.com
# Cursor: { "mcpServers": { "podcast-remote": { "url": "<printed MCP URL>" } } }
# Claude.ai: Connectors → paste MCP URL (/mcp/{token}/mcp), leave OAuth blank (authless)
```

## Troubleshooting

If Sharecut Studio or `podcast` misbehaves, create a **sanitized diagnostics zip** on your machine and attach it to a support request. Nothing is uploaded automatically — there is **no telemetry**. Opt-in automatic submission to the configured support provider is Follow-up; crash-time phone-home is not planned.

```bash
podcast doctor --bundle            # writes ~/Downloads/sharecut-diagnostics-<UTC>-<nonce>.zip
podcast doctor --bundle --out DIR  # optional output directory
# prints the zip path and configured support URL; `--open` opens it in a browser
```

In the app: **Home → Help → Create diagnostics bundle**. The dialog shows the zip path (reveal it in your file manager) and **Open support**.

The zip includes doctor results, versions, a sidecar log tail, and counts (tracks/clips/decisions/comments) — not audio, transcripts, project JSON, share tokens, or `shares.json` / `sync.db`. Guests / share links cannot create a bundle (host-only).

Creating the zip runs doctor checks and (when a project is open) per-track timebase QC, then packs a log tail. On a large episode that can take tens of seconds; wait for the Help button to leave **Creating…** or for the CLI to print the path. The host API runs the work in a worker thread. Help uses a local busy label — it is not a StatusBar/SSE job.

The zip filename is `sharecut-diagnostics-<UTC>-<nonce>.zip` so two bundles in the same second do not overwrite. Host Help shows the local filesystem path so you can attach the file; that path is not uploaded. `GET /api/diagnostics/bundle/{name}` only serves zips registered by a POST in this Studio process.

Redaction replaces home, workspace, and cache roots (`PODCAST_MCP_CACHE`) plus share URL segments after `/r/` and `/rec/` (coolname slugs, including connector words, and legacy `token_urlsafe` values). Bare coolnames in free text are not scrubbed. There is no dry-run: **Create** always writes the zip (`include_logs` only toggles members). Bundle shape is locked by `DiagnosticsService` and tests (no separate `contracts/` schema).
