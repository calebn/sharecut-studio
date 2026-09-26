# Testing and coverage

## Run tests (with coverage gate)

```bash
make test        # coverage gate + parallel; excludes e2e_slow / e2e_real
# or
.venv/bin/pytest -n auto -m "not e2e_slow and not e2e_real"
```

Pytest is configured in `pyproject.toml` to **fail if line+branch coverage drops below 95%** for `podcast_mcp`.

Vitest uses four worker threads in `gui/web/vitest.config.ts`. Its default
fork pool starts a child process per test file and scales to available CPUs;
the 196-file jsdom suite intermittently stalled worker RPCs on a macOS host
with endpoint scanning. Limiting forks to four still stalled in a different
file, while four threads completed the full 1,010-test suite in 63 seconds.
This keeps file isolation and parallelism without increasing timeouts or
skipping tests. Keep a separate Playwright browser run for real-browser checks.

`make test` runs under [`pytest-xdist`](https://pytest-xdist.readthedocs.io/) (`-n auto`), capped at four workers to keep local runs and CI reliable under contention. An explicit `-n N` remains unchanged. `pytest-cov` merges the per-worker coverage data, so the 95% gate is unchanged. CI (`.github/workflows/test.yml`) runs the same marker filter in parallel with a `frontend` job for Sharecut Studio (`gui/web`).

Hang protection: `pytest-timeout` (`--timeout=60 --timeout-method=thread` in `pyproject.toml` addopts) and job `timeout-minutes` on the GitHub Actions workflow. Nested guest+tunnel WebSocket tests use a live uvicorn server — Starlette `TestClient` nested sockets can deadlock.

`e2e_slow` (live ASR / HF downloads) and `e2e_real` (AMI / benchmark regression) are **not** in the default gate — run `make e2e-slow` / `make e2e-real` locally or on a schedule. Fast `e2e` fixture tests stay in `make test` so coverage stays above 95%.

Tests that execute a Python file from `scripts/` use `tests/script_loader.py`'s
`load_script(name)`. Each call executes a fresh module without changing
`sys.modules`, matching the usual script test behavior. Pass `register=True`
only when import-time code (such as dataclass processing) needs to find the
module in `sys.modules`; the loader restores any prior entry if execution fails.

Coverage reports:

- Terminal: missing lines after each run
- `coverage.xml` for CI / IDE

## Python quality tooling

Local mirrors of the CI `pytest` job’s static checks (config in `pyproject.toml`):

```bash
make lint-py          # ruff check + bandit -ll + vulture + deptry
make format-py        # ruff format (write)
make format-py-check  # ruff format --check
make capabilities-check
make progress-check   # progress framework compliance (warn by default)
make hooks            # lint-staged formats staged Ruff/Biome; check-only pre-commit hooks
make worktree-setup   # new git worktree: hooks + venv + gui/web node_modules (pre-commit self-provisions)
make typecheck        # mypy (strict on timebase modules)
```

Do not silence findings with `# noqa` / `# nosec` without explicit approval — fix code or tighten tool config.

### Relay proxy path invariant

`tests/test_proxy_paths.py` runs a seeded, reproducible set of relay suffixes
through the tunnel mapper. It mixes guest prefixes with encoded traversal,
double encoding, query and semicolon characters, and repeated slashes. Every
mapped result must remain on the guest path allowlist and outside host-only
API routes after normalization; unsafe suffixes may raise `UnsafeProxyPath`.
Run the focused check with
`.venv/bin/python -m pytest -q --no-cov tests/test_proxy_paths.py`.

### Credential history scanning

`.github/workflows/secret-scan.yml` runs Gitleaks with complete checkout history on every
pull request, every push to `main`, a weekly schedule, and manual dispatch. The workflow has
read-only repository permission, does not comment, and does not upload a finding artifact.
The repository intentionally carries no `.gitleaksignore` baseline; test fixtures must use
values that cannot be mistaken for live credentials.
The companion public-tree provider/marker test scans blobs in the Git index, not ignored
cache files or the mutable checkout, so staged public contents are the tested boundary.

Before changing repository visibility, clone a fresh `--mirror`, fetch
`refs/pull/*/head`, and scan that mirror. The regular workflow prevents new committed
credentials; the publication audit also covers old pull-request commits and other remote refs.
Any real finding requires credential rotation first and history rewriting where exposure of the
old value would still matter.

### Dependency updates and audit

`.github/dependabot.yml` opens weekly (Monday) update PRs for every tracked lockfile
directory: `npm` in `gui/web` and `gui/desktop`, `cargo` in `gui/desktop/src-tauri`,
and `uv` and `github-actions` at the repo root. Each ecosystem groups `minor`/`patch`
bumps into a single PR so they land together (`applies-to: version-updates`); `major`
bumps always arrive as their own PR for review. A second group per ecosystem
(`applies-to: security-updates`, all packages) batches security fixes into one PR
instead of one per package. It only takes effect while Dependabot security updates are
enabled in the repository settings (see below). PR commit messages use the `chore(deps)` / `chore(deps-dev)`
prefix (`commit-message: {prefix: chore, include: scope}`). `tests/test_dependabot_config.py`
fails the build if a tracked lockfile's directory has no matching entry, so a new
lockfile location needs a new `updates` entry in the same change. Workflow and
Dependabot YAML contract tests load files through `tests/github_yaml.py`
(`load_github_yaml`), which restores the `on:` key PyYAML 1.1 parses as `True`.

The `frontend` job in `.github/workflows/test.yml` runs `npm audit --omit=dev
--audit-level=high` right after `npm ci`. It is advisory only (`continue-on-error:
true`) — the required `frontend` check does not block on upstream advisory timing,
and Dependabot opens the fix PRs. When the audit fails, the next step writes a
heading to the run's job summary (`$GITHUB_STEP_SUMMARY`) so the finding is visible
without opening step logs. Run the same check locally with:

```bash
cd gui/web && npm audit --omit=dev --audit-level=high
```

Dependabot alerts and automatic security updates are a per-repository GitHub
setting, not something this config controls; check Settings → Code security for
their current state. A `github-actions` **major** version bump (for example
`actions/checkout@v6` → `@v7`) also needs every pinned-ref contract test updated
to match; find them with `git grep -n 'actions/checkout@v' tests/`.

### GitHub CI gate

GitHub Actions runs the required full suite on public pushes and pull requests. Run focused tests locally while changing code, for example `uv run pytest -q --no-cov tests/test_effects_presets.py`; a single file cannot satisfy the repo-wide 95% coverage threshold. There is no pre-push full-CI hook or local CI stamp: contributors may push a branch and open a PR without running `make test` or `make ci` first, then use the GitHub results to make targeted fixes. Run local `make test` or `make ci` when changes are extensive or a failure needs full-suite diagnosis. Wait for the required GitHub checks on the latest PR head before merging.

## Fast inner loop

The audio-audit cache regression tests use deterministic decoder-call counts
and numerical equality, not a wall-clock ratio. One test invokes the production
`compute_word_audibility_map` path and asserts that its processed stem is decoded
once with no per-word window decodes. Machine load and filesystem state make
sub-millisecond timing thresholds flaky even when cache behavior is correct;
call accounting verifies its reuse contract directly.

During development, skip coverage and the e2e/slow tiers for the quickest feedback:

```bash
make test-fast   # pytest -n auto --no-cov -m "not e2e and not slow"
```

This runs the unit suite (~900 tests) in ~25 s. It does **not** enforce the coverage gate. Run focused tests while developing, or use the optional `make test` / `make ci` mirrors when you want local coverage or end-to-end feedback; GitHub Actions is the required gate for a pull request. Excluding the e2e/slow tiers drops coverage below 95%, which is why they stay in the GitHub-gated run.

To debug a single test without xdist overhead (so `-s` and `pdb` behave), invoke pytest directly without `-n`:

```bash
.venv/bin/pytest tests/test_edits.py::test_name --no-cov -s
```

## Host config isolation

`tests/conftest.py` autouse fixtures keep the suite independent of the developer machine:

- `PODCAST_MCP_PIPELINE_DEFAULTS` → repo `.agents/defaults/pipeline.yaml`
- S3-compatible object storage (`PODCAST_OBJECT_STORE_*` and `~/.config/podcast_mcp/relay.yaml`) → disabled so review-share `/audio` serves local `mix.mp3` instead of redirecting to object storage
- `PODCAST_SHARE_REGISTRY` → per-test `tmp_path/share_registry.sqlite` (`_isolate_share_registry`, singleton reset before/after). Do not re-`setenv` it in tests unless the test needs a specific path (verbatim-override / two-registry cases)
- `PODCAST_RELAY_CONFIG` → `tmp_path/relay.yaml` and `PODCAST_RELAY_HOST_ID` unset (`_isolate_relay_config`), so the persisted relay `host_id` never lands in the developer's home

The `published_share` factory fixture builds a premix-backed review version and
share from `minimal_project`. It reloads the project after publishing before
minting the share. `test_review_versions.py` directly checks persisted version
metadata and active selection after publishing and switching versions, and that publishing refuses a stale premix or an out-of-date master. It also
checks both premix and mastered sources: frozen WAV bytes and SHA-256 match the
source, and the saved MP3 decodes fully with FFmpeg. Pass `capabilities=[]` to
test the default capability fallback, or leave it unset for all capabilities.
The same file fault-injects MP3 export failure to check that the new version directory is
removed without changing existing review media or the source mix, and checks that a generated
ID collision does not overwrite an existing directory. Additional fault injection covers
interruption, retargeting a symlinked review root during failure cleanup, directory replacement
during both generation and persistence failure cleanup (pinned and path-based), replacement before
the service callback records its identity, failure of the identity read, and the service's
persisted-state contract. Direct `clean_created_version` tests cover replacement before the first
identity check, a version directory that is already gone (a silent no-op), quarantine creation
and open failures, a failing descriptor `close` (the other descriptor is still closed and the
empty quarantine removed), and `rmtree` failing mid-cleanup (the
quarantine is kept and the original publish error still surfaces, including when cleanup raises
a non-`OSError`).

Tests that need object storage mock `load_object_store_config` / `ObjectStoreClient` explicitly (see `tests/test_review_media_object_store.py`).

`test_review_versions.py` / `test_review_share.py` cover review-media path containment (`..`, absolute, and symlink escapes; guest routes and host `/api/audio?kind=review` return 400), and `tests/test_workspace_paths.py` covers `resolve_within`.

Playwright E2E launches also scrub relay and object-store deployment settings. Its
server receives an invocation-local, nonexistent `PODCAST_RELAY_CONFIG`; all
`PODCAST_RELAY_*` deployment settings and `PODCAST_OBJECT_STORE_*` values are
removed. Developer credentials and network storage therefore cannot affect browser
tests. A fixture that deliberately needs relay configuration must provide it within
the test harness; E2E does not inherit relay configuration. Share/record scenarios
each receive a disposable relocated fixture because their rooms and roster state
are stored beside the project. Before each callback, the harness opens that project
through loopback-only `POST /api/project/open`, then restores the suite project. It
never switches or restores to the committed `aligned_dialogue` fixture; the switch
helpers throw instead. The
`npm run test:e2e` atomically records each fixture, leases a loopback port across
processes, and deletes registered fixtures only after Playwright has terminated
its web server. It forwards `SIGINT`/`SIGTERM` to the process tree and uses a
five-second `SIGKILL` fallback. Detached descendant process groups are tracked
through forced shutdown, and the wrapper retains the fixtures and port lease if
it cannot confirm that the whole tree exited; direct helper use still removes
fixtures immediately. Project-switch requests use `http.request` with
`agent: false` to open a fresh loopback connection instead of reusing an idle
socket after a long serial suite; a socket-level regression checks this path.
This addresses the likely stale-keep-alive path for intermittent resets without
retrying a switch.
Transport failures include the nested underlying error instead of being reported
as timeouts.
Guest-share presence tests also await the lazy proxy-manifest response before
closing their browser contexts, so a server render cannot outlive the workspace
it reads; an HTTP 200 empty manifest is the
documented HTMLAudio fallback when proxy generation is unavailable. Those tests
also await host-page `networkidle` after shell hydration before creating a share,
which lets lazy host `/api/audio` stem requests settle; open WebSockets do not
block that Playwright quiescence gate.
Presence, overlay, and recording multi-page browser scenarios use the shared
`withBrowserPages` lifecycle helper (with `withTwoBrowserPages` retained as a
two-page convenience wrapper). It closes every context created during setup,
including partial context/page failures, and preserves the original setup or
scenario failure if cleanup also fails. Shared guest/host navigation helpers
observe proxy-manifest and navigation promises together, so a failed
navigation cannot leave an unhandled manifest wait behind; guest setup still
requires HTTP 200 and host setup still waits for `networkidle`.

## Adding features

1. Add or extend tests under `tests/` alongside your change.
2. Run focused tests while developing; GitHub Actions runs the required full suite after you push or open a PR.
3. If you add a new module, include at least:
   - Happy-path test
   - One edge or error case where practical

## What to test where

| Area | Test file |
|------|-----------|
| Models / project I/O | `test_models.py` |
| Filler / tighten edits | `test_edits.py`, `test_tighten.py` |
| Golden-ear A/B harness | `test_golden_ear_harness.py` (`scripts/golden_ear_harness.py`, `make golden-ear ARGS=…`; rollups require valid preference and leftover-consonant responses) |
| FFmpeg engine | `test_ffmpeg_engine.py` (requires `ffmpeg` on PATH) |
| Audition context / audio reasoning eval | `test_audition_context.py`, `test_audition_context_eval.py` (defect injection; `scripts/eval_audition_context.py`) |
| Transcript merge | `test_transcribe.py` |
| Pipeline steps / runner | `test_pipeline.py`, `test_pipeline_steps.py`, `test_runner.py` |
| CLI | `test_cli.py` |
| MCP tool handlers | `test_mcp_tools.py` |
| Config / defaults | `test_config.py` |
| History / undo-redo | `test_history.py` |
| Source↔timeline mapping | `test_session_timeline.py`, `test_timebase_regression.py` |
| Timebase architecture guards / conformance | `test_timebase_guards.py`, `test_time_conformance.py` |
| Agent ↔ DAW session sync | `test_session_sync.py`, `test_gui_api.py` (session endpoints) |
| Document-command contract (schema + boundary rejects) | `test_document_command_payloads.py`, `test_document_command_boundary.py` (HTTP/WS/MCP 422/-32602 + OpenAPI↔schema) |
| Share HTTP / MCP / WS parity | `test_share_http_mcp_parity.py` (`scripts/export_docs_site_contract.py`; WS discovery + curated notes for `/api/rec/` and `/api/review/`) |
| Document handlers / caps | `test_document_sync.py`, `test_review_share.py`, `test_remote_mcp.py`, `test_structural_policy.py` |
| GUI / timeline inspector APIs | `test_gui_api.py`, `test_waveform_zoom.py` |
| Zoom-matched waveforms | `test_timeline_zoom.py`, `test_waveform_pyramid.py`, `test_waveform_service.py`, `test_waveform_routes.py`, `test_waveform_snap.py` (incl. guest snap ACL), `gui/web/src/waveform/*.test.ts` (tile geometry, envelope reduction vs brute force, shared CPU/GL shading, stores, worker), `gui/web/src/timeline/WaveformLayer.test.tsx`, Playwright `e2e/waveform.spec.ts` (host tiles, WebGL2 + raster parity on Chromium, guest tiles through the share route with no PCM) and the compat matrix (`webgl2` or `cpu-worker`; `deep-zoom.spec.ts` geometry at the 15 M px ceiling on Chromium and WebKit) |
| Brand / public CSS | `test_brand_color_roles.py`, `test_public_sites.py`, `test_css_policy.py`, `test_css_no_important.py` |
| Body / host security hardening | `test_security_hardening.py` (pure ASGI `MaxBodySizeMiddleware`, authz, served_project) |
| Large-project benchmark fixture | `test_large_project_fixture.py` (`scripts/build_large_project_fixture.py`; two-hour shape under `e2e_real`), Playwright `e2e/large-project.spec.ts` (opt-in) |
| PCM WAV header | `test_wav_util.py` (`util/wav.py`, shared by record landing and the benchmark fixture) |

Audio integration tests skip automatically when FFmpeg is unavailable.

### Document-command API contract

Best practice: **one Pydantic source of truth**, publish + assert at every adapter.

1. Change fields in `services/document_sync/payloads.py`.
2. Run `make schema-export` (updates `schemas/document-commands.schema.json`, `docs-site/schemas/…`, `docs-site/pages/document-commands.md`, share/MCP generated tables, and guest OpenAPI).
3. Keep human docs pointing at that file / the live catalog ([session-sync.md](session-sync.md) § Document plane, [docs.sharecut.studio/#/document-commands](https://docs.sharecut.studio/#/document-commands)) — do not re-list every field in engineer markdown.
4. CI/pre-commit (`make schema-check`) fails if the checked-in schema or docs-site outputs drift.
5. `test_document_command_boundary.py` fails if OpenAPI or MCP `inputSchema` drift, or if any submit path stops rejecting bad payloads at the boundary.

TypeScript codegen uses the web project's Biome configuration; a formatter failure
must fail export/check rather than writing an unformatted artifact. Install the
`gui/web` dependencies before running the local schema gate.

Handler behavior stays in `test_document_sync.py` (constructs internal `DocumentCommand` dicts after validation).

### Timebase guards and the tool clock registry

Two meta-tests keep the source/timeline split (see [architecture.md § Timebase](architecture.md#timebase-source-vs-timeline-clock)) from regressing:

- **`test_timebase_guards.py`** scans `src/podcast_mcp` and fails if the clip mapping formula (`source_start + (t - timeline_start)`, etc.) appears outside `engines/session_timeline.py` or the `Clip.timeline_end` property. New code doing ad-hoc clip math fails CI with a pointer to `SessionTimeline`.
- **`test_time_conformance.py`** introspects every registered MCP tool; any tool with a seconds-like parameter that is missing from `TOOL_TIMEBASE` in `util/tool_timebase.py` fails. It also runs a conformance suite on a shared compressed-timeline fixture (30s removed mid-track) asserting the mapper, exports, and QC touch the correct audio region. **Adding a new time-bearing tool = one registry entry.**

### Fixture hygiene

Tests must never write into the committed fixture tree. Mutating pytest e2e tests use the `e2e_workspace` / `*_workspace` fixtures, which copy the fixture into `tmp_path` **and rewrite the copy's `meta.workspace_dir` to point at that tmp directory** (`copy_relocated_workspace` / `rewrite_workspace_dir` in `project_io.py`, used by `tests/e2e/conftest.py`). Playwright copies `aligned_dialogue` to `tmpdir`, exports that path as `DAW_E2E_PROJECT`; the `npm run test:e2e` wrapper deletes registered copies after Playwright terminates its web server. Share and record callbacks switch to their disposable project through the existing loopback-only project-open endpoint and restore the suite project before cleanup; UX screenshot runs remain pinned to their selected project. `switchE2eProject` / `withShareableProject` (via `assertDisposableE2eProject` in `gui/web/e2e/env.ts`) refuse to target the committed `aligned_dialogue/episode.project.json` (compared after `realpath`, so symlinked aliases and case variants on case-insensitive volumes are rejected too; a path that does not exist yet is compared after `path.resolve`, and any other `realpath` error is rethrown so the guard fails closed), and throw when `DAW_E2E_PROJECT` is unset and `e2eProjectPath` falls back to it. The guard covers only that file: other committed fixtures, such as `sharecut_ux_demo` (which UX screenshot runs pin the GUI to), are not checked. Specs must switch the GUI's project only through these helpers; a direct `POST /api/project/open` bypasses the guard. Each ordinary Playwright run allocates a loopback port and exports it as `DAW_E2E_PORT` before starting the GUI, workers, and teardown; set `DAW_E2E_PORT` explicitly for a fixed origin such as UX screenshots.

The Playwright copy (`createRelocatedE2eProject` in `gui/web/e2e/liveProject.ts`) mirrors the fixture's `.gitignore`: it keeps nothing under `artifacts/`, and it skips top-level `history/`, `export/`, and `_build/`, any `.git`, and session-sync sqlite files (`sync.db`, `-wal`, `-shm`). Nested directories such as `transcripts/review/` are kept. This differs from Python's `copy_relocated_workspace` (`WORKSPACE_COPY_IGNORE` in `project_io.py`), which skips all of `artifacts/`. `gui/web/e2e/liveProject.test.ts` checks the rule against a seeded source tree and against the fixture `.gitignore`. `scripts/verify_remote_mcp_shares.py` without `--project` also publishes into a relocated temp copy, never into the fixture. To remove gitignored cruft an older run left in the committed fixture (for example `artifacts/review/` mixes), run `git clean -fX tests/fixtures/aligned_dialogue`.

Vitest tests that copy the committed large fixture use the shared `E2E_FIXTURE_COPY_TEST_TIMEOUT_MS` (20 seconds) timeout; tests that only exercise registration failure keep the default timeout. Unit tests for shareable-project lifecycle behavior inject a minimal fixture source so they verify isolation and cleanup without copying the committed audio payload; the default factory used by Playwright still copies the complete fixture.

Committed fixtures store `workspace_dir` as `"."` (no machine-specific absolute paths). `load_project` always remaps `workspace_dir` to the directory containing `episode.project.json`. The e2e copy rewrite still matters for any code that reads the JSON without going through `load_project`, and so subsequent saves do not revive a stale path. `tests/e2e/test_fixture_hygiene.py` and `tests/test_no_machine_paths.py` guard this.

Read-only tests can still use `e2e_project_file` directly, since they only load and inspect the fixture.

## E2E fixture tests

### Committed fixtures (Tier A)

- `tests/fixtures/aligned_dialogue/` — smoke / edits (canned transcript)
- `tests/fixtures/synthetic_bleed_60s/` — bleed/reconcile/precorrect gold
- `tests/fixtures/asr_gold/` — LibriSpeech WER regression

```bash
make e2e          # pytest -m e2e (fast: aligned_dialogue + synthetic bleed)
make e2e-slow     # adds live transcribe + asr_gold WER (e2e_slow marker)
make e2e-real     # nightly: AMI bleed + benchmark regression (e2e_real marker)
./scripts/run_e2e_battery.sh
./scripts/run_bleed_debug_battery.sh   # bleed listen + CLI reports
```

Bleed listen-through checklist: [e2e-fixture-manual.md](e2e-fixture-manual.md#bleed-debugging).

Override the project path:

```bash
export PODCAST_E2E_PROJECT=/path/to/test_fixture_5min
make e2e
```

Manual listen-through steps: [e2e-fixture-manual.md](e2e-fixture-manual.md).

Fixture registry: [fixture-catalog.md](fixture-catalog.md). Expansion plan: [e2e-real-data-plan.md](e2e-real-data-plan.md).

| Marker | Meaning |
|--------|---------|
| `e2e` | Tier A fixtures (`aligned_dialogue`, `synthetic_bleed_60s`, or `PODCAST_E2E_PROJECT`) |
| `e2e_slow` | Live transcribe / heavier pipeline (`asr_gold` WER) |
| `e2e_real` | Nightly (`ami_bleed_60s`, benchmark regression) |

E2e runs use `--no-cov` so they do not affect the coverage gate when run standalone.

### Large-project browser profile (opt-in)

Issue #29 has a disposable performance fixture rather than committed media.
`scripts/build_large_project_fixture.py` derives it from the
`aligned_dialogue` project (through `load_project` / `ProjectStore`). Run the
browser profile against it after building the web frontend:

```bash
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT
uv run python scripts/build_large_project_fixture.py --out "$tmp_dir/project"
(cd gui/web && npm run build)
DAW_E2E_PROJECT="$tmp_dir/project/episode.project.json" \
  DAW_BENCHMARK_PROJECT=1 \
  npm --prefix gui/web run test:e2e -- large-project.spec.ts
```

`--tracks N` (default 2) adds dialogue tracks `t2…` (media and clips, no
transcripts; `--clips` must divide evenly). `--waveform synthetic|silent`
(default `synthetic`) writes each track's `.wfpk` pyramid under the key the
viewer asks for, without decoding: a speech-like envelope, or all zeros. The
sparse WAVs are silent either way. `--history N` (default 500) seeds N
before/after pairs (2N entries, 1,000 by default) that toggle the first clip's
fade-in and share two full-size snapshot files (`history/snapshots/benchmark-base.json`
and `benchmark-faded.json`), so undo, redo, and diff use real snapshots without
1,000 copies on disk; `--history 0` leaves the history empty.

Keep the `large-project.spec.ts` file filter: `DAW_E2E_PROJECT` applies to the
whole Playwright run, so every other spec would otherwise run against the
benchmark project and fail. The spec skips unless `DAW_BENCHMARK_PROJECT` is
set, and fails fast when `DAW_E2E_PROJECT` does not point at a generated
benchmark project. Expected clip and utterance counts are read from the
project file, so non-default `--clips` / `--utterances` need no matching
environment variables.

The generated project is two hours long with 1,200 uniquely identified clips
and 10,000 non-overlapping transcript utterances that strictly alternate
speakers. It creates sparse silent WAVs with real two-hour source clocks (no
media blocks are consumed where the filesystem supports sparse files) and a
`.wfpk` pyramid per track under the key the viewer asks for, so waveform status
is ready at once and the timeline numbers include waveform drawing. It measures project shape and browser
surfaces, not audio fidelity. The builder rejects output below
`tests/fixtures`, an existing output directory, and arguments that would
produce sub-2 ms clips or words or a WAV beyond the RIFF size limit. It builds
in a staging directory, so a failure leaves nothing behind.

`initial-load` includes hydration (the `phase=detail` response and the first
clip). The profile then exercises timeline scroll/seek (last clip in view,
playhead at session end), transcript scroll/seek (last turn visible, playhead
moved to its seek time), and history loading (`aria-busy` cleared; the last step row is reached). With a seeded history it then opens the last step's diff (`history-diff`) and runs one Undo and Redo (`history-undo-redo`). When the seeded history has at least 200 steps (the virtualization threshold) it asserts the History list is virtualized, then tabs from the first step past the initially mounted rows, checking focus moves exactly one step per Tab (`history-keyboard`); smaller seeded histories skip that step. Undo and redo write to the generated project, so build a fresh one per run. A final `scrub-endurance` step re-opens the Transcript and runs `DAW_BENCHMARK_SCRUB_ROUNDS` rounds (default 20, a positive integer) of timeline scroll, Home/End, and 10 arrow-key seeks, printing a `large-project endurance:` JSON line of per-round DOM and post-GC heap samples. It is diagnostic only (no thresholds) and does not cover playback: the fixture WAVs are silent and headless autoplay is unreliable. Each step
waits two animation frames before sampling. It prints operation duration, DOM
node count, and the post-GC Chromium heap from CDP. Those measurements are
diagnostic only and have no machine-dependent timing threshold; the spec raises
its own test and `expect` timeouts only to bound a hung run. The GUI writes
`sync.db` and history into the generated project while it runs, so build a
fresh one per measurement (the `trap` above deletes it).

`make test` builds a two-minute fixture; the full two-hour shape is checked by
`test_large_project_fixture_default_two_hour_shape` under the `e2e_real`
marker (`make e2e-real`).

## CI

GitHub Actions workflow `.github/workflows/test.yml` runs three parallel jobs on push and pull requests to `main`. **All three must pass** (including Playwright axe) for a green build:

| Job | What |
|-----|------|
| `pytest` | `ruff check` + `ruff format --check` + `bandit` + `vulture` + `deptry` + `mypy` + `pytest -n auto -m "not e2e_slow and not e2e_real"` (Python coverage gate) |
| `frontend` | In `gui/web`: `npm ci`, `npm audit --omit=dev --audit-level=high` (advisory, `continue-on-error`, failures noted in the job summary; see [§ Dependency updates and audit](#dependency-updates-and-audit)), `npm run lint` (oxlint + Stylelint tokens/rem/`@container`; `!important`/`@layer` consent-gated), `npm run format:check` (Biome), `npm run typecheck` (strict `tsc`), `npm test` (Vitest + `axe-core` via `expectNoA11yViolations`; all `.stories.ts` and `.stories.tsx` modules are discovered, rendered with Storybook preview annotations, played, and axe-checked including body portals by `gui/web/src/test/allStories.test.tsx`; keeper PCM/WAV/segment bars in `gui/web/src/record/keeper/`; mix-minus MM1–MM9 in `gui/web/src/audio/mixMinus.test.ts`; stories/Storybook/test helpers never imported by app code or root build configs in `gui/web/src/test/storyGovernance.test.ts`), `npm run build` (Vite module-ID guard rejects story/Storybook inputs in every app build) |
| `frontend-e2e` | Build Sharecut Studio, install Chromium + WebKit (`--with-deps`), Playwright smoke against a **temp copy** of `aligned_dialogue` (no committed waveform data: pyramids build on demand from the fixture WAVs; the copy keeps nothing under `artifacts/` and skips `history/`, `export/`, `_build/`, `.git`, and sync sqlite — see [§ Fixture hygiene](#fixture-hygiene)). Ordinary loopback Playwright launches leave `podcast gui` unpinned and explicitly provide each temporary `?project=` path, allowing share and record scenarios to use a fresh relocated fixture. `npm run test:e2e` deletes the live copy after Playwright terminates its web server (sqlite stays in the temp workspace — never rewritten in place). Host→guest follow seeds a temp premix and needs `ffmpeg` on PATH to publish the share mix. Presence follow also covers tab follow, chrome ghosts, lane-bottom no-jump, and guest Pipeline/FX degrade (`e2e/presence-follow.spec.ts`). Full-page axe via `expectPageAxeClean` in `gui/web/e2e/axe.ts`. Then runs the Chromium/WebKit compatibility matrix (`npm run test:e2e:compat`; see [§ Browser compatibility matrix](#browser-compatibility-matrix)). Firefox pending-inspector layout remains [Follow-up](../ROADMAP.md#follow-up) (original #155 report was Firefox @ 1280). |

The Playwright job and `make test-web-e2e` build with `VITE_SHARECUT_E2E=1` so
recording test hooks are available. Ordinary `npm run build` omits them; its
bundle guard fails if E2E page flags or signal counters remain in emitted assets.

`expectPageAxeClean(page, selector)` can also check a focused surface; the open transport-menu test scopes its axe check to the menu while unrelated track-header and loading-timeline ARIA names are tracked in #114. Do not disable additional axe rules to hide failures.

### Record-room Playwright scenarios

The room-tone Accept browser scenario opts into a deterministic PCM harness in
addition to the existing `e2e=1` and Playwright init flags. Headless Chromium's
fake microphone may remain live while its `AudioContext` clock advances too
slowly to feed the worklet. The harness is limited to that explicitly flagged
test, then follows the normal PCM-to-WAV, OPFS, and Accept code paths; it must
not change the production capture timeout or be enabled by general E2E setup.
The test pre-arms a response matcher immediately before Accept and waits for a
successful acknowledged room-tone upload (`file_ack: true`) after consent; it
does not assert the transient `Recording room tone…` copy, which can be missed
under full-suite scheduling. Upload is consent-gated, so Accept is the earliest
point at which the request can occur.

The US-1 scenario (`records a remote interview end to end`) waits for at least
1 s of guest keeper PCM before Stop, then polls the host upload API until the
guest's and the host's keeper segments are all file-ACKed. It lands through
whichever comes first, ACK auto-land or an enabled Land button, polls the saved
project JSON until the three live comments appear in `review.comments[]`
(each within ±0.25 s of the host recording clock around its press), checks that
both Ava's and the host keeper's landed clips point at files under `raw/`, and
checks server-side that the producer has no upload rows and that the host
panel's upload list has no producer row. It closes the room dialog with
its Close button once enabled; close stays disabled while the host keeper upload
settles.

### Browser compatibility matrix

After the full fast Playwright suite in bundled Chromium, `frontend-e2e` runs
the focused `gui/web/e2e-compat/` matrix (`playwright.compat.config.ts`) in
bundled Chromium and Playwright WebKit. It covers the project shell and playback
control, the phone listening shell under an `iPhone 13` touch profile (coarse
pointer, viewport-derived x/y bounds), and the recording guest's
microphone-consent-to-level path. `e2e-compat/deep-zoom.spec.ts` stretches a disposable `aligned_dialogue` copy to a one-hour session (`e2e/deepZoom.ts` `stretchProjectToSession`) and zooms to `effectiveMaxZoomPxPerSec(3600)` (about 15 M px of content). At the end it checks, within 1 px: `scrollWidth`, the reachable scroll end, the last ruler label, tick offsets (`t × zoom`), tile placement on the 512 px grid ending at the session end, and envelope point and chunk offsets. Firefox is not in the matrix. Its layout limit (about 17.9 M px, from Gecko's `nscoord_MAX`; see [waveform.md § Deep zoom](waveform.md#deep-zoom)) comes from the engine source, is not measured, and is above `max_content_px`.

The recording check uses `stubSyntheticMicrophone` (`gui/web/e2e/syntheticMicrophone.ts`):
`getUserMedia` returns a live oscillator track, and the test polls the Level
meter until it reads a non-zero value. Chromium keeps its native Permissions
API; WebKit hides `navigator.permissions` so the matrix exercises Safari's
missing-`permissions.query` branch (`src/record/micPermission.ts`). It does not
verify native permission prompts, hardware capture, or keeper audio. Record
rooms and E2E flags come from the shared `gui/web/e2e/recordRoom.ts` helpers.
This keeps coverage focused on high-risk entry points without multiplying the
full suite across engines.

The compat config pins `workers: 1` / `fullyParallel: false` (one shared web
server and live project fixture) and writes to `test-results/compat` so the
main run's traces survive. `playwright.config.ts`, `playwright.compat.config.ts`,
`e2e-compat/`, and the shared recording helpers are type-checked through
`gui/web/tsconfig.e2e.json` as part of `npm run typecheck`. The E2E
TypeScript project includes every `e2e/` helper and spec as well as
`e2e-compat/`, so new Playwright files receive the same strict check.

Run it locally (or use `make test-web-e2e`, which runs both suites):

```bash
cd gui/web
npm ci
npm run test:e2e:install   # chromium + webkit
npm run build
npm run test:e2e:compat
```

Playwright WebKit is a useful Safari-compatible signal, but it is not a test of
Apple's Safari browser. To exercise an installed branded Chrome locally, set
`E2E_BRANDED_CHROME=1`; CI intentionally uses the reproducible bundled
Chromium engine.

Playwright traces (`trace: "retain-on-failure"`) and reports from these runs
contain guest record-share tokens (`/rec/<token>` URLs and
`/api/shares/record` responses). CI does not upload them; do not add an
artifact upload for `gui/web/test-results/` or `playwright-report/` without
redacting those tokens.

The path-filtered `.github/workflows/desktop.yml` also builds the web distribution,
runs the portable desktop scaffold checks on Linux, and runs `cargo check` for the
Windows desktop binary. The Windows job compiles WebView2-only adapters that macOS
and Linux cannot typecheck; installer creation remains in the reusable release
workflow.

Local mirrors:

```bash
make lint-py format-py-check typecheck  # Python static gates
make test         # Python coverage gate
make test-web     # Sharecut Studio lint + format:check + typecheck + vitest + build
make test-web-e2e # Playwright smoke + full-page axe + Chromium/WebKit compat matrix (requires `[gui]` extra / uv)
make test-desktop # Tauri scaffold + sidecar launcher fmt/clippy/rustc --test + rustfmt + clippy --lib + lib tests (optional Rust)
make desktop-build # Freeze sidecar + installer (local only; not part of make ci)
make desktop-linux-appimage-docker # Ubuntu 22.04 AppImage (iterate before GHA)
make ci           # optional full local CI mirror (GitHub Actions is the required gate)
make golden-ear ARGS='build --project tests/fixtures/aligned_dialogue --out /tmp/golden --limit 8'
make golden-ear ARGS='score --dir /tmp/golden --answers listen/answers.csv'
```

Golden-ear (`scripts/golden_ear_harness.py`) is an owner listening harness, not a `make ci` job. Build-time `audition_context.v2` is timeline metadata; Current and Suggested audio diagnostics are measured on their rendered WAVs, with owner-only waveform PNGs under `diagnostics/` and explicit per-side errors in `key.json`. The listener manifest remains blinded. Scoring reports acceptance rollups by cut class, full reason, and speaker track, including tie and missing-answer counts. See [filler-cut-quality.md](filler-cut-quality.md) § Golden-ear protocol.

Axe policy: do not silence violations with ignore comments. Prefer native `<button>` / correct roles; share helpers (`src/test/a11y.ts`, `e2e/axe.ts`) instead of duplicating axe setup. Dense DAW chrome disables only `color-contrast` and `region` in Playwright (`expectPageAxeClean`) — other rules stay enforced. Loading timeline and track-header containers use named `group` roles so their accessible names and busy state are valid ARIA semantics; `TrackHeadersColumn.test.tsx` and `TimelineView.test.tsx` keep those loading states covered. Reading surfaces (HomeScreen without `?project=`, marketing/download/company HTML) use `expectReadingSurfaceAxeClean`, which keeps contrast and region on.

Frontend unit and a11y details: [gui/web/README.md](../gui/web/README.md) § Testing.

## Render regression fingerprints

Optional sandbox-only hashes of **rendered** outputs (stems, premix, bounces) — not raw fixture WAVs and not the runtime audio-cache fingerprint (`audio_state_fingerprint()`). Compare against `aligned_dialogue` (or another gold fixture) so a pipeline/render change that alters audible output fails CI. Still unimplemented.

## Body limit middleware

GUI `MaxBodySizeMiddleware` ([`util/body_limits.py`](../src/podcast_mcp/util/body_limits.py)) is **pure ASGI**: it checks `Content-Length` when present, otherwise cap-buffers chunked bodies and replays them via a wrapped `receive`. Media upload paths (`/media/upload`, `/daw/media/upload`) and record keeper `…/upload` routes are skipped (route-owned caps; record parts 5 MB). Relay proxied record `…/upload` uses `max(PODCAST_RELAY_MAX_BODY_BYTES, PODCAST_RECORD_UPLOAD_MAX_PART_BYTES)` so a 5 MB part is not 413'd by the 4 MiB default.

Unit coverage: `tests/test_security_hardening.py` (413 oversized CL / no-CL, under-limit replay, CL pass-through, media-upload skip, record-upload skip).

### Local browser smoke

**Host GUI**

1. `PODCAST_GUI_MAX_BODY_BYTES=1024 podcast gui --project <fixture>`
2. In Sharecut Studio, perform a small mutating action (e.g. timeline comment) — must succeed.
3. `curl`/DevTools POST a >1 KiB body to a non-media mutating API — expect **413** `{detail, limit_bytes}`.

**Relay via Docker** (see [host-online-relay.md](host-online-relay.md) § Quick start)

```bash
docker compose -f deploy/relay/docker-compose.yml up --build
# host GUI + podcast tunnel --relay-url ws://127.0.0.1:8080/tunnel --host-token dev-host-token
# mint share with --public-base-url http://127.0.0.1:8080
```

Open `http://127.0.0.1:8080/r/<token>` and post a normal comment. Optionally lower `PODCAST_GUI_MAX_BODY_BYTES` on the **host** GUI and confirm an oversized POST still returns **413** through the tunnel.

## Remote MCP (share tokens)

Capability → tool matrix and JSON-RPC bridge: `tests/test_remote_mcp.py` (plus share routing in `tests/test_review_share.py`). See [host-online-relay.md](host-online-relay.md) § Remote MCP.

Live host matrix (requires `PODCAST_REMOTE_MCP=1` GUI already running): `scripts/verify_remote_mcp_shares.py` — see [host-online-relay.md](host-online-relay.md) § Manual verification.

Rate limits (host + relay): `tests/test_rate_limit.py`.

## Lowering the threshold

Only change `fail_under` in `pyproject.toml` with team agreement. Prefer adding tests over lowering the bar.
