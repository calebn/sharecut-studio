---
name: podcast-setup
description: >-
  Onboard a new machine or contributor to Podcast MCP. Use when setting up the
  repo, installing FFmpeg, registering MCP, or verifying podcast doctor passes.
---

# Podcast MCP setup

## Prerequisites

- Python 3.11+
- FFmpeg and ffprobe — a system binary (`brew install ffmpeg` / `apt install ffmpeg`),
  or `podcast bootstrap --component ffmpeg` for a static build (no package manager)
- [uv](https://github.com/astral-sh/uv) (recommended — `pip install uv` if not already on PATH)
- Node.js 24+ only if building the Sharecut Studio viewer (`gui/web`)

## Steps

1. From the repo root:

```bash
./install.sh
# Optional smaller model: ./install.sh --whisper-model small.en
source .venv/bin/activate   # or: uv run …
# Heavy torch extras (speaker / joinqc) are NOT included — see Optional downloads below.
```

`./install.sh` runs `uv sync --extra dev --extra gui --extra bootstrap --extra relay`
(or the same extras via pip without `uv`). Details:
[docs/setup.md](../../../docs/setup.md#full-local-install).

For a **maximal** install (speaker + joinqc + everything; multi‑GB torch/CUDA on Linux):

```bash
uv sync --all-extras
source .venv/bin/activate
podcast bootstrap --component all
podcast doctor
```

See [docs/setup.md § Maximal install](../../../docs/setup.md#maximal-install-all-extras) and the README.

2. Verify:

```bash
podcast doctor
make test
```

CI and local pytest enforce **95% minimum coverage** (see `docs/testing.md`).

2b. No system FFmpeg (or want a fully offline-ready cache up front)?

```bash
podcast bootstrap --component ffmpeg
# or: podcast bootstrap --component all   # + whisper model + rnnoise
```

See [docs/setup.md](../../../docs/setup.md#optional-downloads-and-extras) for
pip extras, bootstrap components, and npm.

3. MCP and agent config: clients load [.agents/mcp.json](../../mcp.json),
[rules/engineering-standards.md](../../rules/engineering-standards.md),
[rules/git-workflow.md](../../rules/git-workflow.md), and [skills](../../skills/)
from this repo. Use the venv’s `podcast-mcp` if the IDE does not see `.venv/bin`.
Reload MCP after install if your IDE was already open.

4. Optional global skills:

```bash
podcast setup --global-skills
```

5. Optional Sharecut Studio UI:

```bash
cd gui/web && npm ci && npm run build && cd ../..
podcast gui --project /path/to/episode.project.json
```

On first open of the host home screen (no project), Sharecut Studio can download FFmpeg +
Whisper via the GUI bootstrap wizard (`/api/bootstrap/*`) — same as
`podcast bootstrap`, without a terminal. Default speech model is **large-v3-turbo**;
the wizard (and `./install.sh --whisper-model` / `podcast setup --whisper-model`)
can pick a smaller size.

Optional native window: see `gui/desktop/` and `docs/desktop-packaging.md`.

6. Create a first episode workspace:

```bash
podcast episode init --dir /path/to/my_episode
podcast track add --project /path/to/my_episode/episode.project.json \
  --id host --file /path/to/host.wav --role dialogue --speaker Host
```

## Optional downloads

| Kind | What | Required for core CLI? |
|------|------|------------------------|
| `bootstrap` ffmpeg | Static ffmpeg/ffprobe in cache | Only if no system FFmpeg |
| `bootstrap` whisper / rnnoise | Model cache (`large-v3-turbo` default) | Whisper required before pipeline/transcribe Run (no silent download) |
| `bootstrap` nisqa | Neural join QC weights (opt-in; default URL may 404 — use `PODCAST_MCP_NISQA_MODEL`) | No |
| pip `speaker` / `joinqc` | torch (+ CUDA wheels on Linux) — **large** | No — `uv sync --all-extras` or per-extra |
| npm `gui/web` | `node_modules` + `dist` | No — only for Sharecut Studio HTML UI |

## Code standards

When changing this repository’s Python code, follow [AGENTS.md](../../AGENTS.md),
[rules/engineering-standards.md](../../rules/engineering-standards.md), and
[rules/git-workflow.md](../../rules/git-workflow.md) (SOLID/DRY, tests with every
change, feature branch → PR → `main`, keep README/docs/skills in sync,
`make test` ≥95% coverage).

## Agent skills (natural language)

After MCP is connected, these skills guide LLM clients:

- `podcast-edit-natural-language` — transcript search, cuts, approve, preview
- `podcast-timeline-comments` — review comments + action items (MCP/CLI work queue)
- `podcast-open-gui` — start the DAW viewer via `open_gui_tool`
- `podcast-social-clips` — propose/export short clips (audio; video TODO)
- `podcast-tighten-dialogue`, `podcast-pipeline-run`, `podcast-history`, etc.

See `docs/nl-editing.md`, `docs/timeline-comments.md`, `docs/inaudible-cuts.md`, and `docs/social-clips.md`.

## Defaults

Pipeline thresholds live in `.agents/defaults/pipeline.yaml`. Skills reference those values; change them to tune behavior repo-wide.

## Troubleshooting

See `docs/setup.md`. If `podcast` is not found, activate `.venv` or use `uv run`.
If transcription fails, confirm `faster-whisper` is installed and the cache dir is
writable (`~/.cache/podcast_mcp`). For bug reports, `podcast doctor --bundle`
(or Home → Help) writes a sanitized zip — nothing is uploaded.
