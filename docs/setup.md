# Setup

## Requirements

- Python 3.11+
- A matching FFmpeg and FFprobe 9.0.2 or later 9.x pair for source installs. Desktop releases include the pinned 9.0.2 pair.
- [uv](https://github.com/astral-sh/uv) (recommended; `install.sh` falls back to a plain `.venv` + `pip` if not present)
- For the ShareCut Studio viewer only: Node.js 24+ (npm) to build `gui/web`

## Full local install

Recommended contributor path (tests + GUI API + relay + prosody; **not** the heavy torch extras):

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

`./install.sh` runs `uv sync --extra dev --extra gui --extra relay --extra prosody` when `uv` is available (pip fallback installs the same extras). It does **not** put `podcast` on your global `PATH` — use the venv or `uv run`.

The `dev` extra requires `coverage[toml]>=7.16.2`; `uv.lock` pins coverage 7.16.2.
Uvicorn's standard extra resolves uvloop 0.23.0 on its existing supported platforms;
this fixes its deprecated coroutine check on Python 3.14 while retaining `auto` loop selection.
To reproduce the required Python CI runtime in an isolated checkout, run:

```bash
uv sync --python 3.14 --extra dev --extra gui --extra relay --extra prosody
COVERAGE_CORE=ctrace uv run --no-sync make test
```

For a packaged Sharecut Studio app on macOS, Linux `.deb`, or AppImage, use the native app menu's **Install Command Line Tools…** to install `podcast` and `podcast-mcp` in `~/.local/bin`. The app offers this once after its first successful engine start. Add `~/.local/bin` to your shell PATH if the app reports it missing. The same menu removes only commands owned by this app. AppImage installs wrappers that call the absolute `.AppImage` path, so keep the AppImage at that path; before moving it, remove the wrappers, then install again from the new path. You can also run `SharecutStudio.AppImage --cli <podcast arguments>` or `SharecutStudio.AppImage --mcp <podcast-mcp arguments>` directly.

The core install includes `filelock` to coordinate transcript-refine status
decisions between local pipeline, CLI, and MCP processes.

If doctor reports missing or unsupported FFmpeg, install a matching supported pair
or use the [prebuilt importer](#acquire-the-pinned-ffmpeg-pair). Run `podcast doctor`
again after setting the executable paths.

Optional next steps:

```bash
podcast bootstrap --component all
cd gui/web && npm ci && npm run build && cd ../..   # ShareCut Studio static assets
make hooks                                          # lint-staged + check-only pre-commit hooks
make worktree-setup                                 # per git worktree: hooks + venv (incl. pre-commit) + gui/web node_modules
podcast gui --project /path/to/episode.project.json
```

The pre-commit hook and `make worktree-setup` source `scripts/node-env.sh`, which puts the Node major pinned in `.nvmrc` first on `PATH` from nvm's install tree (`$NVM_DIR/versions/node`). Shells that don't load nvm, such as git hooks and agent shells, still get the pinned Node instead of an older default. If that version isn't installed, the script warns; run `nvm install` in the repo.

The opt-in editor profiler also needs the Playwright Chromium install:

```bash
npm --prefix gui/web run test:e2e:install
npm --prefix gui/web run profile:remaining -- --preset small --out /tmp/editor-profile
```

Run GUI browser scenarios through the npm E2E wrapper, which owns private registry
and identity files. `make ux-demo-screens` copies the existing showcase fixture and
prepares guest shares in the same invocation. Run `make ux-demo` separately when
you want to rebuild that fixture.

`profile:remaining` builds disposable media fixtures and serves the production
GUI; `profile:compare` freezes or applies worker-specific diagnostic budgets.
See [editor responsiveness profiling](testing-e2e.md#large-project-browser-profile-opt-in)
for independent repetitions, retained evidence, and cold-cache limits.
`make profile-seek-trim OUT=/tmp/seek-trim` runs the two-task
[seek and trim profile](testing-e2e.md#seek-and-trim-profile-opt-in) and prints a
summary table.

## Maximal install (all extras)

For enrollment speaker ID and/or neural join QC, install **every** pip extra. This is much larger than `./install.sh` (Docker clean-room on Linux aarch64: ~6 GB `.venv` from CUDA-flavored `torch`, plus ~0.5 GB after `podcast bootstrap --component all`).

```bash
git clone https://github.com/calebn/sharecut-studio.git && cd sharecut-studio
uv sync --all-extras
source .venv/bin/activate   # or: uv run …
podcast bootstrap --component all
podcast doctor
# Optional ShareCut Studio UI (Node 24+):
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

## Frontend exporter dependencies

CI's `frontend-suite` uses the `frontend-exporters` dependency group in
`pyproject.toml`. Its five roots share the project's constraints, and `uv.lock`
pins their transitive dependencies. The shared installer selects this group with
`environment: frontend-exporters`, installs the locked export, validates its
closure, and skips editable project installation. The four generated-file checks
run against checked-out source after `npm ci`. Contributor installs and browser
suites keep their existing extras. See [locked Python installation](testing-ci.md#locked-python-installation).
CI places pytest, browser, and extras temporary work in [private disk temporary storage](testing-ci.md#temporary-storage), admitted by the production privacy guard.

## Optional downloads and extras

### Pip extras

| Extra | Adds | When you need it |
|-------|------|------------------|
| *(core)* | typer, faster-whisper ≥ 1.1 (VAD, `hotwords`, `hallucination_silence_threshold`), PyAV ≥ 11 and < 19 (faster-whisper 1.2.1 passes `metadata_errors` to `av.open`, which PyAV 19 rejects), mcp ≥ 2.2 and < 3 (`mcp/args.py`, `mcp/tool_errors.py` and `gui/host_mcp.py` rely on SDK internals; their client tests catch drift on a minor bump), onnxruntime + huggingface-hub ≥ 2.0 (its `httpx2` HTTP stack; used by forced alignment when its optional model is installed), … | Always — `uv sync` with no extras |
| `dev` | pytest, coverage, mypy, ruff, bandit, vulture, deptry, pre-commit | Running `make test` / `make lint-py` and check-only commit hooks |
| `gui` | fastapi ≥0.116.1, starlette ≥0.47, anyio ≥4, uvicorn, httpx, boto3, websockets ≥14 | `podcast gui` / review share host |
| `relay` | fastapi ≥0.116.1, starlette ≥0.47, uvicorn, websockets ≥14 | `podcast-relay` edge process |
| `object-store` | boto3 | Optional S3-compatible review media (also pulled by `gui`) |
| `speaker` | torch, speechbrain | Enrollment speaker attribution — **large** |
| `speaker-lite` | resemblyzer (+ numba floor) | Lighter speaker embeddings. Resemblyzer's `webrtcvad` dependency imports `pkg_resources`, which setuptools 82 removed, so `engines/speaker_id.py` loads `VoiceEncoder` with a placeholder `webrtcvad`, used only when the real `webrtcvad` fails to import (only `preprocess_wav`'s silence trimming uses it, and the backend never calls that); the extra needs no `setuptools` pin (#1284) |
| `joinqc` | torch, librosa, transformers | Optional neural join continuity — **large** |
| `prosody` | `praat-parselmouth` (Praat in Python; no torch) | `analyze_prosody` pipeline step / `audition_context` prosody window — [pipeline.md § Prosody profile](pipeline.md#prosody-profile) |
| `all` | union of runtime extras (not `dev`) | Same as `uv sync --all-extras` for product stacks; add `--extra dev` for tooling — expect multi‑GB torch/CUDA on Linux |

`./install.sh` installs `dev` + `gui` + `relay` + `prosody`. It deliberately skips `speaker` / `joinqc` / `all`.

Without `speaker` or `speaker-lite` (an `install.sh` checkout and the packaged app) the speaker commands, the Split speakers dialog and the pipeline's speaker pass report `speaker_backend_unavailable` / "speaker extra not installed" rather than running on the development mock; `audition_context` leaves `speaker_roles` out. Set `PODCAST_SPEAKER_BACKEND=mock` only to develop against the mock; Split speakers still refuses it (#1999).

**Clean-install check.** `pip install "podcast-mcp[extra]"` ignores `uv.lock`, so an extra can break on a newer transitive release while a locked `uv sync` still works (#1168). `tests/test_extras_import.py` builds a fresh unlocked venv per extra, installs the project with it, and imports the modules the code uses. It is opt-in because it downloads wheels. The path-filtered, weekly `extras-import` workflow runs it; run one extra locally with:

```bash
PODCAST_CHECK_EXTRAS=1 uv run pytest --no-cov -k speaker-lite tests/test_extras_import.py
```

A new extra must be added to `EXTRA_IMPORTS` in that file; a fast test fails otherwise.

### Bootstrap cache downloads (`podcast bootstrap`)

Assets land under `~/.cache/podcast_mcp/` (override with `PODCAST_MCP_CACHE`):

| Component | What it fetches | Needed for |
|-----------|------------------|------------|
| `whisper` | A `faster-whisper` model (`--whisper-model large-v3-turbo` by default) | Required before pipeline/transcribe runs. Pipeline Run will not auto-download; use bootstrap, the ShareCut Studio first-run wizard, or the Pipeline picker. Smaller sizes (`tiny.en` … `medium.en`, `large-v3`) trade accuracy for disk. Catalog sizes are pinned: `podcast_mcp.engines.models.whisper.WHISPER_PINS` records the Hugging Face revision and every file's sha256. They are hashed uncached at download, by the pre-run gate and at load (each about 1–3 s for the large models, on every run that transcribes), and memoised per file in status checks (Pipeline badge, bootstrap status, the catalog picker, Studio's early Run check, `podcast doctor`). A mismatch reports `[fail]` with a `--upgrade` hint; any download (`--upgrade`, a plain bootstrap, or a Studio **Download**) re-fetches a cached snapshot that fails its pin. A catalog snapshot cached at another revision reads as not downloaded until bootstrap fetches the pin. Other faster-whisper sizes (`tiny`, `base`, `large-v2`, `distil-*`, …) are unpinned. |
| `rnnoise` | An RNNoise `.rnnn` model | `noise_reduction_rnnoise` FX preset |
| `silero-vad` | Nothing — verifies the model bundled with `faster-whisper` | Optional VAD breath handling |
| `nisqa` | NISQA weights (**opt-in only**; not included in `--component all`) | Neural join QC with `joinqc` extra. Default GitHub release URL may 404; set `PODCAST_MCP_NISQA_MODEL` to an unpacked weights dir if needed |
| `word-aligner` | Pinned wav2vec2-base CTC ONNX snapshot (~360 MB, English; **opt-in download**; not in `--component all`; once downloaded, `transcribe.forced_alignment.enabled` (default unset) turns forced alignment on by itself. Without the snapshot, unset remains unavailable and an explicit `true` blocks the run with this command; Studio shows that saved request checked and lets a person turn it off. #780. Every snapshot file (`vocab.json`, `config.json`, `preprocessor_config.json`, the ONNX) is checked against a pinned per-file sha256 manifest at download, at load (before `vocab.json` is read) and in status checks (Pipeline badge, bootstrap status, `podcast doctor`; memoised per file on path/size/mtime) and, uncached, in bootstrap's cache check, so a corrupt or swapped snapshot reports [fail] with an --upgrade hint instead of [skip], and any download (including Studio's **Download word aligner**) re-fetches it; a failed load is not retried for the rest of that run) | `transcribe.forced_alignment.enabled`; `PODCAST_MCP_WORD_ALIGNER_MODEL` points at a local snapshot dir. Studio: **Download word aligner** under the Pipeline tab's Precise word boundaries field (`POST /api/bootstrap/run` `components: ["word-aligner"]`); `GET /api/bootstrap/status` reports it under `components["word-aligner"]` (`opt_in: true`, never in `ready`). The status check hashes an unchanged snapshot once per process, keyed by path/size/mtime/pin, and remembers a pin mismatch the same way until a re-download changes the file. |
| `speaker-ecapa` | Pinned ONNX build of the SpeechBrain ECAPA speaker-embedding network (~80 MB, Apache-2.0; **opt-in download**; not in `--component all`). Runs on `onnxruntime`, so it needs no torch and works in the packaged app. Checked against its pinned sha256 at download and in status checks. | Speaker enroll, score, attribute, gate-track and split. `resolve_speaker_backend()` prefers it (`ecapa-onnx`) over the torch `speechbrain-ecapa` extra; embeddings match (cosine 1.0, `scripts/export_ecapa_onnx.py`), so existing profiles keep matching. `PODCAST_MCP_SPEAKER_ECAPA_MODEL` points at a local ONNX file. The file is mirrored on the CDN only: it needs publishing to `models/speaker-ecapa/` before a build can download it. |

**Word aligner tiers.** `word-aligner` bootstraps the single pinned tier the
pipeline uses (`onnx-base`); `scripts/benchmark_forced_aligners.py` also
benchmarks a heavier `torch-large` candidate, which is not wired into
`transcribe.forced_alignment` and not part of any bootstrap component. The
shipped `onnx-base` tier's measured cost and accuracy on real audio are in
[docs/testing.md § Shipped pass results (#715)](test-results.md#shipped-pass-results-715).

**Pinned model manifests (#728).** The word aligner (`onnx-base`) and the
Whisper catalog sizes (below) are pinned to a Hugging Face revision plus a
per-file sha256 manifest (`util/model_manifest.py`, a shared
`FileManifest`/`PinnedSnapshot`/`manifest_mismatch` used by both catalogs).
Every downloaded file is verified, not just the model weights, so a swapped
`vocab.json` or tokenizer config is caught before it can silently shift
transcript or alignment output. Pins live in `engines/models/word_aligner.py`
(`WordAlignerModel.file_sha256`) and `engines/models/whisper.py` (`WHISPER_PINS`).
Hashes were obtained from a clean download of the pinned revisions on
2026-09-28: LFS files (weights) use the hub's LFS sha256
(`HfApi().model_info(..., files_metadata=True)`); small non-LFS files are the
sha256 of the bytes at that revision, whose git blob id and size were checked
against the same call. To re-pin (a new upstream revision or a compromised
pin), bump the revision and every file's hash together in one change — for
the word aligner, also update `tests/fixtures/word_boundary/candidates.json`,
which a test asserts equals the production catalog. gitleaks-history reads a
sha256 on a line that names a token (for example `tokenizer.json`) as a
generic API key; `.gitleaks.toml` allowlists the two pin shapes in
`engines/models/whisper.py` and `engines/models/word_aligner.py` (`_…_SHA256 = "…"` constants
and `("<file>", "…")` manifest entries), so keep new pins in one of those
shapes ([docs/testing.md § Credential history
scanning](testing.md#credential-history-scanning)).
`GET /api/bootstrap/status` and the Pipeline tab's component badges report a
pin mismatch (Whisper or word aligner) as `ok: false` with
`pin_mismatch: true`, the mismatch as `hint`, and an `--upgrade` `bootstrap`
command naming the model.

To check the shipped pins against a clean download (network; bootstrap hashes every
file uncached and exits 1 on a mismatch):

```bash
PODCAST_MCP_CACHE="$(mktemp -d)" uv run podcast bootstrap --component whisper --whisper-model small.en
PODCAST_MCP_CACHE="$(mktemp -d)" uv run podcast bootstrap --component word-aligner
```

To derive a new pin, download exactly the manifest's files at the new revision and hash
each one (repeat per catalog size):

```bash
uv run hf download Systran/faster-whisper-small.en config.json model.bin tokenizer.json vocabulary.txt \
  --revision <new-commit-sha> --local-dir /tmp/pin-check
shasum -a 256 /tmp/pin-check/config.json /tmp/pin-check/model.bin /tmp/pin-check/tokenizer.json /tmp/pin-check/vocabulary.txt
```

Optional asset mirror: set `PODCAST_BOOTSTRAP_CDN_BASE` (public HTTPS base, no trailing slash) so RNNoise tries CDN object keys from [`contracts/bootstrap-assets.json`](../contracts/bootstrap-assets.json) before upstream fallbacks. CDN bytes are skipped until the matching `sha256` pins are present. `GET /api/bootstrap/status` reports whether an environment override or non-null manifest `cdn_base_default` configured a mirror. Installer manifests and publishing configuration belong to the operator. Whisper still uses `faster-whisper` / Hugging Face until the mirror ships those weights (the catalog sizes at their pinned revisions). Opt-in components (`nisqa`, `word-aligner`) are not in the manifest and always download from upstream.

```bash
podcast bootstrap --component all
podcast bootstrap --component whisper --whisper-model small.en
podcast setup --whisper-model medium.en   # persist without downloading
# Use another downloaded model for one standalone transcription run.
podcast transcribe --project /path/to/episode.project.json --model small.en
podcast bootstrap --component nisqa    # only when using joinqc neural path
podcast bootstrap --component word-aligner  # precise word boundaries turn on by default once downloaded (transcribe.forced_alignment.enabled)
```

### npm (ShareCut Studio viewer)

Not fetched by Python bootstrap. After the `gui` extra:

```bash
cd gui/web && npm ci && npm run build
```

Produces `gui/web/dist/` (`index.html` + assets). Required for `podcast gui` HTML UI; CLI/MCP editing works without it. A wheel built after this step includes it; one built without it does not (see [Web build in wheels](#web-build-in-wheels)).

The development-only component catalog uses the same frontend dependencies:

```bash
cd gui/web && npm ci
npm run storybook        # local catalog on :6006
npm run build-storybook  # static storybook-static/
```

See [design-system.md](design-system.md) for story conventions and the GitHub
Pages prerequisite. Storybook is separate from the app and desktop bundles.

### ShareCut Studio first-run (GUI)

On the host home screen (no `?project=`), ShareCut Studio checks `GET /api/bootstrap/status`
and reports audio-tool readiness. It can download Whisper via `POST /api/bootstrap/run` (progress on
`GET /api/bootstrap/events` — same progress plane as pipeline jobs; see [progress.md](progress.md)). The wizard lets you pick a Whisper size; default is
**large-v3-turbo** (lowest practical WER, ~1.6 GB). Same assets as `podcast bootstrap`;
torch extras are not offered in the UI. Contributor CLI path is unchanged.

Native window (optional): [`gui/desktop/`](../gui/desktop/) — see
[desktop-packaging.md](desktop-packaging.md). Local CI mirror:
`make test-desktop` (needs rustup + rustfmt/clippy); full installer:
`make desktop-build` (freezes sidecar; unsigned unless `APPLE_*` env is set). Both run scripts in
[`scripts/desktop/`](../scripts/desktop/) (`check_desktop.sh`, `build_desktop.sh`; the
Linux AppImage wrapper is `build_linux_appimage_docker.sh`), which share `scripts/desktop/lib.sh`
([desktop-packaging.md § Desktop shell scripts](desktop-packaging.md#desktop-shell-scripts)).
Win/Linux/mac-x64 installers are produced by the reusable `release-desktop-build.yml` workflow. A caller repository supplies an immutable source SHA and may set `sign=true` only when its `desktop-signing` environment is complete; unsigned dogfood callers leave signing disabled.

## macOS (or any OS with a package manager)

```bash
brew install ffmpeg
./install.sh
source .venv/bin/activate
podcast doctor
```

## Acquire the pinned FFmpeg pair

Desktop packaging uses the same prebuilt importer as CI. A source checkout can
select that pair explicitly after acquiring it:

```bash
python scripts/ffmpeg_payload.py --output /absolute/path/sharecut-ffmpeg
export PODCAST_MCP_FFMPEG=/absolute/path/sharecut-ffmpeg/bin/ffmpeg
export PODCAST_MCP_FFPROBE=/absolute/path/sharecut-ffmpeg/bin/ffprobe
podcast doctor
```

Use the `.exe` paths on Windows. No compiler or source download is required by
the consumer. The production catalog pins hosted archives and their original
producer manifests. Acquisition fails closed if either digest or native proof fails.

An offline dependency archive still requires the selected catalog hashes:

```bash
python scripts/ffmpeg_payload.py --output /absolute/path/sharecut-ffmpeg --catalog /absolute/path/catalog.json --archive /absolute/path/payload.tar.xz
```

The importer verifies the complete archive SHA256 before extraction. It also
checks explicit archives before existing payload reuse. Wrong or damaged input
never falls back to another supplier. The existing native source builder is for
producing a new dependency release when inputs change. It requires native build
tools and is absent from ordinary CI and sidecar call graphs.

### FFmpeg version and pair policy

#### Decision: Bundle the pinned FFmpeg 9 pair

<!-- decision
id: D-bundled-ffmpeg9
status: accepted
date: 2026-10-09
decided-by: calebn
evidence:
- Owner instruction to bundle a pinned prebuilt FFmpeg 9 pair in desktop releases, use the same pair in CI and drop FFmpeg 6 support
enforced-by:
- tests/test_binaries.py::test_unsupported_release_fails_before_return
- tests/test_ffmpeg_payload.py::test_corrupt_archive_fails_before_tar_open_or_execution
- tests/test_build_sidecar.py::test_payload_is_ensured_before_runtime_completion
-->

The shared resolver validates both executables with bounded version probes.
Supported source-use releases have major version 9 and are at least 9.0.2.
Both executables must report the same numeric release. Old majors, prereleases,
development identifiers and unequal releases fail with an installation hint.

Explicit constructor paths win over their matching environment overrides.
An explicit partial path uses its actual executable sibling, including a bare
command resolved through PATH. It never mixes with an unrelated installation.
Selected command paths become absolute before any media work starts.

Without explicit overrides, `PODCAST_MCP_FFMPEG_BUNDLE` declares the desktop
pair's executable directory. That directory must contain exact 9.0.2. A missing,
corrupt or unsupported declared bundle fails instead of falling back to PATH.
Otherwise automatic discovery checks the native macOS Homebrew keg, complete
PATH directories, then the existing source-use cache. Discovery reads candidates
in order and creates no cache directories. Inaccessible optional directories are
unavailable candidates. Unsupported automatic candidates are rejected before a
later supported candidate can be selected.
Single-command helpers use the same validated pair.
After a successful admission, a process reuses that result only while the
effective selectors, search precedence, and candidate executable identities
remain unchanged. Failed pair admission is retried rather than cached.
Explicit health checks, including GUI bootstrap and Pipeline readiness, run fresh
bounded version probes even when admission is cached.

The authoritative [source recipe](../contracts/ffmpeg-build.json) pins FFmpeg
9.0.2, static LAME 4.0, static zlib 1.3.2 and static Opus 1.6.1 by independently
expected SHA256.
The recipe keeps built-in media codecs and filters, enables MP3 through LAME and
PNG through zlib and Opus through libopus. It enables neither GPL nor nonfree
dependencies. Static pkg-config resolution includes private system libraries
required by dependencies, such as Opus’s math library on Linux. Standalone
x86 assembly is disabled. `scripts/build_ffmpeg.py` is the native dependency
producer for a new release, rather than an ordinary CI or sidecar prerequisite.

CI and the sidecar use `scripts/ffmpeg_payload.py` to acquire the same target
archive from `contracts/ffmpeg-artifacts.json`. Archive SHA256 admission precedes
extraction or executable execution. The catalog also pins the original producer
manifest. Its closed inventory covers the pair, source archives, notices and
rebuild materials. Known source pins and semantic configure inputs are checked
independently. Consumer admission preserves historical producer hashes and does
not require the current builder script to match them.

The production catalog selects the hosted archive for each supported target.
Offline validation can supply `--catalog` and `--archive` to the same importer. Sidecar builds forward `PODCAST_FFMPEG_CATALOG` and
`PODCAST_FFMPEG_ARCHIVE` for this offline workflow. An explicit corrupt archive
fails even if the installed payload is intact. No consumer source-build fallback
exists. These environment variables affect build tooling only.

Windows linkage validation admits audited direct imports from Windows SDK DLLs,
including GDI, OLE Automation, Shell utilities and AVICap used by FFmpeg's native
capture inputs. API-set imports must be complete DLL basenames with their level
and version numbers. Paths, malformed names and external codec or toolchain DLLs
fail validation. The importer reads the PE import table without a compiler toolchain and prints the direct inventory before
validation, so CI logs retain it on success or failure. PE import inspection checks
names. The subsequent media proof executes both programs with only Windows
System32 on PATH to detect missing runtime dependencies and confirm the required
codecs and filters.

`podcast bootstrap` downloads model assets only. FFmpeg is a readiness check and
is absent from CLI and GUI download component lists. Keep supported system tools,
use explicit paths from the prebuilt importer, or reinstall a damaged desktop bundle.

Run the selected build's media acceptance suite with the
[`scripts/verify_ffmpeg_baseline.py`](../scripts/verify_ffmpeg_baseline.py).
It records both command paths and releases, passes that pair to the test child,
writes JSON and fresh JUnit evidence, and
fails if any acceptance test skips. Pass `--expected-version 9.0.2` to reject an
unknown or different release before tests start. The runner removes inherited
`PYTEST_ADDOPTS` from its child and fails if pytest reports deselected cases.
Cross-platform behavioral resolver tests mock OS selection and executable
lookup policy while keeping the test host's real path semantics. Focused
resolver/readiness tests run on real Windows in the desktop workflow, but do
not constitute Windows media acceptance. Native payload jobs separately acquire
and verify the pinned prebuilt archive on every release target. These consumer
checks do not compile the source recipe. Full media acceptance must name the
exact pair and preserve the runner's JSON and JUnit evidence.

## Reproducible installs

All Python dependencies are declared in [pyproject.toml](../pyproject.toml) (the
equivalent of `package.json`) and pinned exactly in [uv.lock](../uv.lock) (the
equivalent of `package-lock.json`). Nothing the codebase imports should ever rely on a
package that merely *happens* to be present in some other environment (e.g. a
system/base Python) — every third-party import is declared here.

```bash
# Match install.sh (recommended contributor set)
uv sync --extra dev --extra gui --extra relay --extra prosody

# Everything including speaker + joinqc (large torch/CUDA wheels on Linux)
uv sync --all-extras

uv run make test       # or: .venv/bin/pytest
```

`uv sync` (no flags) installs only the core runtime dependencies. See [Optional downloads and extras](#optional-downloads-and-extras) for the full extras table.

Note: transcription (`faster-whisper`, core dependency) already ships
`onnxruntime` and a bundled Silero VAD model. Whisper **weights** are not
auto-pulled by pipeline Run or transcription — download them via
`podcast bootstrap --component whisper`, the ShareCut Studio first-run wizard, or
the Pipeline picker before running those steps. Neither needs a speaker
extra. `torch`/`speechbrain` are only for the optional enrollment-based
speaker ID workflow; a fully functional install (transcribe, tighten, mix,
master, export) needs neither `speaker` nor `speaker-lite`. Source installs
require a supported FFmpeg pair as described above. Whisper weights are still
required for ASR.

Regenerate the lock file after changing `pyproject.toml` dependencies:

```bash
uv lock
```

Without `uv`, `install.sh` creates a plain `.venv` and runs
`pip install -e ".[dev,gui,relay,prosody]"`. Add speaker/joinqc manually if needed:
`pip install -e ".[speaker,joinqc]"`.

## MCP and agents

### Impeccable design hooks

The repo includes the upstream Impeccable skill in
`.agents/skills/impeccable/` and Codex `PostToolUse` / `Stop` definitions in
`.codex/hooks.json`. Shared `.impeccable/config.json` enables design checks.
Review and trust both definitions in Codex Settings → Hooks, or `/hooks` in
the CLI, then reload Codex to discover the `$impeccable` skill. Changed hook
definitions require trust again. Installing files alone does not grant Codex trust.

From the repo root, verify the runtime and configuration:

```bash
.agents/skills/impeccable/scripts/impeccable engine-probe
.agents/skills/impeccable/scripts/impeccable hooks status
.agents/skills/impeccable/scripts/impeccable doctor
```

The launcher pins its engine version in `scripts/VERSION`. The first run on a
fresh clone downloads that platform's binary into `~/.impeccable/bin/<version>/`
and verifies its SHA-256 sidecar. Run `engine-probe` in a terminal with network
and cache write access before using sandboxed hooks. A preinstalled engine can
also be supplied through `IMPECCABLE_BIN`. Platform binaries, local consent,
and hook caches are ignored by Git.

Claude Code reads project skills from `.claude/skills`, a committed symlink
to `.agents/skills`, so `/impeccable` and the podcast skills load in a new
Claude Code session. The automatic design hooks are Codex-only; in Claude Code,
run `/impeccable` (for example a critique or audit) explicitly. On Windows,
clone with `core.symlinks=true` so the link checks out as a directory.

Supported web edits get focused feedback after a write and a broader check
at turn completion. These are agent design checks; existing Git hooks,
Stylelint, accessibility tests, and CI still apply. Do not suppress a finding
without the approval required by this repo's engineering rules. Product and
design context remain in `docs/ui-philosophy.md`, `docs/design-tokens.md`, and
`ux/pages/brand.md`; installation does not generate `PRODUCT.md` or `DESIGN.md`.

To refresh the upstream installation, use Node.js 22.18 or later:

```bash
npx impeccable update --scope=project
.agents/skills/impeccable/scripts/impeccable doctor
```

Review upstream changes, the pinned engine version, and the generated hook
definitions on a feature branch. Enable or disable checks with
`.agents/skills/impeccable/scripts/impeccable hooks on` / `hooks off`.
See the [upstream hook documentation](https://impeccable.style/docs/hooks/).

### MCP configuration

After `./install.sh`, use `source .venv/bin/activate` (or `uv run`) so `podcast` /
`podcast-mcp` resolve. Agent config lives under [.agents/](../.agents/):

| Path | Purpose |
|------|---------|
| [mcp.json](../.agents/mcp.json) | MCP server entry for your client |
| [rules/engineering-standards.md](../.agents/rules/engineering-standards.md) | SOLID/DRY, tests, docs |
| [Poteto Git policy](../.agents/skills/sharecut-poteto/references/git-workflow.md) | Feature branch → PR → `main` |
| [rules/gui-styling.md](../.agents/rules/gui-styling.md) | Theme tokens, rem, `@container`, consent-gated CSS exceptions |
| [skills/](../.agents/skills/) | Episode workflows |

Clients that load project agents from `.agents/` (including Cursor) pick up rules, skills, and MCP from there. Reload MCP after install if your IDE was already open. Point the MCP `command` at the venv binary if the client does not inherit your shell PATH (e.g. `.venv/bin/podcast-mcp`).

**Connecting an external agent?** Copy-paste configurations for Claude Code,
Claude Desktop, Cursor, Windsurf, and Cline: [mcp-setup.md](mcp-setup.md).

**Local GUI URL (recommended when the DAW is open):** run `podcast gui`, open an episode (or **Connect agent…** on home to copy the URL first), **Menu → Connect agent…**, and paste `http://127.0.0.1:8765/mcp` as a stateless Streamable HTTP MCP URL (same shape as Figma desktop). Keep the GUI running. Host MCP is loopback-only, accepts POST (GET/HEAD return 405), and does not use a sticky `Mcp-Session-Id` header; stdio and guest/share-token MCP are unchanged. Details: [gui-integration.md](gui-integration.md) § Local host MCP.

### Transcription vocabulary

Use `podcast transcript context show --project PATH` to read context. `context set` adds entries with `--term` / `--guest-name` and removes them with
`--remove-term` / `--remove-guest-name`. Host MCP vocabulary tools provide the
same limits with revision-checked replacement writes; see
[transcript-workflow.md](transcript-workflow.md).

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
| `bin/` | Existing source-use location for a locally supplied supported `ffmpeg`/`ffprobe` pair |
| `models/` | Bootstrapped model assets (RNNoise `.rnnn`; optional NISQA dir) |
| `word-aligner/` | Opt-in forced-aligner Hugging Face snapshot |

Model weights stay outside the repository and installed package. Fetch models
with `podcast bootstrap` or the ShareCut Studio wizard / Pipeline picker. Pipeline
Run and transcription do not auto-download Whisper weights. Desktop releases
include their pinned audio tools inside `sharecut-runtime/ffmpeg`, separate from
this user cache. Source installs supply a supported pair through explicit paths,
a system installation, or the existing `bin/` directory.

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

Use `--dry-run` to write `artifacts/play_cache/*.wav` without opening a player (`afplay` on macOS, `ffplay` elsewhere). Response JSON includes `tier`: `raw`, `stem`, `segment_render`, `premix`, or `ab_concat` (history/WAV A/B). `render_busy: true` (tier `premix`) means a `--rerender` lost the race for the render lock (another export/Refresh) and played the premix already on disk, which may be the previous render. A processed `--rerender` that loses the race plays a `segment_render` of the current edits and leaves `render_busy` false.

Full-file transport reports a missing premix with `no_mix` and a missing processed stem with `file_not_found`. Both remain `FileNotFoundError` exceptions for host callers.

Studio's [Wordbar](daw-editing.md#wordbar-source-timing) previews the selected original recording in source seconds. Its local preview holds the timeline in place until **Stop preview** or **Close timing** returns control. This uses the existing audio controller without adding a public play mode.

Playback cache cleanup runs when a new audition path is resolved. It removes WAVs older than seven days and, above 512 WAVs, the oldest entries written at least an hour ago; a 4096-WAV hard cap also bounds a burst of new previews. This includes composed, A/B, and pending previews. Non-WAV files are retained. Transcript gating of PCM16 stems streams one second at a time, preserving their channels and changing only samples inside the requested window; unsupported WAV formats raise an error.

## ShareCut Studio Extensions (self-hosted collaboration / optional provider)

Share, record, remote-MCP, and guest `/r/{token}` routes load through the public [Extensions API](extensions.md). The FOSS `collaboration` extension is enabled by default and does not require an account. A separately installed `online` provider extension can add account/auth surfaces.

```bash
# Pure local ShareCut Studio (no share routes, no share MCP mint tool, no `podcast review share*`)
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

| Mode | You provide | ShareCut/FOSS provides |
|------|-------------|------------------------|
| Local | Project files and optional machine preferences | Loopback GUI, editing, pipeline, export, development desktop profile |
| Self-hosted collaboration | Relay domain/TLS, strong host token, and optionally an S3-compatible store | Relay/tunnel protocol, guest UI, local media-proxy fallback, redacted example |
| Desktop distributor | Public identity/trust profile, private signing and deployment credentials, an updater key pair, and feed hosting (for example on `cdn.sharecut.studio`) | Validated schema, Tauri overlay generator, reusable build scripts, update feed builder (`scripts/build_update_feed.py`) |

Host runtime configuration (validated by `src/podcast_mcp/config/runtime.py`; the distribution profile by `src/podcast_mcp/config/distribution.py`) lives at `~/.config/podcast_mcp/relay.yaml`; copy
[`config/relay.example.yaml`](../config/relay.example.yaml). Relay-field precedence
is explicit CLI/API argument, environment, YAML, then a safe loopback default.
The tunnel identity `host_id` (`PODCAST_RELAY_HOST_ID` / YAML `host_id`) defaults to
a uuid minted once and persisted as `relay_host_id` next to `relay.yaml`; it must
match the `host_id:` prefix when the relay pins this host's secret (see
[host-online-relay.md](host-online-relay.md) § Security notes).
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
share origins, support/privacy/repository URLs, release manifest URL, the
optional bootstrap CDN base, and the in-app updater endpoint and public key
(both `null` to disable updates; the private updater key is a CI secret,
never a profile field). Rust and Tauri consume generated values from the
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

## Environment variables

Every environment variable the package reads is declared once in `src/podcast_mcp/settings.py`; nothing else under `src/podcast_mcp` touches `os.environ`. Reads are live, so a variable changed after start-up applies on the next call. The `relay.yaml` keys and the `~/.config/podcast_mcp` file names are unchanged; the `PODCAST_RELAY_*` and `PODCAST_OBJECT_STORE_*` rows are the environment overrides of those keys. Regenerate this table with `python -m podcast_mcp.settings`; a test fails when it drifts.

<!-- settings:start -->
**Paths and caches**

| Variable | Default | Meaning |
| --- | --- | --- |
| `PODCAST_MCP_CACHE` | `~/.cache/podcast_mcp` | Base for downloaded models, FFmpeg and caches. |
| `PODCAST_CONFIG_DIR` | `~/.config/podcast_mcp` | Directory for the OAuth client files. |
| `PODCAST_MCP_PROJECT` |  | Project path the MCP tools use when none is passed. |
| `PODCAST_MCP_PIPELINE_DEFAULTS` |  | Pipeline defaults YAML replacing the shipped one. |
| `PODCAST_SHARE_REGISTRY` | `~/.podcast_mcp/share_registry.sqlite` | Share registry database file. |
| `PODCAST_SHARE_IDENTITY` | `~/.podcast_mcp/share_identity.sqlite` | Share identity database file. |
| `PODCAST_E2E_PROJECT` |  | Project the end-to-end fixture serves instead of the built-in one. |
| `PODCAST_EXTENSIONS` |  | Comma-separated extension allowlist; set and blank loads none, unset loads all. |
| `LOCALAPPDATA` |  | Windows per-user data root (sidecar log lookup). |
| `XDG_STATE_HOME` |  | XDG state root (sidecar log lookup). |
| `PATH` |  | Executable search path (FFmpeg lookup). |

**Models and engines**

| Variable | Default | Meaning |
| --- | --- | --- |
| `PODCAST_WHISPER_MODEL` |  | Whisper model name; overrides preferences and the pipeline default. |
| `PODCAST_MCP_WORD_ALIGNER_MODEL` |  | Local word-aligner snapshot directory. |
| `PODCAST_MCP_RNNOISE_MODEL` |  | RNNoise model file. |
| `PODCAST_MCP_NISQA_MODEL` |  | NISQA weights directory. |
| `PODCAST_MCP_SPEAKER_ECAPA_MODEL` |  | Speaker-recognition ONNX model file. |
| `PODCAST_MCP_FFMPEG` |  | Explicit ffmpeg executable (set together with PODCAST_MCP_FFPROBE). |
| `PODCAST_MCP_FFPROBE` |  | Explicit ffprobe executable. |
| `PODCAST_MCP_FFMPEG_BUNDLE` |  | Directory holding the desktop app's bundled FFmpeg pair. |
| `PODCAST_BOOTSTRAP_CDN_BASE` |  | Public HTTPS mirror base for bootstrap assets. |
| `WHISPER_CPP_BIN` |  | whisper-cli executable. |
| `WHISPER_CPP_MODEL` |  | whisper.cpp model file. |
| `WHISPER_CPP_MODEL_NAME` | `ggml-base.en.bin` | whisper.cpp model name inside its cache. |

**Behavior flags**

| Variable | Default | Meaning |
| --- | --- | --- |
| `PODCAST_BATCH` |  | Treat the run as unattended (1, true, yes). |
| `PODCAST_DEBUG` |  | Show the original traceback for CLI errors (1, true, yes, on). |
| `PODCAST_PROGRESS` | `1` | Progress output; 0, false or no turns it off. |
| `PODCAST_PROGRESS_COMPLIANCE` |  | Progress compliance checks (diagnostics only). |
| `PODCAST_SPEAKER_BACKEND` |  | Set to mock to opt in to the development speaker mock (tests, development). |
| `PODCAST_NO_STUDIO_HANDOFF` |  | Run CLI commands directly instead of through the Studio serving the project. |
| `PODCAST_PACKAGED_CLI` |  | Set to 1 by the installed app's CLI shim. |
| `PODCAST_GUEST_RENDER` |  | Allow guest render previews (1, true, yes, on). |
| `PODCAST_SHARE_ACCOUNTS` |  | Enable restricted shares with sign-in (1, true, yes, on). |

**Studio server**

| Variable | Default | Meaning |
| --- | --- | --- |
| `PODCAST_GUI_DIST` |  | Built web UI directory (frozen sidecars point it at web-dist). |
| `PODCAST_GUI_OPENAPI` | `1` | Serve OpenAPI/Swagger; 0, false or no turns it off. |
| `PODCAST_REVIEW_CORS_ORIGINS` |  | Extra exact CORS origins, comma-separated. |
| `PODCAST_SESSION_AUTHZ` |  | Session authorization mode; 1, true or strict enforces the token. |
| `PODCAST_SESSION_TOKEN` |  | Session token for remote clients (generated off-loopback when unset). |
| `PODCAST_SIDECAR_BOOT_TOKEN` |  | Boot token the desktop host requires on health checks. |
| `PODCAST_SIDECAR_EPHEMERAL` |  | Bind an ephemeral port (1, true, yes, on). |
| `PODCAST_SIDECAR_LISTEN_FILE` |  | File the bound port is written to. |
| `PODCAST_PUBLIC_ORIGIN` |  | Public origin used for OAuth redirect URIs. |
| `PODCAST_AUTH_COOKIE_SECURE` |  | Mark the sign-in cookie Secure (1, true, yes). |
| `PODCAST_MAGIC_LINK_PRINT` | `1` | Print magic sign-in links to the log; 1 prints. |
| `PODCAST_WEBAUTHN_RP_ID` | `localhost` | Passkey relying-party id. |
| `PODCAST_WEBAUTHN_TEST_MODE` | `1` | Skip WebAuthn signature checks; 1 skips them. |
| `PODCAST_GOOGLE_OAUTH_CLIENT_ID` |  | Google OAuth client id. |
| `PODCAST_GOOGLE_OAUTH_CLIENT_SECRET` |  | Google OAuth client secret. |
| `PODCAST_GOOGLE_OAUTH_CLIENT_FILE` |  | Google OAuth client JSON file. |
| `PODCAST_GOOGLE_OAUTH_REDIRECT_URI` |  | Google OAuth redirect URI. |
| `PODCAST_GITHUB_OAUTH_CLIENT_ID` |  | GitHub OAuth client id. |
| `PODCAST_GITHUB_OAUTH_CLIENT_SECRET` |  | GitHub OAuth client secret. |
| `PODCAST_GITHUB_OAUTH_CLIENT_FILE` |  | GitHub OAuth client JSON file. |
| `PODCAST_GITHUB_OAUTH_REDIRECT_URI` |  | GitHub OAuth redirect URI. |

**Relay and object store**

| Variable | Default | Meaning |
| --- | --- | --- |
| `PODCAST_RELAY_CONFIG` | `~/.config/podcast_mcp/relay.yaml` | relay.yaml path. |
| `PODCAST_RELAY_URL` |  | Relay tunnel URL. |
| `PODCAST_RELAY_HOST_TOKEN` |  | Relay host token. |
| `PODCAST_RELAY_HOST_ID` |  | Relay host id (persisted next to relay.yaml when unset). |
| `PODCAST_RELAY_PUBLIC_BASE_URL` |  | Public base URL guests open. |
| `PODCAST_RELAY_LOCAL_GUI_URL` |  | Local Studio URL the tunnel forwards to. |
| `PODCAST_REPORT_RELAY_URL` |  | Relay origin that accepts diagnostics reports. |
| `PODCAST_OBJECT_STORE_ENDPOINT_URL` |  | Object store endpoint. |
| `PODCAST_OBJECT_STORE_REGION` |  | Object store region. |
| `PODCAST_OBJECT_STORE_BUCKET` |  | Object store bucket. |
| `PODCAST_OBJECT_STORE_ACCESS_KEY_ID` |  | Object store access key id. |
| `PODCAST_OBJECT_STORE_SECRET_ACCESS_KEY` |  | Object store secret key. |
| `PODCAST_OBJECT_STORE_CDN_ENDPOINT` |  | Optional CDN endpoint for object-store media. |
| `PODCAST_OBJECT_STORE_ADMIN_ACCESS_KEY_ID` |  | Admin key id for `podcast relay bucket-setup`. |
| `PODCAST_OBJECT_STORE_ADMIN_SECRET_ACCESS_KEY` |  | Admin secret for `podcast relay bucket-setup`. |
| `PODCAST_RELAY_HOST_TOKENS` |  | Relay-side map of host_id:secret entries (relay process). |
| `PODCAST_RELAY_RATE_LIMIT` |  | Relay-side rate limiting; 0 disables (relay process). |
| `PODCAST_RELAY_ALLOW_OPEN_TUNNEL` |  | Let the relay start with no host tokens, local/dev only (1, true, yes, on). |
| `PODCAST_RELAY_HOST` | `0.0.0.0` | Interface the relay binds. |
| `PODCAST_RELAY_PORT` | `8081` | Port the relay binds. |
| `PODCAST_RELAY_FORWARDED_ALLOW_IPS` | `127.0.0.1` | Proxy addresses whose forwarded headers the relay trusts. |
| `PODCAST_RELAY_VERSION` |  | Relay version baked into the Docker image. |
| `PODCAST_RELAY_GIT_SHA` |  | Relay build commit baked into the Docker image. |
| `PODCAST_REPORT_STORE` |  | Writable directory where the relay keeps submitted diagnostics reports. |
| `PODCAST_REPORT_PUBLIC_BASE_URL` |  | The relay's public HTTPS origin, used in report links. |
| `PODCAST_REPORT_GITHUB_TOKEN` |  | Server-only token that files report issues. |

**Distribution metadata**

| Variable | Default | Meaning |
| --- | --- | --- |
| `PODCAST_DISTRIBUTION_SUPPORT_URL` |  | Support link injected by the desktop host. |
| `PODCAST_DISTRIBUTION_PRIVACY_URL` |  | Privacy link injected by the desktop host. |
| `PODCAST_DISTRIBUTION_REPOSITORY_URL` |  | Repository link injected by the desktop host. |
| `PODCAST_DISTRIBUTION_RELEASE_MANIFEST_URL` |  | Release manifest URL injected by the desktop host. |

**Limits**

| Variable | Default | Meaning |
| --- | --- | --- |
| `PODCAST_RATE_LIMIT` | `1` | Host rate limiting; 0, false, no or off disables. |
| `PODCAST_RATE_LIMIT_AUDIO_CONCURRENT` | `8` | In-flight audio requests allowed. |
| `PODCAST_GUEST_WS_CONCURRENT` | `8` | Concurrent guest websockets per share token. |
| `PODCAST_RELAY_TOKEN_CONCURRENT` | `24` | Relay in-flight requests per share token. |
| `PODCAST_RELAY_HOST_CONCURRENT` | `96` | Relay in-flight requests per host. |
| `PODCAST_RELAY_AUDIO_CONCURRENT` | `8` | Relay in-flight audio requests. |
| `PODCAST_RELAY_WS_CONCURRENT` | `8` | Relay concurrent websockets per share token. |
| `PODCAST_GUI_MAX_BODY_BYTES` |  | Largest Studio request body. |
| `PODCAST_GUI_MEDIA_MAX_BYTES` |  | Largest media upload. |
| `PODCAST_GUI_MEDIA_CHUNK_MAX_BYTES` |  | Largest media upload chunk. |
| `PODCAST_REMOTE_MCP_MAX_BODY_BYTES` |  | Largest remote MCP request body. |
| `PODCAST_RECORD_UPLOAD_MAX_PART_BYTES` |  | Largest recording upload part. |
| `PODCAST_RELAY_MAX_BODY_BYTES` |  | Largest relayed request body. |
| `PODCAST_RELAY_WS_MAX_SIZE` |  | Largest relayed websocket frame. |

**limits**

| Variable | Default | Meaning |
| --- | --- | --- |
| `PODCAST_RATE_LIMIT_READ_RPM` | `300` | Requests per minute allowed for host read requests. |
| `PODCAST_RATE_LIMIT_READ_BURST` | `60` | Burst allowance for host read requests. |
| `PODCAST_RATE_LIMIT_MUTATE_RPM` | `60` | Requests per minute allowed for host mutating requests. |
| `PODCAST_RATE_LIMIT_MUTATE_BURST` | `20` | Burst allowance for host mutating requests. |
| `PODCAST_GUEST_WS_PRESENCE_RPM` | `900` | Requests per minute allowed for guest presence websocket messages. |
| `PODCAST_GUEST_WS_PRESENCE_BURST` | `60` | Burst allowance for guest presence websocket messages. |
| `PODCAST_GUEST_WS_PRESENCE_TOKEN_RPM` | `3600` | Requests per minute allowed for guest presence messages per share token. |
| `PODCAST_GUEST_WS_PRESENCE_TOKEN_BURST` | `200` | Burst allowance for guest presence messages per share token. |
| `PODCAST_WS_ROSTER_REQUEST_RPM` | `60` | Requests per minute allowed for roster requests. |
| `PODCAST_WS_ROSTER_REQUEST_BURST` | `1` | Burst allowance for roster requests. |
| `PODCAST_GUEST_WS_RECORD_RPM` | `600` | Requests per minute allowed for recording websocket messages. |
| `PODCAST_GUEST_WS_RECORD_BURST` | `10` | Burst allowance for recording websocket messages. |
| `PODCAST_GUEST_WS_RECORD_TOKEN_RPM` | `3000` | Requests per minute allowed for recording messages per share token. |
| `PODCAST_GUEST_WS_RECORD_TOKEN_BURST` | `50` | Burst allowance for recording messages per share token. |
| `PODCAST_GUEST_WS_RECORD_SIGNAL_RPM` | `1800` | Requests per minute allowed for recording signal messages. |
| `PODCAST_GUEST_WS_RECORD_SIGNAL_BURST` | `80` | Burst allowance for recording signal messages. |
| `PODCAST_GUEST_WS_RECORD_SIGNAL_TOKEN_RPM` | `6000` | Requests per minute allowed for recording signals per share token. |
| `PODCAST_GUEST_WS_RECORD_SIGNAL_TOKEN_BURST` | `200` | Burst allowance for recording signals per share token. |
| `PODCAST_RELAY_TOKEN_RPM` | `600` | Requests per minute allowed for relay requests per share token. |
| `PODCAST_RELAY_TOKEN_BURST` | `80` | Burst allowance for relay requests per share token. |
| `PODCAST_RELAY_IP_RPM` | `1200` | Requests per minute allowed for relay requests per client address. |
| `PODCAST_RELAY_IP_BURST` | `120` | Burst allowance for relay requests per client address. |
| `PODCAST_RELAY_WS_MSG_RPM` | `120` | Requests per minute allowed for relay websocket messages. |
| `PODCAST_RELAY_WS_MSG_BURST` | `30` | Burst allowance for relay websocket messages. |
| `PODCAST_RELAY_WS_PRESENCE_RPM` | `900` | Requests per minute allowed for relay presence messages. |
| `PODCAST_RELAY_WS_PRESENCE_BURST` | `60` | Burst allowance for relay presence messages. |
| `PODCAST_RELAY_REGISTER_RPM` | `60` | Requests per minute allowed for relay tunnel registrations. |
| `PODCAST_RELAY_REGISTER_BURST` | `20` | Burst allowance for relay tunnel registrations. |
<!-- settings:end -->

## Read-only GUI viewer

ShareCut Studio is the full editor, not only a viewer. Install the optional `gui` extra (included in `./install.sh`), build the web UI once, then launch:

```bash
cd gui/web && npm ci && npm run build && cd ../..
podcast gui --project /path/to/episode.project.json
# or background (same as MCP open_gui_tool):
podcast gui --project /path/to/episode.project.json --background
# loopback without --project opens New/Open home (Pass 8)
# with a project pinned, / redirects to it; /?home=1 shows home without unpinning
# Browse… / Mod+O use a host OS file dialog (paste path still works)
podcast gui
```

### Web build in wheels

A wheel ships the web build when `gui/web/dist` exists at build time. The custom
hatch hook in `hatch_build.py` adds it then, and only then, because a static
`force-include` of a missing `gui/web/dist` fails every `uv build` and `uv sync`
in a tree without an npm build. Paths live in `[tool.hatch.build.hooks.custom]`
in `pyproject.toml`:

| Build | Web build |
| --- | --- |
| `uv build` after `npm run build` | wheel `podcast_mcp/gui/web_dist/`; sdist `gui/web/dist/`, so a wheel built from the sdist keeps it |
| `uv build` with no `gui/web/dist` | absent; the build succeeds |
| `uv sync` / editable install | never copied; the checkout's `gui/web/dist` is served live |

The web build adds about 0.8 MB to a wheel of about 1.2 MB. The
[`release-wheel`](../.github/workflows/release-wheel.yml) workflow runs
`npm ci && npm run build`, then `uv build`, installs the wheel into a clean venv,
and runs `scripts/check_wheel_web_build.py --podcast <venv>/bin/podcast`. The script
fails unless the wheel holds `index.html` plus every file it references, ships
`contracts/` as `podcast_mcp/contracts` and `.agents/defaults/` as `podcast_mcp/defaults`
(the installed package loads both) and
`podcast gui` serves that same `index.html` at `/`. Run it on a local wheel:

```bash
(cd gui/web && npm ci && npm run build)
uv build --wheel
python scripts/check_wheel_web_build.py dist/podcast_mcp-*.whl
```

The server resolves its static root in this order (`gui/static_assets.py`:
`resolve_gui_static_root`): `create_app(static_dir=...)`, then `PODCAST_GUI_DIST`,
then the wheel's `podcast_mcp/gui/web_dist` (`packaged_gui_dist`), then the
checkout's `gui/web/dist`.

When none of them holds `index.html` (a source tree before `npm run build`, or a
wheel built without one), the product says so:

- `podcast gui` prints one `Warning: ShareCut Studio web build not found at <dir>. ...`
  line on stderr before `Viewer: <url>` and keeps serving the API and host MCP.
- `GET /` returns a short HTML page (HTTP 503, `Cache-Control: no-store`) with
  the same guidance instead of a 404. `/api/*` and `/mcp` are unaffected.
- MCP `open_gui_tool` / `podcast gui --background` return `static_built: false`
  and the same text as `hint`.

To add the UI to such a wheel install, build it from a source checkout and point
the launcher at it:

```bash
cd sharecut-studio/gui/web   # a clone of the source repository
npm ci && npm run build
PODCAST_GUI_DIST="$PWD/dist" podcast gui
```

The check is "`index.html` exists in the resolved static root"
(`static_bundle_ready`, `missing_bundle_message`, `missing_bundle_response`).

Agents can call MCP `open_gui_tool` (skill `podcast-open-gui`) instead of blocking on a foreground server.
Background CLI launch and MCP `open_gui_tool` use `services.app.ensure_viewer`.
The binding auth helper in `services.session_sync` enables strict auth by default
when `PODCAST_SESSION_AUTHZ` is unset or blank, and preserves an explicit setting.
Non-loopback launch URLs include the session token.

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
podcast review share --project episode.project.json \
  --role commenter --base-url http://YOUR_HOST:8765
```

The global share index / registry is written mode `0600` (see [share-tokens.md](share-tokens.md)).
`podcast review backup-registry` creates a standalone backup with a new generated
name. `--dest` requires an unused filename in an existing trusted private directory;
existing files and SQLite sidecar names are refused. See [backup and offline
restore](share-tokens.md#backup--restore) before moving registry data.

`PODCAST_REVIEW_CORS_ORIGINS` is a comma-separated list of **exact origins** (`https://host[:port]`, or `http://` on loopback only) added to the loopback defaults (`127.0.0.1` / `localhost` on ports `5173` and `8765`). The GUI allows credentialed cross-origin requests from these origins, so `*`, wildcards, paths, query strings, fragments, user info, and non-loopback `http://` entries are refused and `podcast gui` fails to start with an error naming the variable. A trailing slash and letter case are normalized (`https://A.example/` becomes `https://a.example`). Unset or blank keeps the defaults. Same-origin pages (the GUI's own host) need no entry.

Guests use `/r/{token}` or `/rec/{token}` only (no `?project=` paths). `--role viewer|commenter|editor` picks the review-link role (default Commenter). Every role opens ShareCut Studio. Mint a recording room with `--kind record` (prints guest + producer `/rec/` URLs). Grant `--with-mcp` for capability-scoped remote MCP at `{base}/mcp/{token}/mcp` — host usually needs `podcast tunnel`. (`/r/{token}/mcp` is an accepted alias of the MCP bridge.) Restricted ACL + Google/GitHub login: [share-tokens.md](share-tokens.md) § Identity. See [timeline-comments.md](timeline-comments.md) § Public review share and [host-online-relay.md](host-online-relay.md) § Remote MCP. `podcast tunnel` prints one timestamped stderr line per state change (connecting, connected with the public URL and share count, disconnected with the reason, reconnecting with backoff) and exits `1` on a rejected host token or bad relay URL instead of retrying; Share says whether guests can open your links (or nothing on a local-only host) — see [host-online-relay.md](host-online-relay.md) § Tunnel status. Share/MCP traffic is rate-limited by default (generous budgets; `PODCAST_RATE_LIMIT=0` / `PODCAST_RELAY_RATE_LIMIT=0` to disable) — see [host-online-relay.md](host-online-relay.md) § Rate limiting. With an object store configured, `podcast relay bucket-check` says whether guests can read its media and `podcast relay bucket-setup` adds the CORS rule they need with an admin key, safe to run again — see [host-online-relay.md](host-online-relay.md) § Object-store bucket setup.

```bash
podcast gui --project episode.project.json --no-open
podcast review share --project episode.project.json \
  --role commenter --with-mcp \
  --base-url https://share.example.com
# Cursor: { "mcpServers": { "podcast-remote": { "url": "<printed MCP URL>" } } }
# Claude.ai: Connectors → paste MCP URL (/mcp/{token}/mcp), leave OAuth blank (authless)
```

## Debugging the CLI

A domain error (a busy project/render lock, `TranscriptRefineRequiredError`, a bad
`resolve_track` call, ...) escaping any `podcast` command prints one line to stderr and
exits 1 instead of a full traceback (`cli/busy.py`'s `BusyErrorGroup`, the CLI's one
choke point). Set `PODCAST_DEBUG=1` to get the original traceback back instead:

```bash
podcast edit suggest-handoff-cut --project episode.project.json --keep-left-end 10 --keep-right-start 20
# Error: track_id or speaker is required (set PODCAST_DEBUG=1 for the traceback)

PODCAST_DEBUG=1 podcast edit suggest-handoff-cut --project episode.project.json --keep-left-end 10 --keep-right-start 20
# full traceback
```

Accepted truthy values are `1` / `true` / `yes` / `on` (case-insensitive); anything else,
including unset, keeps the one-line message. A bug that is not a domain condition
(`TypeError`, a bad unpack, `NotImplementedError`) always shows its traceback — the
one-line message only replaces `ValueError` / `RuntimeError`.

For a busy project commit or render lock, the host CLI reports the measured
file-lock wait when available. This excludes CLI startup and time spent waiting
for the in-process state lock. On Linux, a readable `/proc/locks` can identify a
single kernel-observed holder PID at timeout. That holder can change immediately.
Other platforms, inaccessible procfs, or an uncertain observation report an unknown
holder. Activity, lock hold duration, and remaining time are unknown.

Wait for ongoing CLI or Studio work to finish, then retry the same command.
If unsure, check Studio progress. Do not delete the lock file or kill a process
to clear the message. Lock ordering and wait limits are unchanged. Guest and
shared error messages retain their fixed text without PID or timing details.

## Troubleshooting

The CLI and host Help share diagnostics-bundle creation through
`podcast_mcp.services.support`. Host Help also uses its report-submission
services. Their implementation is under `src/podcast_mcp/services/support/`.
Pipeline execution, configuration, and component bootstrap use the public
`podcast_mcp.services.pipeline` facade.

If ShareCut Studio or `podcast` misbehaves, create a **sanitized diagnostics zip** on your machine. Nothing is uploaded when the zip is created, and there is **no telemetry**. Home and Studio Help can preview the files and submit the zip with a description after explicit consent when `PODCAST_REPORT_RELAY_URL` points to a configured relay. The description and ZIP link become public; the relay keeps the ZIP for 30 days. Self-hosted installations can keep using Open support and attach the local zip manually.

```bash
podcast doctor --bundle            # writes ~/Downloads/sharecut-diagnostics-<UTC>-<nonce>.zip
podcast doctor --bundle --out DIR  # optional output directory
# prints the zip path and configured support URL; `--open` opens it in a browser
```

In the app: **Home → Help → Create diagnostics bundle**. The dialog shows the zip path, size, file list, and version. Add a description and approve the public upload to **Submit report**, or reveal the zip in your file manager and use **Open support**.

The zip includes doctor results, versions, a sidecar log tail, and counts (tracks/clips/decisions/comments) — not audio, transcripts, project JSON, share tokens, or `shares.json` / `sync.db`. Guests / review links cannot create a bundle (host-only).

Creating the zip runs doctor checks and (when a project is open) per-track timebase QC, then packs a log tail. On a large episode that can take tens of seconds; wait for the Help button to leave **Creating…** or for the CLI to print the path. The host API runs the work in a worker thread. Help uses a local busy label — it is not a StatusBar/SSE job.

The zip filename is `sharecut-diagnostics-<UTC>-<nonce>.zip` so two bundles in the same second do not overwrite. Host Help shows the local filesystem path so you can attach the file; that path is not uploaded. `GET /api/diagnostics/bundle/{name}` only serves zips registered by a POST in this Studio process.

Redaction replaces home, workspace, and cache roots (`PODCAST_MCP_CACHE`) plus share URL segments after `/r/` and `/rec/` (coolname slugs, including connector words, and legacy `token_urlsafe` values). Bare coolnames in free text are not scrubbed. There is no dry-run: **Create** always writes the zip (`include_logs` only toggles members). Bundle shape is locked by `DiagnosticsService` and tests (no separate `contracts/` schema).

## Docs-sync companions

This page is the owner for its docs-sync row. Also see: [README](../README.md), [ROADMAP](../ROADMAP.md) and the `podcast-setup` skill (`.agents/skills/podcast-setup/`) describe the same install path.
