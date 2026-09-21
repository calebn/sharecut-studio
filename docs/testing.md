# Testing and coverage

## Run tests (with coverage gate)

```bash
make test        # coverage gate + parallel; excludes e2e_slow / e2e_real
# or
.venv/bin/pytest -n auto -m "not e2e_slow and not e2e_real"
```

Pytest is configured in `pyproject.toml` to **fail if line+branch coverage drops below 95%** for `podcast_mcp`.

`make test` runs under [`pytest-xdist`](https://pytest-xdist.readthedocs.io/) (`-n auto`), capped at four workers to keep local runs and CI reliable under contention. An explicit `-n N` remains unchanged. `pytest-cov` merges the per-worker coverage data, so the 95% gate is unchanged. CI (`.github/workflows/test.yml`) runs the same marker filter in parallel with a `frontend` job for Sharecut Studio (`gui/web`).

Hang protection: `pytest-timeout` (`--timeout=60 --timeout-method=thread` in `pyproject.toml` addopts) and job `timeout-minutes` on the GitHub Actions workflow. Nested guest+tunnel WebSocket tests use a live uvicorn server — Starlette `TestClient` nested sockets can deadlock.

`e2e_slow` (live ASR / HF downloads) and `e2e_real` (AMI / benchmark regression) are **not** in the default gate — run `make e2e-slow` / `make e2e-real` locally or on a schedule. Fast `e2e` fixture tests stay in `make test` so coverage stays above 95%.

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
make hooks            # lint-staged formats staged Ruff/Biome; pre-push gates on make ci
make typecheck        # mypy (strict on timebase modules)
```

Do not silence findings with `# noqa` / `# nosec` without explicit approval — fix code or tighten tool config.

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

### Pre-push local CI gate

`.githooks/pre-push` (installed via `make hooks` / `./install.sh`) runs `make ci` **by default** before `git push` and **aborts the push** when any gate is red. It only accepts pushes of the current clean `HEAD` tip (non-delete `local_sha` must equal `HEAD`; dirty worktree aborts **before** `make ci`). A green `make ci` atomically writes `ci-stamp` under `$(git rev-parse --git-dir)` for that `HEAD` when the tree is still clean, so pushing the same SHA again skips the full suite. If the tree has tracked changes after a green run (for example leftover fixture writes; untracked paths are invisible to `git diff-index --quiet HEAD --`), `make ci` still exits 0 so that push can finish; it skips the stamp, and the next push re-runs `make ci` once the worktree is clean. Writing `ci-stamp` by hand (or `SKIP_CI=1` / `--no-verify`) is an intentional local-trust bypass — same machine that can disable hooks. Override with `SKIP_CI=1` only when explicitly requested.

## Fast inner loop

During development, skip coverage and the e2e/slow tiers for the quickest feedback:

```bash
make test-fast   # pytest -n auto --no-cov -m "not e2e and not slow"
```

This runs the unit suite (~900 tests) in ~25 s. It does **not** enforce the coverage gate — run `make test` before opening a PR. Excluding the e2e/slow tiers drops coverage below 95%, which is why they stay in the gated run.

To debug a single test without xdist overhead (so `-s` and `pdb` behave), invoke pytest directly without `-n`:

```bash
.venv/bin/pytest tests/test_edits.py::test_name --no-cov -s
```

## Host config isolation

`tests/conftest.py` autouse fixtures keep the suite independent of the developer machine:

- `PODCAST_MCP_PIPELINE_DEFAULTS` → repo `.agents/defaults/pipeline.yaml`
- S3-compatible object storage (`PODCAST_OBJECT_STORE_*` and `~/.config/podcast_mcp/relay.yaml`) → disabled so review-share `/audio` serves local `mix.mp3` instead of redirecting to object storage

Tests that need object storage mock `load_object_store_config` / `ObjectStoreClient` explicitly (see `tests/test_review_media_object_store.py`).

Playwright E2E launches also scrub relay and object-store deployment settings. Its
server receives an invocation-local, nonexistent `PODCAST_RELAY_CONFIG`; all
`PODCAST_RELAY_*` deployment settings and `PODCAST_OBJECT_STORE_*` values are
removed. Developer credentials and network storage therefore cannot affect browser
tests. A fixture that deliberately needs relay configuration must provide it within
the test harness; E2E does not inherit relay configuration. Share/record scenarios
each receive a disposable relocated fixture because their rooms and roster state
are stored beside the project. Before each callback, the harness opens that project
through loopback-only `POST /api/project/open`, then restores the suite project. The
`npm run test:e2e` atomically records each fixture, leases a loopback port across
processes, and deletes registered fixtures only after Playwright has terminated
its web server. It forwards `SIGINT`/`SIGTERM` to the process tree and uses a
five-second `SIGKILL` fallback. Detached descendant process groups are tracked
through forced shutdown, and the wrapper retains the fixtures and port lease if
it cannot confirm that the whole tree exited; direct helper use still removes
fixtures immediately.
Guest-share presence tests also await the lazy proxy-manifest response before
closing their browser contexts, so a server render cannot outlive the workspace
it reads; an HTTP 200 empty manifest is the
documented HTMLAudio fallback when proxy generation is unavailable. Those tests
also await host-page `networkidle` after shell hydration before creating a share,
which lets lazy host `/api/audio` stem requests settle; open WebSockets do not
block that Playwright quiescence gate.

## Adding features

1. Add or extend tests under `tests/` alongside your change.
2. Run `make test` before opening a PR.
3. If you add a new module, include at least:
   - Happy-path test
   - One edge or error case where practical

## What to test where

| Area | Test file |
|------|-----------|
| Models / project I/O | `test_models.py` |
| Filler / tighten edits | `test_edits.py`, `test_tighten.py` |
| Golden-ear A/B harness | `test_golden_ear_harness.py` (`scripts/golden_ear_harness.py`, `make golden-ear ARGS=…`) |
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
| Agent ↔ DAW session sync | `test_session_sync.py`, `test_session_state.py`, `test_gui_api.py` (session endpoints) |
| Document-command contract (schema + boundary rejects) | `test_document_command_payloads.py`, `test_document_command_boundary.py` (HTTP/WS/MCP 422/-32602 + OpenAPI↔schema) |
| Share HTTP / MCP / WS parity | `test_share_http_mcp_parity.py` (`scripts/export_docs_site_contract.py`; WS discovery + curated notes for `/api/rec/` and `/api/review/`) |
| Document handlers / caps | `test_document_sync.py`, `test_review_share.py`, `test_remote_mcp.py`, `test_structural_policy.py` |
| GUI / timeline inspector APIs | `test_gui_api.py`, `test_waveform_zoom.py` |
| Zoom-matched waveforms | `test_timeline_zoom.py`, `test_peaks.py`, `test_waveform_zoom.py` (incl. guest overview + snap ACL), `gui/web/src/audio/waveformExtract.test.ts`, `gui/web/src/timeline/drawWaveform.test.ts`, Playwright `e2e/waveform.spec.ts` (host always; guest `/r/{token}` when share tokens exist) |
| Brand / public CSS | `test_brand_color_roles.py`, `test_public_sites.py`, `test_css_policy.py`, `test_css_no_important.py` |
| Body / host security hardening | `test_security_hardening.py` (pure ASGI `MaxBodySizeMiddleware`, authz, served_project) |

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

Tests must never write into the committed fixture tree. Mutating pytest e2e tests use the `e2e_workspace` / `*_workspace` fixtures, which copy the fixture into `tmp_path` **and rewrite the copy's `meta.workspace_dir` to point at that tmp directory** (`copy_relocated_workspace` / `rewrite_workspace_dir` in `project_io.py`, used by `tests/e2e/conftest.py`). Playwright copies `aligned_dialogue` to `tmpdir`, exports that path as `DAW_E2E_PROJECT`; the `npm run test:e2e` wrapper deletes registered copies after Playwright terminates its web server. Share and record callbacks switch to their disposable project through the existing loopback-only project-open endpoint and restore the suite project before cleanup; UX screenshot runs remain pinned to their selected project. Each ordinary Playwright run allocates a loopback port and exports it as `DAW_E2E_PORT` before starting the GUI, workers, and teardown; set `DAW_E2E_PORT` explicitly for a fixed origin such as UX screenshots.

Vitest tests that copy the committed large fixture use the shared `E2E_FIXTURE_COPY_TEST_TIMEOUT_MS` (20 seconds) timeout; tests that only exercise registration failure keep the default timeout.

Committed fixtures store `workspace_dir` as `"."` (no machine-specific absolute paths). `load_project` always remaps `workspace_dir` to the directory containing `episode.project.json`. The e2e copy rewrite still matters for any code that reads the JSON without going through `load_project`, and so subsequent saves do not revive a stale path. `tests/e2e/test_fixture_hygiene.py` and `tests/test_no_machine_paths.py` guard this.

Read-only tests can still use `e2e_project_file` directly, since they only load and inspect the fixture.

## E2E fixture tests

Committed fixtures (Tier A):

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

## CI

GitHub Actions workflow `.github/workflows/test.yml` runs three parallel jobs on push and pull requests to `main`. **All three must pass** (including Playwright axe) for a green build:

| Job | What |
|-----|------|
| `pytest` | `ruff check` + `ruff format --check` + `bandit` + `vulture` + `deptry` + `mypy` + `pytest -n auto -m "not e2e_slow and not e2e_real"` (Python coverage gate) |
| `frontend` | In `gui/web`: `npm ci`, `npm run lint` (oxlint + Stylelint tokens/rem/`@container`; `!important`/`@layer` consent-gated), `npm run format:check` (Biome), `npm run typecheck` (strict `tsc`), `npm test` (Vitest + `axe-core` via `expectNoA11yViolations`; keeper PCM/WAV/segment bars in `gui/web/src/record/keeper/`; mix-minus MM1–MM9 in `gui/web/src/audio/mixMinus.test.ts`), `npm run build` |
| `frontend-e2e` | Build Sharecut Studio, install Chromium, Playwright smoke against a **temp copy** of `aligned_dialogue` (committed uint8 overview JSON under `artifacts/peaks/` so `/api/peaks/` does not need ffmpeg). Ordinary loopback Playwright launches leave `podcast gui` unpinned and explicitly provide each temporary `?project=` path, allowing share and record scenarios to use a fresh relocated fixture. `npm run test:e2e` deletes the live copy after Playwright terminates its web server (sqlite stays in the temp workspace — never rewritten in place). Host→guest follow seeds a temp premix and needs `ffmpeg` on PATH to publish the share mix. Presence follow also covers tab follow, chrome ghosts, lane-bottom no-jump, and guest Pipeline/FX degrade (`e2e/presence-follow.spec.ts`). Full-page axe via `expectPageAxeClean` in `gui/web/e2e/axe.ts`. Firefox pending-inspector layout remains [Follow-up](../ROADMAP.md#follow-up) (original #155 report was Firefox @ 1280). |

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
make test-web-e2e # Playwright smoke + full-page axe (requires `[gui]` extra / uv)
make test-desktop # Tauri scaffold + rustfmt + clippy --lib + lib tests (optional Rust)
make desktop-build # Freeze sidecar + installer (local only; not part of make ci)
make desktop-linux-appimage-docker # Ubuntu 22.04 AppImage (iterate before GHA)
make ci           # full local CI mirror; stamps git-dir/ci-stamp when the tree stays clean
make golden-ear ARGS='build --project tests/fixtures/aligned_dialogue --out /tmp/golden --limit 8'
make golden-ear ARGS='score --dir /tmp/golden --answers listen/answers.csv'
```

Golden-ear (`scripts/golden_ear_harness.py`) is an owner listening harness, not a `make ci` job. See [filler-cut-quality.md](filler-cut-quality.md) § Golden-ear protocol.

Axe policy: do not silence violations with ignore comments. Prefer native `<button>` / correct roles; share helpers (`src/test/a11y.ts`, `e2e/axe.ts`) instead of duplicating axe setup. Dense DAW chrome disables only `color-contrast` and `region` in Playwright (`expectPageAxeClean`) — other rules stay enforced. Reading surfaces (HomeScreen without `?project=`, marketing/download/company HTML) use `expectReadingSurfaceAxeClean`, which keeps contrast and region on.

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
