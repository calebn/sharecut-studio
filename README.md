# Podcast MCP

FOSS podcast production toolkit: multitrack projects, per-track transcription, transcript-driven tightening, FFmpeg processing, a read-only DAW viewer, and agent skills under `.agents/`.

**Requirements:** Python 3.11+, [uv](https://github.com/astral-sh/uv) recommended (`install.sh` falls back to `.venv` + `pip`), and FFmpeg (system install or `podcast bootstrap`).

## Quick start

```bash
git clone <repo-url> && cd sharecut-studio
./install.sh
source .venv/bin/activate   # or: uv run podcast …
podcast doctor
# No system FFmpeg?  podcast bootstrap --component ffmpeg
# Whisper defaults to large-v3-turbo (~1.6 GB, first transcribe). Smaller: ./install.sh --whisper-model small.en
```

`./install.sh` installs a **contributor** set (`dev` + `gui` + `bootstrap` + `relay`) — not the heavy `speaker`/`joinqc` torch extras. Optional downloads and extras: [docs/setup.md](docs/setup.md#optional-downloads-and-extras).

Choose a downloaded Whisper model for one standalone transcription with `podcast transcribe --project … --model small.en`; use `podcast setup --whisper-model small.en` or `PODCAST_WHISPER_MODEL` to make that choice the machine default.

`podcast transcribe` reports the number of tracks processed by that run. When there are no dialogue tracks to process, it reports `Transcribed 0 track(s).` and warns on stderr.

No system FFmpeg? `podcast bootstrap --component ffmpeg` (included after `install.sh`) fetches FFmpeg into a local cache — same path on macOS, Linux, and Windows. See [docs/setup.md](docs/setup.md#any-os-no-package-manager-idiot-proof-path).

Agent config is tool-agnostic under [.agents/](.agents/) (skills, rules, MCP template). Register MCP per [docs/setup.md](docs/setup.md). With `podcast gui` running on loopback, **Connect agent…** (home or Menu) copies `http://127.0.0.1:8765/mcp` for URL-only clients. Use the `podcast-setup` skill when onboarding.

## Maximal install (all extras)

Use this only when you need enrollment speaker ID (`speaker` / `speaker-lite`) and/or neural join QC (`joinqc`). On Linux this pulls **multi‑GB** PyTorch/CUDA wheels (Docker clean-room: ~6 GB `.venv` + ~0.5 GB bootstrap cache). Prefer the Quick start above for everyday CLI/MCP/GUI work.

```bash
git clone <repo-url> && cd sharecut-studio
uv sync --all-extras
source .venv/bin/activate   # or: uv run …
podcast bootstrap --component all    # ffmpeg + whisper model + rnnoise (+ silero check)
podcast doctor
# Optional Sharecut Studio UI (needs Node 24+):
cd gui/web && npm ci && npm run build && cd ../..
```

Notes (verified in a disposable Linux Docker image):

- `uv sync --all-extras` installs every pip extra (`dev`, `gui`, `bootstrap`, `relay`, `object-store`, `speaker`, `speaker-lite`, `joinqc`).
- Expect CUDA-flavored `torch` on Linux even without a GPU; plan for several GB of free disk.
- `podcast bootstrap --component nisqa` is **opt-in** (not part of `--component all`). The default release URL may 404 — set `PODCAST_MCP_NISQA_MODEL` to an unpacked weights directory if you need neural NISQA.
- Without `uv`: `python3 -m venv .venv && .venv/bin/pip install -e ".[all]"` then the same bootstrap/doctor steps.

Detail: [docs/setup.md § Maximal install](docs/setup.md#maximal-install-all-extras).

## Repo layout

| Path | Purpose |
|------|---------|
| `src/podcast_mcp/` | Python package — CLI, MCP, services, domain, GUI API, Extensions SPI |
| `podcast_online` | Optional private/provider extension, installed independently when needed; its source is not part of this repository |
| `src/podcast_relay/` | FOSS reverse-tunnel edge (`podcast-relay`) |
| `gui/web/` | Sharecut Studio viewer (React + Vite) |
| `deploy/relay/` | FOSS host-online share relay (Docker Compose examples) |
| `contracts/` | Published caps / feature-id contract artifacts |
| `.agents/` | Skills, rules, MCP template, pipeline defaults |
| `docs/` | Architecture and feature docs |
| `tests/` | Pytest suite and fixtures (`aligned_dialogue`, …) |
| `schemas/` | `episode.project.json` JSON Schema |

## Episode workspace

```bash
podcast episode init --dir /path/to/my_episode
podcast track add --project /path/to/my_episode/episode.project.json --id host --file raw/host.wav --role dialogue
podcast pipeline run --project /path/to/my_episode/episode.project.json
```

**Read-only timeline viewer:**

```bash
uv sync --extra gui
cd gui/web && npm install && npm run build && cd ../..
podcast gui --project /path/to/my_episode/episode.project.json
```

Hot reload: `podcast gui --project … --dev --no-open` plus `cd gui/web && npm run dev`. Agents: MCP `open_gui_tool` / skill `podcast-open-gui` (or `podcast gui --background`). Details: [docs/gui-integration.md](docs/gui-integration.md#read-only-daw-viewer), [docs/setup.md](docs/setup.md#read-only-gui-viewer).

A clean clone needs no relay, account, object store, CDN, or signing credentials
for local editing. Before enabling collaboration or building a downstream desktop
distribution, validate only that mode’s configuration:

```bash
podcast config check --mode local
podcast config check --mode self-hosted --relay-config config/relay.example.yaml
podcast config check --mode distributor --distribution-profile /path/to/distribution.json
```

Runtime secrets belong in environment variables or
`~/.config/podcast_mcp/relay.yaml`; public desktop identity belongs in a validated
distribution profile. See [docs/setup.md](docs/setup.md#configuration-boundary).

## Documentation

- [Sharecut Studio Extensions](docs/extensions.md) — public plugin SPI (absent = no render); [seams](docs/extension-seams.md)
- [Host-online relay](docs/host-online-relay.md) — Docker share edge, tunnel, **capability-scoped remote MCP** (via the FOSS collaboration extension)
- [Recording session (design)](docs/recording-session.md) — record links, local WAV keepers, mix-minus monitor, consent
- [UX onboarding pack](ux/README.md) — shareable brief, screens, glossary, backlog ([live site](https://ux.sharecut.studio/); [See the UI](https://ux.sharecut.studio/#/demo))
- [Setup](docs/setup.md) — install, extras, optional downloads, MCP, bootstrap, play, GUI
- [Architecture](docs/architecture.md) — layers and timebase
- [Contributing](docs/contributing.md) — where new code goes; [Git workflow](docs/contributing.md#git-workflow) (feature branch → PR → `main`)
- [Agent instructions](AGENTS.md) — SOLID/DRY, tests-as-you-go, docs in sync
- [Episode format v2](docs/episode-format-v2.md) — canonical `episode.project.json` (see also [project-format.md](docs/project-format.md))
- [Multitrack ingest & alignment](docs/multitrack-ingest.md) — raw files → one track per speaker
- [Transcript workflow](docs/transcript-workflow.md) — reconcile → precorrect → refine → audition
- [Natural language editing](docs/nl-editing.md)
- [Inaudible cut boundaries](docs/inaudible-cuts.md)
- [Edit history / undo-redo](docs/history.md)
- [Session sync](docs/session-sync.md) — agent ↔ DAW transport
- [GUI integration](docs/gui-integration.md) — viewer API, layers, live reload
- [Social clips](docs/social-clips.md)
- [Timeline comments](docs/timeline-comments.md) — review feedback + action items (MCP/CLI/DAW)
- [Pipeline](docs/pipeline.md)
- [Testing](docs/testing.md)
- [Roadmap](ROADMAP.md)

## Support

Bugs: [GitHub Issues](https://github.com/calebn/sharecut-studio/issues/new?template=bug_report.yml). Attach a sanitized diagnostics zip from **Home → Help → Create diagnostics bundle** or `podcast doctor --bundle` (writes `~/Downloads/sharecut-diagnostics-<UTC>-<nonce>.zip`). Nothing is uploaded automatically — there is no telemetry. Do not attach episode audio or project JSON. Minted shares may transit the relay; GitHub issue attachments are public. Detail: [docs/setup.md § Troubleshooting](docs/setup.md#troubleshooting).

## Privacy

Beta policy (local audio unless you mint a share; relay is a pass-through that does not store audio but share audio/media may transit while the share is active; no telemetry): [sudo.science/privacy.html](https://sudo.science/privacy.html).

## Play audio (listen while developing)

```bash
podcast play --project tests/fixtures/aligned_dialogue/episode.project.json \
  --source processed:reference --start 0 --end 15   # edits + FX (stem or segment render)
podcast play --project ... --source track:guest --start 0 --end 15  # raw alignment
podcast play --project ... --compare --start 18 --end 28  # alignment check
podcast play --project ... --query documented   # after transcript is seeded
podcast play --project ... --dry-run            # extract WAV only; see "tier" in JSON
```

## Testing

Tests run with a **95% minimum coverage** gate (see [docs/testing.md](docs/testing.md)):

```bash
make test       # full suite + coverage gate (parallel)
make test-fast  # quick inner loop, no coverage
make e2e        # aligned_dialogue fixture; see docs/e2e-fixture-manual.md
```

GUI frontend unit tests (session dedupe, etc.): `cd gui/web && npm test`.

## License

MIT
