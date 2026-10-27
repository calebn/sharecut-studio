# Testing and coverage

## Run tests (with coverage gate)

```bash
make test        # coverage gate + parallel; excludes e2e_slow / e2e_real
# or
.venv/bin/pytest -n auto -m "not e2e_slow and not e2e_real"
```

The required `pytest` job uses Python 3.14 and coverage 7.16.2 with CTracer. `pyproject.toml` collects line and branch coverage for `podcast_mcp` and `podcast_relay` with a 95% floor; the independent `coverage report --fail-under=95` gate also remains required. See [CI runtime](testing-ci.md#python-test-runtime).

Pause observation and finite-effect controls live in `tests/test_pause_observation_effects.py`. They use real native caches and source WAVs to distinguish a clean kept-word collar from attached breath, low-band activity and a placement-clipped sound. Saved-splice checks bind actual archive footprints and preserve whole kept sound PCM at `2/32768`. Disabled observation checks room-read state independently. These synthetic controls do not qualify real VAD or owner listening. Run them with `.venv/bin/python -m pytest -q --no-cov tests/test_pause_observation_effects.py` beside the frozen pause suites and prior source-placement controls.

The accepted-mute regression in `tests/test_source_remove_geometry.py` covers track and session removals at nonzero placement with unrelated speech. It checks exact archives, survivor placement, cache rates and recording profiles, temporary-render cleanup, and sample-for-sample equality between a source query and its BEFORE timeline window. Repeated plays and hard-linked recording aliases must not share mute evidence or hide removed source multiplicity.

Vitest uses four worker threads and two inline projects in
`gui/web/vitest.config.ts`. The `node` project runs an explicit list of 19 pure
edit, timeline, time and audio test files without DOM setup, including
`src/audio/proxyMath.test.ts` and `src/audio/wavHeader.encode.test.ts`. The
`jsdom` project runs the remaining frontend tests with `src/test/setup.ts`. Both
projects use the same list to keep their file sets disjoint, and jsdom retains
Vitest's default exclusions.
The thread pool keeps file isolation and bounded parallelism after fork workers
stalled on a macOS host with endpoint scanning. Keep a separate Playwright
browser run for real-browser checks.

Before adding a test, check existing coverage and state the behavior that the
new test covers and existing tests do not. Prefer one focused test per
invariant. Extend an existing test when it already covers that behavior. Use
the cheapest layer that faithfully exercises the behavior. Pure edit and
timeline utility calculations can use Node only when their imports and tested
paths require no DOM or shared browser setup.
Component behavior stays in jsdom, and browser behavior stays in Playwright. Before changing the
Node list, compare test discovery and results across both projects and the
full suite. Record evidence that every test runs once and retains its assertions.
Check existing coverage before adding a permanent case. Justify each expensive
browser matrix dimension by the distinct failure it can catch. Keep broad
exploratory sweeps and deliberate faults in PR evidence unless a case protects
a distinct important regression.

`make test` runs under [`pytest-xdist`](https://pytest-xdist.readthedocs.io/) (`-n auto`), capped at four workers to keep local runs and CI reliable under contention. An explicit `-n N` remains unchanged. `pytest-cov` merges the per-worker coverage data, so the 95% gate is unchanged. CI (`.github/workflows/test.yml`) runs the same marker filter in parallel with a `frontend-suite` job for ShareCut Studio (`gui/web`).

Hang protection: `pytest-timeout` (`--timeout=60` in `pyproject.toml` addopts) and job `timeout-minutes` on the GitHub Actions workflow. Nested guest+tunnel WebSocket tests use a live uvicorn server because Starlette `TestClient` nested sockets can deadlock. Enter socket contexts before handshake and explicitly close test-owned SQLite resources; see [ownership and Python runtime checks](testing-ci.md#python-test-runtime).

**How a timeout surfaces.** `pyproject.toml` deliberately sets no `--timeout-method`, so pytest-timeout uses `signal` wherever `SIGALRM` exists (Linux CI, macOS) and `thread` where it does not (the Windows jobs in `desktop.yml`). Under `signal` a slow test fails in place: the report names the test and shows `Failed: Timeout (>60.0s) from pytest-timeout.` with the source line it was stuck on (`>` marker in the traceback), followed by a `Timeout` block with the stack of every other thread, and the rest of the worker's tests still run (verified on CI with a deliberate `time.sleep(90)` test under `pytest -n auto`, run 37500548916). Under `thread` the timer calls `os._exit`, so a slow test ends the whole worker and xdist reports `[gwN] node down: Not properly terminated` and `worker 'gwN' crashed while running '<test>'` with no stack. That looks like a native crash or OOM but is just a slow test (#1041 hid for weeks this way). Do not pin `--timeout-method=thread` in addopts. If a test needs it (for example one blocked in a C call that never returns to the interpreter), mark that test `@pytest.mark.timeout(60, method="thread")` and say why in a comment. `signal` raises inside the test, so a hung teardown (a `TestClient` WebSocket context waiting on a handler that never ends) can still block after the failure is raised; the traceback printed at the timeout is the evidence to use. To reproduce a suspected timeout locally, run `pytest --timeout=<small> -n 2` on the test. The blanket 60 s is sized for that fast default suite; `tests/e2e/conftest.py`'s `pytest_collection_modifyitems` hook gives every `e2e_slow`-marked test its own `E2E_SLOW_TIMEOUT_SEC` (300 s) instead, since live ASR / heavier pipeline runs in that tier can take minutes (#795). A test that sets its own `@pytest.mark.timeout` keeps that value.

`e2e_slow` (live ASR / HF downloads) and `e2e_real` (AMI / benchmark regression) are **not** in the default gate — run `make e2e-slow` / `make e2e-real` locally or on a schedule. Fast `e2e` fixture tests stay in `make test` so coverage stays above 95%. `test_fixture_transcribe_slow.py::test_live_transcribe` runs against `aligned_dialogue`'s complete human LibriSpeech utterances and scores full reference text independently per track at the existing 12% WER ceiling. The browser ignore/restore test checks that the selected speech span starts above 0.03 RMS, falls below 1% of its original RMS when ignored, and returns to its original RMS within 0.00005 when restored.

Tests that execute a Python file from `scripts/` use `tests/script_loader.py`'s
`load_script(name)`. Each call executes a fresh module without changing
`sys.modules`, matching the usual script test behavior. Pass `register=True`
only when import-time code (such as dataclass processing) needs to find the
module in `sys.modules`; the loader restores any prior entry if execution fails.

Coverage reports:

- Terminal: missing lines after each run
- `coverage.xml` for CI / IDE

### Pytest CI reports

The required `pytest` job uploads `pytest-reports` for seven days. It contains
`pytest.log`, the native pytest terminal output; `pytest.xml`, JUnit XML with
per-testcase durations; and `context.txt`, which records the Actions run, commit,
Python and test-tool versions, FFmpeg version, worker invocation, marker filter, and
coverage gate provenance. The pytest command also prints up to 100 phases that
took at least 0.1 seconds with `--durations=100 --durations-min=0.1`.

These measurements answer different questions. Pytest phase durations report
the slowest setup, call, and teardown phases, while JUnit testcase durations
report each test's elapsed setup, call, and teardown time by default. Summing
those testcase durations adds work that can overlap across workers. Neither is
the parallel suite's wall time or the Actions step or job duration. Compare the report with the recorded versions,
run, worker policy, and coverage gate. Pytest truncates the duration list at 100
entries, so phases below the 0.1-second cutoff and remaining phases beyond the
100-entry limit are absent. A duration alone does not show a cause, attribute time to a
subprocess, or prove that a change saves time. Inspect the relevant test and
dependencies, then isolate a candidate with bounded runs before claiming a cause
or savings.

Test jobs also add a per-area summary to the GitHub job summary. Python uses
JUnit testcase records, Vitest uses its JSON reporter, and the main, compatibility,
and Storybook browser jobs use Playwright JSON reports. Browser matrix jobs show
their own shard row. Counts represent logical tests, so a Playwright retry does
not add another test. Durations sum testcase or attempt times and can overlap
when tests run in parallel. They are not job wall time. A missing or unreadable
report appears as unavailable, and the summary does not change the test result.

## Project and history compatibility

The required `pytest` job always runs `scripts/project_compat.py check` and
`tests/test_project_compat.py` before the full, web, or docs test selection.
Its trusted base is the PR base SHA, the previous push SHA, or the checked-out
SHA for scheduled and manual runs. The check cannot be skipped by a docs-only
or web-only diff.

Run the focused checks with:

```bash
uv run python scripts/project_compat.py check --base origin/main
uv run pytest -q --no-cov tests/test_project_compat.py tests/test_project_format.py tests/test_history.py
```

The added tests protect persisted schema drift, snapshot replay and field loss,
release-ledger and frozen-inventory preservation, producer provenance, and CI
activation. Producer checks reject tracked changes and untracked runtime source,
while allowing ignored bytecode and untracked files outside the runtime paths.
Temporary Git repositories exercise the release policy with explicitly
synthetic inputs. Test doubles exercise the dormant CLI runner's failure paths;
they are not migration proof. These are JSON, file, and local Git checks. They do
not render audio, download models, or add browser tests.

The dedicated development fixture has complete history and a raw stub. Existing
fixtures outside that corpus provide project-only round trips, including the AMI
fixture whose referenced history files are absent. The released corpus is empty
until an actual tester build is captured. See the
[format policy and capture procedure](project-format.md#compatibility-boundary).

## Python quality tooling

Local mirrors of the CI `pytest` job’s static checks (config in `pyproject.toml`):

```bash
make lint-py          # ruff check + absolute-level lint + bandit -ll + vulture + deptry + scripts/check_coded_errors.py (no bare PermissionError/ValueError in services/)
make format-py        # ruff format (write)
make format-py-check  # ruff format --check
make generated-check  # every generated artifact and contract check (tests/test_generated_artifacts.py), plus the two Biome-formatted exporters
make hooks            # lint-staged formats staged Ruff/Biome; check-only pre-commit hooks (incl. service-boundaries)
make worktree-setup   # new git worktree: hooks + venv + gui/web node_modules (pre-commit self-provisions)
make typecheck        # mypy (strict on timebase modules)
```

Do not silence findings with `# noqa` / `# nosec` without explicit approval — fix code or tighten tool config.

`scripts/check_level_literals.py` fails on a negative dB literal in `edits/` or `engines/`: every
detection level is an offset from the track's `LevelProfile`. `tests/test_level_literals.py` runs
it in the pytest job. Its partner is the one gain contract, `tests/test_tighten_gain_invariance.py`:
each detector entry point decides the same at 0, -12 and -24 dB and with one track alone 24 dB
down. Add a new detector there, not a per-detector gain test ([audio-engineering.md § Detection
levels](audio-engineering.md#detection-levels)).

### Tests never wait on time

A test waits on an event or a state, never on a clock: no `time.sleep`, `asyncio.sleep` or
Playwright `waitForTimeout` (D5, [#1446](https://github.com/calebn/sharecut-studio/issues/1446)). Poll
a condition, await the signal, or use a locator assertion. `scripts/check_test_waits.py` (run by
`make lint-py`; CI runs it through `tests/test_test_waits.py` in the pytest job) counts these calls in `tests/` and `gui/web/e2e*`
and compares each file with `contracts/test-wait-allowlist.json`. The list is a ratchet: a file
may not gain a wait, an unlisted file may not have one, and a file that lost waits must lower its
count with `python scripts/check_test_waits.py --write`, so the list only shrinks. One more rule for
the soft test budget (#1410): one test per invariant.

### Relay proxy path invariant

`tests/test_proxy_paths.py` runs a seeded, reproducible set of relay suffixes
through the tunnel mapper. It mixes guest prefixes with encoded traversal,
double encoding, query and semicolon characters, and repeated slashes. Every
mapped result must remain on the guest path allowlist and outside host-only
API routes after normalization; unsafe suffixes may raise `UnsafeProxyPath`.
Run the focused check with
`.venv/bin/python -m pytest -q --no-cov tests/test_proxy_paths.py`.

### Deploy config validation

The path-filtered `.github/workflows/deploy-config.yml` (`deploy/**`, the workflow and its script) runs
`scripts/check_deploy_config.sh` on Linux. It covers every `Caddyfile*` and `docker-compose*.yml` found under
`deploy/`, so a new file is checked without editing the script:

- `caddy validate --adapter caddyfile` runs inside the official `caddy` image, pinned by manifest-list digest in
  `CADDY_IMAGE` (bump it by hand; Dependabot does not read it). `RELAY_DOMAIN` is a placeholder so
  `Caddyfile.prod`'s `{$RELAY_DOMAIN}` resolves.
- `docker compose -f <file> config -q` runs for each Compose file, plus the production file with the build overlay
  (the documented `-f docker-compose.prod.yml -f docker-compose.build.yml` invocation). Placeholder values for
  `RELAY_DOMAIN`, `RELAY_IMAGE` and `PODCAST_RELAY_HOST_TOKENS` are non-secret strings; never put a real token in the script.
- Production fails closed: with each of those three variables unset in turn, `docker-compose.prod.yml` must be
  rejected with its `set <VAR>` message.

`tests/test_relay_caddyfile.py` still string-checks the Caddyfiles and Compose files for content the tools
cannot judge (no `file_server`, redaction pattern behavior, the shell secret guard). Its `${VAR:?...}` substring
assertions were removed because the fail-closed step now exercises them through real Compose.
`tests/test_deploy_config_workflow.py` pins the workflow trigger paths, the digest pin and the file discovery.
Run the same check locally (needs a Docker daemon) with `./scripts/check_deploy_config.sh`.

### Credential history scanning

`.github/workflows/secret-scan.yml` runs Gitleaks with complete checkout history on every
pull request, every push to `main`, a weekly schedule, and manual dispatch. The workflow has
read-only repository permission, does not comment, and does not upload a finding artifact.
The repository intentionally carries no `.gitleaksignore` baseline. Test credentials use
obvious placeholders; public state certificates retain their real digest format.
`.gitleaks.toml` extends the default rules with scoped allowlists on `generic-api-key`.
The first matches lines in
`src/podcast_mcp/engines/models/whisper.py` / `engines/models/word_aligner.py` that pin a model file by sha256
(`_…_SHA256 = "<64 hex>"` constants and `("<file>", "<64 hex>")` entries). It matches lines,
not commit fingerprints, so it still holds after a rebase-merge rewrites SHAs;
`tests/test_secret_scan_workflow.py` checks its scope and that every pin line fits it.
The second matches only the three exact public `base_token` SHA-256 predecessor
certificates in the document-delta golden fixtures. These identify state and grant no
authentication authority. Other fields, files, and digest values remain scanned.
Do not add inline `# gitleaks:allow` comments to those modules; the same test rejects them.
The companion public-tree provider/marker test scans blobs in the Git index, not ignored
cache files or the mutable checkout, so staged public contents are the tested boundary.
It also fails on any **public** (globally routable) IPv4 literal in a text blob, including
sentence-final and zero-padded forms. Private, loopback and documentation ranges
(`203.0.113.0/24` etc.) pass. Binary blobs, `*.lock` / `package-lock.json` (version tuples) and
`.svg` / `.map` / `.min.js` assets (compact path data) are skipped.
Skipped blobs are still checked by exact substring for the known server addresses in
`_SERVER_IPV4_MARKERS`. The three fixture addresses in
`_PUBLIC_IPV4_ALLOWLIST` (two public resolvers and the `1.2.3.4` placeholder) are allowed. The
scan covers dotted-quad IPv4 only (including underscore-joined names such as `RELAY_<ip>`, but
not a quad glued to a letter such as `v1.2.3.4`), not IPv6 or decimal/hex-encoded addresses; it guards against
accidental leaks, not deliberate obfuscation. On a false positive, rewrite the value (use a
documentation range for examples) or, for a new generated asset type, add its suffix to
`_IPV4_SKIP_SUFFIXES`, rather than growing the allowlist. Keep real server addresses in the
private operations repo.

The same scan fails on a **sibling-repo path** in docs, scripts and config (`.md`, `.mdc`,
`.yml`, `.yaml`, `.toml`, `.json`, `.txt`, `.sh`, `Makefile`): a `../<name>` path whose first
segment matches no file or directory name anywhere in the tracked tree points at a directory
beside the checkout, which may be a private repository. In-tree links such as `../scripts/x.sh`
pass. Source code is not scanned because tests use dot-dot paths as path-traversal input. The failure
names the file and line, never the sibling, so a private repo name does not reach CI logs.
Write a placeholder in examples, for example `../<your-overlay>/config/profile.json`. A sibling
that shares its name with a tracked directory (`../docs`) is not caught, so the rule guards
against accidents, not deliberate obfuscation.

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

The `frontend-suite` job in `.github/workflows/test.yml` runs `npm audit --omit=dev
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

CI installs from `uv.lock`, so a new upstream release reaches the required checks only
when the lock changes: through the weekly `uv` Dependabot group, or
`uv lock --upgrade-package <name>` in a reviewed PR. Before this, an unpinned
`pip install -e` took Starlette 1.8.0 the day it shipped and turned `pytest` and
`pinned-media-windows` red on every PR (#1384). The `extras-import` workflow is the one
deliberately unlocked job: it exists to catch that kind of release before users do
(see [GitHub CI gate](#github-ci-gate)). `tests/test_ci_dependency_cache.py` fails
if a workflow goes back to an unlocked `pip install -e`.

### GitHub CI gate

GitHub Actions runs the required checks on every pull request and the full suite on each retained push run for `main`, every night and on `workflow_dispatch` (see [§ Which jobs a run needs](#which-jobs-a-run-needs) and [superseded runs](testing-ci.md#superseded-prs-and-main-bursts)). Run focused tests locally while changing code, for example `uv run pytest -q --no-cov tests/test_effects_presets.py`; a single file cannot satisfy the repo-wide 95% coverage threshold. There is no pre-push full-CI hook or local CI stamp: contributors may push a branch and open a PR without running `make test` or `make ci` first, then use the GitHub results to make targeted fixes. Run local `make test` or `make ci` when changes are extensive or a failure needs full-suite diagnosis. Wait for the required GitHub checks on the latest PR head before merging.

#### Which jobs a run needs

`scripts/ci_plan.py` decides, and `test.yml` reads only its output:

| Run | `pytest` | Frontend workload (`frontend-suite`) | Browser suites (`frontend-e2e-suites`) |
|---|---|---|---|
| PR with no GUI-facing change | full suite, 95% floor | skipped | skipped |
| PR with a GUI-facing change | full suite, 95% floor | runs | `main-1of4` … `main-4of4`, then every WebKit compat spec as `compat-webkit-1of2` and `compat-webkit-2of2` |
| PR where every changed file is under `gui/web/` | only the test files that name `gui/web`, or run a `scripts/` file that does (`python3 scripts/ci_plan.py subset-tests web`), `--no-cov` | runs | as above |
| PR where every changed file is docs (`docs/`, `docs-site/`, `ux/`, `.agents/skills/`, `README.md`, `ROADMAP.md`, `AGENTS.md`) | only the test files that name those paths, or run a `scripts/` file that does (`python3 scripts/ci_plan.py subset-tests docs`), `--no-cov`, then the docs-sync gate | skipped, unless the diff also touches a GUI-facing doc such as `docs/daw-shortcuts.md` | skipped, same exception |
| Proven version-only release-please PR | planner and version-policy tests, without coverage; existing compatibility, lint, types, locked install, docs and commit gates still run | skipped | skipped |
| Push to `main`, nightly schedule, `workflow_dispatch` | full suite, 95% floor | runs | the four main shards, then complete `compat-chromium` and `compat-webkit` |

A GUI-facing path is one the browser suites or the frontend job read or talk to. `PATH_RULES` in `scripts/ci_plan.py` lists them in order, and the first match wins. The table covers `gui/web/` and the Python behind the browser: `gui/`, `services/`, `models/`, `mcp/`, `extensions/`, `history/`, `cli/` and the top-level `src/podcast_mcp/*.py`. It also covers every `contracts/` file except `contracts/test-wait-allowlist.json`, plus `schemas/`, `deploy/brand/`, `.agents/defaults/` and `config/distribution.dev.json` (the runtime loads them), the e2e and document-delta fixture projects, the scripts that `gui/web` and the frontend job run, the two cheatsheet docs, `pyproject.toml`, `uv.lock`, `.nvmrc`, `test.yml` and `.github/actions/`. The wait allowlist still runs full pytest, but it does not schedule frontend or browser jobs because only the test-wait checker reads it. The audio and edit algorithms (`engines`, `edits`, `pipeline`, `effects`, `ingest`, `clips`, `export`, `util`) run under pytest on PRs, and under the browser suites on `main` and nightly. A path that no rule matches counts as GUI-facing, so a new directory runs every browser suite. `tests/test_ci_plan.py` pins the GUI pattern list, requires a rule for every tracked file and every `src/podcast_mcp` package, checks that no rule is shadowed, and requires every repo path that code under `gui/web` names (`tests/fixtures/`, `scripts/`, `contracts/`, `schemas/`, `.agents/`, `config/`) to be classified GUI-facing. When you add a directory, classify it there. Both test subsets are computed by scanning `tests/test_*.py` for the scope's paths (and for the `scripts/` files whose source names them), never listed by hand. Main and nightly run the whole suite either way.

A web-only, docs-only, or strictly proven version-only release diff cannot move Python coverage. Every other PR still enforces the 95% floor. `main` and nightly enforce it on every run. See [native selection](testing-ci.md#native-workload-selection) and [release validation](testing-ci.md#release-refreshes-and-final-validation).

The required checks, rendered from `REQUIRED_CHECKS` in `scripts/ci_plan.py` (`python3 scripts/ci_plan.py required-checks` rewrites the table; `tests/test_ci_plan.py` fails when it is stale, when `make ci-body` drifts from the Local mirror column, or when a workflow loses the job):

<!-- ci-plan:required-checks -->
| Required check | Workflow | What it covers | Local mirror |
|---|---|---|---|
| `pytest` | `test.yml` | Lint, format, types, project compatibility, commit lint, version policy, the Python suite with the 95% coverage floor and the docs-sync gate. Plans its own scope, so it never skips. | `make lint-py` `make format-py-check` `make typecheck` `make generated-check` `make docs-sync` `make test` |
| `frontend` | `test.yml` | Aggregate over the planner and `frontend-suite` (lint, format, types, Vitest with axe, build). Succeeds when the plan orders the workload and it passes, or the plan orders none and it skipped. | `make test-web` |
| `frontend-e2e` | `test.yml` | Aggregate over the planner and the Playwright shards (`frontend-e2e-suites`), with the same fail-closed contract as `frontend`. | `make test-web-e2e` |
| `gitleaks-history` | `secret-scan.yml` | Secret scan over the full git history. Runs on every PR. | none (CI only) |
<!-- /ci-plan:required-checks -->

They report on every PR:

- `frontend-suite` and the browser matrix skip at job level only when the `changes` job does not request GUI work.
- The required `frontend` and `frontend-e2e` aggregates always run. Both use the same fail-closed contract over the planner result, its exact `gui` output, and the corresponding workload result:

| Planner result | `gui` output | Workload result | Required aggregate result |
|---|---|---|---|
| `success` | `true` | `success` | `success` |
| `success` | `false` | `skipped` | `success` |
| Any other combination | | | `failure` |

Missing, failed, cancelled, or skipped planners, malformed GUI flags, failed or
cancelled workloads, and unexpected skips therefore block the required aggregate.
The repository merge helper still requires literal `SUCCESS` from `pytest`,
`frontend`, `frontend-e2e`, and `gitleaks-history` on the exact PR head. It rejects
missing contexts, arbitrary `SKIPPED` checks, API errors, and moved heads.

Regressions in skipped areas surface on the next retained `main` push run or nightly run. Check the nightly `test` run before trusting `main`.

The `pytest` job's final step, on pull requests only, runs `scripts/docs_sync.py check --range` over the PR's base/head SHAs — the docs-sync gate from [AGENTS.md § Docs in sync](../AGENTS.md#docs-in-sync). It needs the job's `actions/checkout` at `fetch-depth: 0` (the merge base and commit trailers, not just the head commit). Run the same check locally with `make docs-sync` before opening a PR; the `docs-sync` pre-commit hook runs it on staged files but only warns.

The `pytest` job also runs `actions/setup-node`, so Python tests that invoke Node have the runtime available in CI.

The path-filtered `.github/workflows/release-wheel.yml` builds the web assets, then the sdist and wheel, installs the wheel into a clean venv, and runs `scripts/check_wheel_web_build.py --podcast`. Changes under `contracts/` and `.agents/defaults/` also trigger this workflow because those directories are force-included in the wheel as `podcast_mcp/contracts` and `podcast_mcp/defaults`. It fails unless the wheel ships `index.html` plus every file it references, the installed package loads its contracts and its default YAMLs (an install without them reads an empty pipeline config), and the installed `podcast gui` serves that `index.html` at `/`. The source archive excludes installed frontend dependencies, including hardlinked files under `gui/web/node_modules`. CI inspects archive members and rejects generated dependency trees or hardlinks. `tests/test_wheel_web_build.py` covers the build hook in the ordinary `pytest` job without npm ([setup.md § Web build in wheels](setup.md#web-build-in-wheels)).

The `extras-import` workflow (on `pyproject.toml` changes, `workflow_dispatch`, and a weekly schedule) installs every optional extra into a fresh venv without `uv.lock` and imports its modules (`tests/test_extras_import.py`, marker `extras_install`, enabled by `PODCAST_CHECK_EXTRAS=1`). The locked suite cannot see an upstream release that breaks `pip install "podcast-mcp[extra]"`; the weekly run does. The main `pytest` job skips it because the env var is unset ([setup.md § Pip extras](setup.md#pip-extras)).

### CI dependency downloads

The `pytest` and browser matrix jobs acquire the catalog-pinned prebuilt pair
through `.github/actions/setup-ffmpeg`. Sidecar builds use the same importer.
Ordinary consumer workflows have no source producer or compiler setup. The
production target catalog pins each hosted archive and original producer manifest.

Tests cover digest failure before archive opening or execution, unsafe members,
closed inventories, wrong targets, mixed pairs, source-pin and configure-input
mismatches, repair, caught Ctrl-C and publication failures, retained previous
bytes after failed restoration, restart recovery on either side of publication,
unsafe recovery roots, explicit archive admission before recovery mutation,
malformed signing receipts before execution, and signed-byte identity. Importer
tests inject failures and model completed rename states with fixture bytes.
The canonical native proof checks executable architecture, system-only linkage, exact 9.0.2,
codec encode/decode, resampling, loudness filters and PNG waveform rendering.
Windows import inspection reads PE headers with the standard library and media
children use only `SYSTEMROOT`'s `System32` directory on PATH.

Native desktop jobs execute the acquired pair on Ubuntu 22.04 x64, Intel macOS,
Apple Silicon macOS and Windows x64. A separate Ubuntu 24.04 job executes the
identical transferred Linux payload. Local native checks supplement those jobs. Load-command minimum-OS checks are separate evidence from execution on the
oldest supported OS. Source compilation is dependency production only.

Python jobs retain pip download caches where configured. Every locked installer
caller also caches uv package content by OS, architecture, Python minor, uv version, selection,
`pyproject.toml`, and `uv.lock`. Default callers of `.github/actions/install-locked-python`
export requested extras with `uv export --locked`, install those exact pins
into the captured interpreter with bytecode compilation, then pip-install the editable project.
Only `frontend-suite` selects the locked `frontend-exporters` group, checks its closure, and skips editable installation. Cache hits skip no checks.
See [locked Python installation](testing-ci.md#locked-python-installation) and [private temporary storage](testing-ci.md#temporary-storage) for pytest, browser, and extras jobs.
Browser engines, browser system dependencies, virtual environments, and installed
Node packages are not cached. Each browser matrix job installs only its declared
engine and its system dependencies with locked Playwright `--with-deps`; see [bounded apt acquisition](testing-ci.md#browser-installation).

Run the archive boundary and workflow checks with
`.venv/bin/python -m pytest -q --no-cov tests/test_ffmpeg_payload.py tests/test_build_ffmpeg.py tests/test_build_sidecar.py tests/test_ci_dependency_cache.py tests/test_ci_browser_install.py tests/test_release_desktop_workflows.py tests/test_desktop_scripts_lib.py tests/test_desktop_pack_scripts.py tests/test_updater_signing_scripts.py tests/test_browser_acceptance_matrix.py tests/test_ci_plan.py`.

### FFmpeg release acceptance

Run the FFmpeg resolver and media acceptance suites against the pair selected by
the product resolver:

```bash
.venv/bin/python scripts/verify_ffmpeg_baseline.py \
  --out-dir .audit/ffmpeg-baseline \
  --expected-version 9.0.2
```

The runner records the commands, resolved paths, canonical targets, and release
strings for both executables. Tests run with the inspected pair through child
environment overrides. It writes `ffmpeg-baseline.json` and
`media-acceptance.junit.xml` and the child's `pytest.log` under the caller's
output directory. The child ignores ambient `PYTEST_ADDOPTS` selection filters.
Any failed
test, skipped or deselected test, empty/missing/malformed JUnit evidence, or
guarded release mismatch fails the run. Omit
`--expected-version` to record another installed pair without a release guard.
Pass `--ffmpeg` and `--ffprobe` only when you need explicit command overrides.
Required Python and browser jobs use the shared pinned prebuilt pair. Native
payload jobs acquire and execute it on Ubuntu 22.04 x64, Intel and Apple Silicon
macOS and Windows x64; Ubuntu 24.04 executes the Linux artifact. Cross-platform resolver tests
control executable version evidence while keeping native path semantics.
Resolver tests alone do not establish media capability or installer acceptance.
The release and security policy is in
[setup.md](setup.md#ffmpeg-version-and-pair-policy).

## Fast inner loop

### Real microphone bleed fixtures

`tests/fixtures/lab_bleed/` contains short lossless clips from real lab
microphones. Each clip includes 50 ms of source context around its reviewed
interval so tests can observe actual audio on both sides of the mute. The
fixture manifest pins source revision and original M4A hashes,
source and reviewed timeline intervals, literal owner listening labels,
ownership uncertainty, reviewed mute intent, native format, and file plus decoded
PCM seals. The repository owner authorized publishing these short clips as
ShareCut Studio fixtures. This statement does not invent a license for the
source recordings. Full recordings and episode project JSON are excluded.

The cases preserve the owner's wording and corrections. The sounds initially
noted as a possible Caleb inhale were later corrected as non-verbal sounds not
worth keeping, with explicit intent to remove them. That case is not a breath
positive. The noisy case is manual intent to mute unwanted receiving noise, not
proof of a foreign speaker. No case gives a numeric breath onset label.

The generator requires an explicit lab checkout and verifies its revision and
original file hashes. It fully decodes originals before slicing native sample
frames, then verifies each FLAC by decoding it to PCM. Use `--verify-dir` to
compare regenerated samples with committed fixtures. PCM comparison is the
stable regeneration check; FLAC bytes may differ by encoder version. An
optional historical audition directory can independently verify selected
intervals, but ordinary tests use only committed clips and never download the
lab recording. See the fixture [README](../tests/fixtures/lab_bleed/README.md)
for commands and provenance.

`tests/test_lab_bleed_fixtures.py` verifies each clip's file and decoded PCM
seals, stereo 48 kHz frame count, and nonzero content. It parameterizes the
manually reviewed mute cases through pending proposal and host approval. It
checks silence in the candidate interior, 5 ms edge fades, unchanged audio
outside the reviewed interval, unchanged peer tracks and raw fixture files, and
an unchanged direct-Caleb mixed-speech control. These cases establish reviewed
audio behavior. They do not claim automatic speaker attribution or resolve
conservative stereo detection, which remains open in issue #945.

### Real lab tighten fixtures

`tests/fixtures/lab_tighten/` holds two 25-second, three-track windows from the
same pinned lab recording. Each window is an openable v2 project with lossless
FLAC tracks and the lab's seeded ASR words shifted to clip time.
`lana_uh_cluster` (source 1108 to 1133 s) holds Lana's dense "Uh" cluster.
`caleb_um_pause` (source 608 to 633 s) holds Caleb's `Um.` and long solo pauses.
The owner authorized publishing these clips as fixtures. Filler, backchannel
and pause labels come from the faster-whisper `base` seed, labelled `asr_seed`.
An ASR `Uh` followed by a `-huh` token is a backchannel, not a filler. The
owner listened to some clips on 2026-10-05, and `OWNER_VERDICTS` in the
manifest holds those keep and cut verdicts apart from the regenerated labels.
Unheard labels stay ASR-only. The manifest pins revision, M4A and ASR hashes,
labels, and FLAC plus decoded PCM seals. The generator shares
`tests/fixtures/lab_clips.py` with `lab_bleed`. See the fixture
[README](../tests/fixtures/lab_tighten/README.md) for commands, the verdicts,
and the known ASR errors.

`tests/test_lab_tighten_fixtures.py` checks the seals, schema validity, window
transcripts, and each filler and backchannel label's level on its own track. It
then runs the Find hits pipeline step at medium intensity on a copy and checks
the hits against the owner verdicts. A `cut` pause verdict must get a pause hit,
and that test passes. No hit may overlap a kept uh-huh acknowledgment, which
also passes. A `cut` filler verdict must get a filler hit: the `Um.` passes
since padded filler cuts skip the splice checks (calebn/sharecut-studio#978).

The audio-audit cache regression tests use deterministic decoder-call counts
and numerical equality, not a wall-clock ratio. One test invokes the production
`compute_word_audibility_map` path and asserts that its processed stem is decoded
once with no per-word window decodes. Machine load and filesystem state make
sub-millisecond timing thresholds flaky even when cache behavior is correct;
call accounting verifies its reuse contract directly.

The multi-file LRU-ordering eviction tests in `tests/test_play.py` pin each
WAV's last-use age through the `services/document/play_cache.py` `_cache_last_used` seam
(`_pin_cache_last_used`) instead of back-dating files with `os.utime`. On
relatime-style filesystems any external reader (Spotlight, backup or sync
agents) can reset a freshly written file's atime between the test's `utime` and
the eviction scan, which made the LRU assertions flaky (#735). The lease-refresh
tests (`test_play_serves_cached_wav_and_refreshes_its_retention`,
`test_play_cache_eviction_waits_for_concurrent_serve`) still back-date with
`os.utime` on purpose: they assert that serving renews the real atime lease, and
an external reader can only make atime more recent, which does not flip them.

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
- S3-compatible object storage (`PODCAST_OBJECT_STORE_*` and `~/.config/podcast_mcp/relay.yaml`) → fresh per-test YAML outside `tmp_path`, under a private worker/session parent, so review-share `/audio` serves local `mix.mp3` instead of redirecting to object storage. See [fixture allocation](testing-ci.md#object-store-fixture-allocation)
- `PODCAST_SHARE_REGISTRY` → per-test `tmp_path/share_registry.sqlite` (`_isolate_share_registry`, singleton reset before/after). Do not re-`setenv` it in tests unless the test needs a specific path (verbatim-override / two-registry cases)
- `PODCAST_RELAY_CONFIG` → `tmp_path/relay.yaml` and `PODCAST_RELAY_HOST_ID` unset (`_isolate_relay_config`), so the persisted relay `host_id` never lands in the developer's home
- Process-wide `lru_cache` answers that a patch can poison (Silero availability, the asset manifest path, mocked media probes) are cleared before and after every test (`_isolate_process_caches`). Without it, a test that patches `vad_silero.is_available` to `False` left `get_shared_vad()` returning `None` for the rest of its xdist worker (#1123). `tests/process_caches.py` lists every cache under `src/` (an `lru_cache` function or a module-level `util.bounded_cache.BoundedCache`) as `ISOLATED` (cleared) or `SHARED` (keyed by every input it reads, so a stale entry is harmless and clearing would only cost recompute); `tests/test_process_caches.py` fails when a new cache is in neither list. Classify a new cache in the same change

The `raising_stop_tasks` fixture makes `GuestWsConnection.stop_tasks` run its real teardown and then raise, for guest WebSocket cleanup tests. `removed_session_clients` spies on `SessionSyncService.remove_client` and returns the removed client ids in call order.

The `published_share` factory fixture builds a premix-backed review version and
share from `minimal_project`. It reloads the project after publishing before
minting the share. `test_review_versions.py` directly checks persisted version
metadata and active selection after publishing and switching versions, and that publishing refuses a stale premix or an out-of-date master. It also
checks both premix and mastered sources: frozen WAV bytes and SHA-256 match the
source, and the saved MP3 decodes fully with FFmpeg. Pass `capabilities=[]` to
test the default capability fallback, or leave it unset for all capabilities.
`test_review_versions.py` fault-injects MP3 export and persistence failures, no-replace
promotion collisions, staging identity failures, post-promotion media changes, and failed cleanup. Its direct cleanup
cases cover replacement before and during quarantine, descriptor failures, missing
directories, and a retained quarantine when removal fails. The stale quarantine sweep
requires a trusted ownership marker and identity; stale stages are also recovered.
The sweep streams O(N) entries with O(32) candidate memory, prioritizes the oldest
eligible media, and deletes at most 32 outside both project locks. An active stage lease
blocks recovery even when its directory mtime is old. Publication tests also verify
private stage mode, no-follow output creation, root permissions, and a slow WAV hash
while another process holds the commit lock.
The stage API test also requires the ownership callback before any media or lease is
created, so a direct caller cannot leave an unreachable active stage.
Subprocess tests race promotion and quarantine against an independent writer. Sweep tests
keep fresh and symlinked entries, enforce the 32-entry cap, and retarget an ancestor
symlink during root-relative quarantine creation. An identity-read failure retains only
a private stage.
Unsupported descriptor platforms fail closed before public promotion; `resolve_source_mix` runs
before that platform check, so a missing or stale mix reports its own portable error even when
`_SAFE_FAILED_CLEANUP_SUPPORTED` is `False` (`test_publish_reports_a_missing_mix_before_the_platform_refusal`).
`tests/review_platform.py` holds the shared `requires_safe_cleanup` / `requires_safe_failed_cleanup`
skip markers so `test_review_versions.py`, `test_project_commit_lock.py`, and the
publication-dependent cases in `test_share_registry.py` skip the same
staging/quarantine/publication tests together on a platform without safe, descriptor-relative
directory operations (Windows); an autouse fixture defined once there (`unmarked_tests_run_as_unsupported_platform`, imported by name into all three modules)
forces both flags off for any test without one of those markers, so a test that stages media without
`requires_safe_failed_cleanup` fails on POSIX too, not only on the Windows job (the fixture patches only the pytest process, so a spawned child that stages media still needs the marker);
`tests/test_share_registry.py` imports the same fixture and marks only its 11 tests
whose setup publishes review media (14 cases including parameters), so its direct
SQLite registry coverage remains active on Windows;
`test_review_publication_support_matches_the_ci_platform` guards
that those flags are `True` on POSIX and `False` on Windows, so CI cannot silently start skipping
them everywhere.

[SQLite retry diagnostics](testing-ci.md#sqlite-registry-failure-diagnostics) explain child tracebacks and parent queue timeouts.

Tests that need object storage mock `load_object_store_config` / `ObjectStoreClient` explicitly (see `tests/test_review_media_object_store.py`).

`test_review_versions.py` / `test_review_share.py` cover review-media path containment (`..`, absolute, and symlink escapes; guest routes and host `/api/audio?kind=review` return 400), and `tests/test_workspace_paths.py` covers `resolve_within`.

Playwright E2E launches also scrub relay and object-store deployment settings.
Registry and identity SQLite files live beside the existing invocation cleanup
manifest in its private directory. `runE2e` supplies both paths to Playwright;
the Playwright config validates that owned manifest before either fixture helper
can copy a project, change fixture environment variables, or write the live
workspace stamp. This also protects direct Playwright commands such as `--list`,
which do not pass through `runE2e`. The config and GUI launcher derive child
environment paths from the same manifest. Direct fixture-helper callers may still
use a missing manifest and clean up their returned copy locally; the wrapper owns
registered fixture cleanup after confirmed process shutdown, and retains state
when shutdown is unconfirmed.

`make ux-demo-screens` uses the same npm wrapper and copies the existing demo
fixture, including a supplied `UX_DEMO_PROJECT`, before changing review state.
The GUI launcher renders the copied preview and seeds guest shares in that
invocation's registry before startup.
Its token JSON stays in the manifest directory. `UX_DEMO_SCREENS_DIR` selects an
alternative screenshot output directory; the default remains `ux/assets/screens`.
The target does not rebuild or restore a caller's fixture. Run `make ux-demo`
separately when the showcase fixture needs rebuilding.

The E2E server receives an invocation-local, nonexistent `PODCAST_RELAY_CONFIG`; all
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
2. Run focused tests while developing; GitHub Actions runs the required checks after you push or open a PR, and the full suite on `main` and nightly ([§ Which jobs a run needs](#which-jobs-a-run-needs)).
3. If you add a new module, include at least:
   - Happy-path test
   - One edge or error case where practical

## Browser test scope and runtime

Use the lowest test layer that can catch the defect. Keep a few complete user
journeys and focused browser regressions; do not repeat every component state
through a live GUI server. This follows the [test pyramid](https://martinfowler.com/bliki/TestPyramid.html)
and [Playwright guidance](https://playwright.dev/docs/best-practices) to test
observable behavior with isolated state and web-first assertions.

| Test layer | Owns | Examples |
| --- | --- | --- |
| Python domain/services and API tests | Edit math, authorization, validation, history, file persistence, pipeline contracts | A rejected command leaves state intact; undo restores an edit |
| Vitest components, hooks and adapters | Rendering, form validation, state transitions, error recovery and request payloads | A blocked alignment request can be turned off; a refine waiver offers retry without approving |
| Playwright browser regressions | Behavior requiring browser layout, native input, media, storage or network integration | Clipped dialogs, native keyboard routing, waveform pixels, microphone/OPFS recovery, IndexedDB replay and WebSocket reconnect |
| Playwright core journeys | A small set of complete outcomes across real services | Capture/upload/landing, transcript correction and undo, review-share playback, non-silent export |

CSS paint, hit testing, viewport geometry and full-page axe checks stay in
Playwright because jsdom cannot prove them. Keep Chromium/WebKit coverage for
engine-sensitive behavior in `e2e-compat/`; do not multiply every component case
across engines. Live ASR and model downloads remain in their separate slow tiers.

Vitest also scans production source for supported local render-time calls to
`useStableCallback`. In-memory mutations prove detection at every current
declaration. Runtime tests preserve committed callbacks through bailouts and
suspended transitions. This is bounded test-time enforcement; it adds no runtime
guard. Coverage and syntax limits live in the [frontend testing contract](../gui/web/README.md#testing).

Before adding a browser test, name the browser or integration seam it protects.
When its API responses are mocked and it only checks component state or a payload,
prefer Vitest. Before removing a case, identify the test that owns its meaningful
assertions and add any missing assertions there in the same change. A button
presence check cannot prove drag/reorder behavior. Avoid adding that check as an
independent browser scenario when component tests already cover the control.

Use one comprehensive browser matrix for a shared layout contract; add focused
cases for distinct banners, roles or breakpoints only where those change the
layout. Keep tests independent. Combine related assertions within one journey
when they share setup, but do not make one test depend on another test's state.
Use observable readiness rather than fixed sleeps, except when elapsed time is
the behavior under test, such as a disconnect grace period or long press.

### Appearance grids

A grid crosses layout cells (viewport, orientation, root text size) with an
appearance (theme, reduced motion). Each added axis multiplies the browser time
of every run, so a grid keeps only the boundary cells:

- **Theme.** The theme files in `gui/web/src/styles/theme/` define only
  `--color-*` and shadow tokens, and no partial selects on `data-theme`, so a
  theme cannot change a hit test, a rectangle, a focus paint area or an
  overflow. A geometry check runs once per layout cell and takes its theme from
  `withAppearance` in `gui/web/e2e/theme.ts`, which gives two cells both themes
  and both motion settings and four cells every pairing. A check that reads
  color (axe contrast, a computed color) loops over the themes inside one cell
  and keeps the loop on one screen.
- **Root text size.** 16 px and 32 px, the smallest and largest. A size between
  them earns a cell only when a `rem` query separates it from both.
- **Viewport.** The smallest and largest cell of each band that the media and
  container queries in `src/styles` draw. A cell inside a band whose smaller and
  larger neighbours are kept runs the same CSS branch and is dropped.
- **Reduced motion.** A layout check needs one cell per setting at most. A check
  of the motion itself (transition duration, animation count) owns its pair.

To add a cell, name the CSS branch or query band it reaches that no kept cell
does. A new `for` loop over a theme, motion or text-size list, written
inline or as a named constant, or bound to a variable named for one of those
axes, fails `gui/web/e2e/gridBoundary.test.ts` unless the loop is the subject
of the check and the file, its loop count and the reason are listed there. Theme and axe checks for the
shared `ui/` primitives belong in Vitest (`expectNoA11yViolations`), not in a
browser grid.

### Reachability sweep

`gui/web/e2e-compat/reachability-sweep.spec.ts` is the one place that measures
whether a finger can use the touch surfaces. At the shell boundaries (360, 390,
767, 768, 820, 1194, 1195 wide, a phone held sideways and an iPad held sideways)
and at 16 px and 32 px root text it asserts, for every interactive control in
the shell chrome, the track sheet or inspector, the clip sheet or inspector, the
armed Select range controls and Listen, that the control

- is at least 44 CSS px, measured as its layout box (`offsetWidth` and
  `offsetHeight`, or the label of a checkbox) so a transition or transform
  cannot shrink it (#1418);
- sits inside the visual viewport once scrolled to the middle of its scroller;
- is not under another element, a scrim included, and does not spill out of the
  region that holds it.

It also holds the editing rail to one row (#1347) and sweeps the Transcript and
Pipeline panels whole at every size and text scale, the Find and replace row and
the Add term row included (#1433, #1445), and, on the tablet and desktop shells, the Comments panel with a comment typed so its action items and track picks show (phones comment from Listen, swept above). A fourth test seeds
a copy of the fixture whose first track has a volume envelope and an effect chain, so
the track surface and the envelope workspace show the Envelope point select and the
Bypass toggles. A control inside a closed `<details>` is not measured until it opens.
The sheet's hidden detent range is the keyboard route to the drawer height; a finger
swipes the header or taps the resize buttons. Page zoom is not that 32 px root:
Safari Aa 200% shrinks the layout or visual viewport while rem stays 16 px, which
the sweep never opens. The compact transport and Listen timer case (`phone-transport-zoom.spec.ts`, 197×329 and 430×932 at a 32 px root) was deleted with the transport bar and Listen hero (#2292); the stage frame's phone chrome is measured through `gui/web/e2e/compactChromeFixture.ts`. A WebKit case checks browser layout at that width; it does not reproduce native
Safari's select painting or stand for a physical iPhone. `gui/web/e2e/reachability.ts` is the measuring helper. It
leaves out only the canvas dense targets (fade corners, trim handles, clip
bodies, the ruler, the deselect strip, the track row's open overlay), which meet
the floor through the dense-target pattern, the track grip, which has Move
track up and down in the track sheet, the transcript words and their timestamps
(inline text, #1602), and the Stage bar badges, whose floor the header's fixed height
waives by decision. Findings outside the swept surfaces are lines on
#1445's Ledger. A new control that fails the sweep is
fixed, or its class is named in that list with the equivalent control that
replaces it. The selection surfaces themselves are covered at the unit level by
`gui/web/src/stage/edit/selectionSurface.test.tsx`, which renders every selection
kind on the phone, tablet and desktop shells and asserts a non-empty body, its
actions in the one place the shell offers them, and no range control behind a
sheet's scrim.

Comment pins use the approved dense-target size exception through
`ReachScan.sizeExempt`. Its selectors match the interactive element itself,
so a pin's child controls still hold the 44 px floor. Pins remain subject to
viewport, containment, and midpoint hit-test checks. Existing `dense` selectors
retain their whole-target exclusion. `gui/web/e2e/reachability.test.ts` executes
the scanner callback with explicit jsdom geometry to check these rules. Browser
runs prove the layout and the clip midpoint tap's exact `Clip` selection.
A pin is `--touch-min` wide on touch and one marker row tall, so the exemption
covers its height only; `gui/web/e2e/comment-pins-touch.spec.ts` holds its
width to the floor and proves that a tap beside a pin picks it, a tap on a clip
under the lane never does, and the chooser picks each pin of a stack (#1742).

The compatibility matrix's offline comment replay and socket reconnect tests
each use a private project through `withShareableProject`. Queue accounting
and both reconnect pages use that project's path. Each producer compares the
suite project's persisted `review.comments` before and after restoration.
The replay identity, queue drain, rendered comments, and socket delivery
assertions run inside the private project. The sweep still uses the suite
project, so unexpected persisted comments remain observable.

Both browser suites currently run serially against shared live project state.
Do not raise `workers` or enable `fullyParallel` until each worker owns its GUI
server, project, share registry and output directory. Retries are failure
recovery, not a runtime optimization. Both suites retry a failed test once in
CI, so one flake does not force a job rerun.

CI runs the main suite as four shards (`main-1of4` ... `main-4of4`, each
`npm run test:e2e -- --shard=i/4`). On `main`, nightly and dispatch it runs the
compatibility suite as two complete engine jobs (`compat-chromium`,
`compat-webkit`, each `npm run test:e2e:compat -- --project=<engine>`). On a
pull request it runs every WebKit compat spec in two shards instead
(`compat-webkit-1of2`, `compat-webkit-2of2`, each
`--project=webkit --shard=i/2`) and no Chromium compat. All of them run
concurrently in separate `frontend-e2e-suites` matrix jobs, and
`scripts/ci_plan.py` builds the list (see
[§ Which jobs a run needs](#which-jobs-a-run-needs)). Each runner owns its checkout,
server, project and artifacts, so the serial-within-one-server assumption above
holds inside every shard. With `fullyParallel: false` Playwright shards by spec
file and balances shards by test count, not duration. Four shards bounded the
slowest shard at about 5 minutes of test time against 17 minutes for the whole
suite (from the 2026-10-06 `main` timing report, whose heaviest file is
`inspector-responsive.spec.ts` at about 3 minutes); the single-job form was
hitting its 20-minute timeout (#1022). Re-check the split from the timing
reports when specs are added, and raise the shard count in `test.yml` (keep
every `i/n` present) before any shard nears the job timeout. Specs must not
depend on state left by another spec: which specs share a shard changes with
the shard count.

Each compatibility job runs its selected inventory with one worker and one retry in CI.
WebKit retains every spec and compat Studio axe assertion. Main and reading scans remain enabled.
Compat Chromium omits only comment-undo and transcript-wordbar with guarded exact main owners.
Retained scenarios keep all non-axe assertions. See [the ownership map](testing-ci.md#browser-acceptance-matrix). Its timeout is configured in
`.github/workflows/test.yml`.
`tests/test_browser_acceptance_matrix.py` rejects missing,
duplicate or filtered engine selections, checks their disjoint coverage, and
checks that the PR shards cover the whole WebKit project.
The compact history reach test attaches each control's name, rectangle and
center hit stack, plus a screenshot, before asserting ownership. These receipts
preserve the covering element even when a later assertion fails.

The required `frontend-e2e` check waits for every matrix job. It fails for any
failed or cancelled one, for a skipped one the plan did not skip, and whenever
the `changes` job did not succeed. `fail-fast: true` cancels the other suites
once one fails, because a rerun repeats the whole set anyway. Local wrappers
still run sequentially within one checkout.

CI uploads one `playwright-reports-<name>` artifact per matrix job
(`playwright-reports-main-1of4` ... `playwright-reports-main-4of4` and
`playwright-reports-compat-chromium` and `playwright-reports-compat-webkit`, or
`playwright-reports-compat-webkit-1of2` and `-2of2` on a PR) on successful and failed runs. Each holds
`<name>.json` with per-test durations, retries and errors. The matrix sets
`PLAYWRIGHT_JSON_OUTPUT_FILE` for each job. Download them all with
`gh run download <run-id> --pattern 'playwright-reports-*'` and sum durations
per spec file across the shard reports. Compare successful runs at the same
test scope, and separate browser execution from dependency install and
server/build setup. A local timing run can use
`PLAYWRIGHT_JSON_OUTPUT_FILE=/tmp/main.json npm run test:e2e -- --reporter=json`,
and `npm run test:e2e -- --shard=2/4` reproduces one CI shard.
Playwright uploads native `trace.zip` and `error-context.md` files as separate
`playwright-test-results-<name>` artifacts whenever either file exists. This
also retains diagnostics from a failed attempt when a retry passes. The upload
keeps the matrix suffix and seven-day retention. It excludes Playwright run
metadata from clean jobs.

## What to test where

| Area | Test file |
|------|-----------|
| Models / project I/O | `test_models.py` |
| Filler / tighten edits | `test_edits.py`, `test_tighten.py` |
| Golden-ear A/B harness | `test_golden_ear_harness.py` (`scripts/golden_ear_harness.py`, `make golden-ear ARGS=…`; rollups require valid preference and leftover-consonant responses) |
| FFmpeg engine | `test_ffmpeg_engine.py` (requires `ffmpeg` on PATH) |
| Architecture, media facade and context boundaries | `test_media_facade.py`, `test_service_boundaries.py` (all five architecture assertions use one uncached real-tree scan; an independent patched-root scan checks isolation); focused behavior in `test_bounce.py`, `test_services_ingest.py`, `test_media_store.py`, `test_proxy_media.py`, `test_review_media_object_store.py`, `test_services.py`, and `test_waveform_service.py` |
| Audition context / audio reasoning eval | `test_audition_context.py`, `test_audition_context_eval.py` (defect injection; `scripts/eval_audition_context.py`) |
| Transcript merge | `test_transcribe.py` |
| Pipeline steps / runner | `test_pipeline.py`, `test_pipeline_steps.py`, `test_runner.py` |
| CLI | `test_cli.py` |
| MCP tool handlers | `test_mcp_tools.py` |
| Config / defaults | `test_config.py`; `test_pipeline_config.py` asserts every `ParamField.default` equals `.agents/defaults/pipeline.yaml`, and that the align module constants match it |
| History / undo-redo | `test_history.py` |
| Source↔timeline mapping | `test_session_timeline.py`, `test_timebase_regression.py`, `test_pause_trim_geometry.py` |
| Native sample grid (raw projection, placed playback and the peer guard keep the same samples) | `test_native_sample_grid.py` |
| Timebase architecture guards / conformance | `test_timebase_guards.py`, `test_time_conformance.py` |
| Agent ↔ DAW session sync | `test_session_sync.py`, `test_gui_api.py` (session endpoints) |
| Document-command contract (schema + boundary rejects) | `test_document_command_payloads.py`, `test_document_command_boundary.py` (HTTP/WS/MCP 422/-32602 + OpenAPI↔schema) |
| Share HTTP / MCP / WS parity | `test_share_http_mcp_parity.py` (`scripts/export_docs_site_contract.py`; WS discovery + curated notes for `/api/rec/` and `/api/review/`) |
| Document handlers / caps | `test_document_delta.py`, `test_document_sync.py`, `test_review_share.py`, `test_remote_mcp.py`, `test_structural_policy.py` |
| Review roles (Viewer / Commenter / Editor) | `test_share_roles.py` (role → capabilities, CLI and MCP mint by role only, guest MCP allowlist per role), `test_guest_document_gate.py::test_each_role_runs_exactly_its_document_commands` (role × document command matrix) |
| Document submit crash consistency (every store handoff, lock contention) | `test_document_submit_crash_recovery.py`, `test_project_commit_lock.py` (spawned children are reaped with `tests/process_helpers.py` `reap`, which kills a child that hangs) |
| GUI / timeline inspector APIs | `test_gui_api.py`, `test_waveform_zoom.py` |
| Ripple trim preview, saved geometry, and atomic timeline-zero refusal | `test_ripple_scope_contract.py`, `test_trim_clip_edge.py`, `gui/web/src/edit/ripplePreview.test.ts` (`contracts/ripple-scope.json`), `gui/web/src/timeline/ClipBlock.test.tsx`, `gui/web/src/inspector/useNudgeRun.test.tsx`, `gui/web/e2e/ripple-overlap-proof.spec.ts` |
| Zoom-matched waveforms | `test_timeline_zoom.py`, `test_waveform_pyramid.py`, `test_waveform_service.py`, `test_waveform_routes.py`, `test_waveform_snap.py` (incl. guest snap ACL), `gui/web/src/waveform/*.test.ts` (tile geometry, envelope reduction vs brute force, shared CPU/GL shading, stores, worker), `gui/web/src/timeline/WaveformLayer.test.tsx`, Playwright `e2e/waveform.spec.ts` (host tiles, WebGL2 + raster parity on Chromium, guest tiles through the share route with no PCM) and the compat matrix (`webgl2` or `cpu-worker`; `deep-zoom.spec.ts` geometry at the 15 M px ceiling on Chromium and WebKit) |
| Brand / public CSS | `test_brand_color_roles.py`, `test_public_sites.py`, `test_css_policy.py`, `test_css_no_important.py` |
| Body / host security hardening | `test_security_hardening.py` (pure ASGI `MaxBodySizeMiddleware`, authz, served_project) |
| Tighten propose/apply benchmark | `benchmark_tighten.py` (`pytest -m slow tests/benchmark_tighten.py`; per-cut time budgets: apply 2 s, propose 0.5 s; per-test `@pytest.mark.timeout` above the global 60 s), `test_benchmark_tighten_smoke.py` (two separate 40-word speaker turns with real quiet media, reviewed pauses and default-programmatic fillers; actual apply/archive counts, at most three transcript rebuilds per apply, borrowed-pad identity after later ripples, and no per-window FFmpeg calls; no wall-clock assertion in the normal suite) |
| Large-project benchmark fixture | `test_large_project_fixture.py` (`scripts/build_large_project_fixture.py`; two-hour shape under `e2e_real`), Playwright `e2e/large-project.spec.ts` (opt-in) |
| Recording keeper landing | `test_record_landing.py` probes a real reader snapshot while each keeper hash is paused and checks that both project locks are free. |
| PCM WAV header | `test_wav_util.py` (`util/wav.py`, shared by record landing and the benchmark fixture) |

Low-rate MP3 padding coverage lives in `test_waveform_pyramid.py`. The supported
9 pair reports 1.0 s after gapless trimming. The test also checks a declared
1.152 s duration against a separate full decode. The release acceptance verifier
rejects skipped or deselected tests, and the required Python coverage gate stays
at least 95 percent.

### Frontend dialog tests and initial focus

`useDialogModal` (behind `Dialog`, the Mix sheet, and the join popover) moves
focus into the panel one animation frame after it opens. A Vitest test that
focuses a field and types before that frame lands races it: the late focus
takes the caret away and the keystrokes are lost (#1117, #1112). Right after
opening, `await waitForDialogFocus()` from `gui/web/src/test/dialogFocus.ts`
(or `waitFor(() => expect(close).toHaveFocus())`) before touching a field. Do
not sleep or retry. To check a dialog test for this race, run it with
`requestAnimationFrame` delayed 5 to 60 ms; a test that waits on the observable
focus passes at every delay.

### Document-command API contract

Best practice: **one Pydantic source of truth**, publish + assert at every adapter.

1. Change fields in `services/document_sync/payloads.py`.
2. Run `make schema-export` (updates `schemas/document-commands.schema.json`, `docs-site/schemas/…`, `docs-site/pages/document-commands.md`, share/MCP generated tables, guest OpenAPI, and `gui/web/src/types/*.generated.ts`).
3. Keep human docs pointing at that file / the live catalog ([session-sync.md](session-sync.md) § Document plane, [docs.sharecut.studio/#/document-commands](https://docs.sharecut.studio/#/document-commands)) — do not re-list every field in engineer markdown.
4. CI/pre-commit (`make generated-check`) fails if the checked-in schema or docs-site outputs drift.
5. `test_document_command_boundary.py` fails if OpenAPI or MCP `inputSchema` drift, or if any submit path stops rejecting bad payloads at the boundary.

TypeScript codegen uses the web project's Biome configuration; a formatter failure
must fail export/check rather than writing an unformatted artifact. Install the
`gui/web` dependencies before running the local schema gate.
Unsupported project schemas name the model and exact JSON-escaped source path. Failed generation leaves both outputs untouched.

`test_document_delta.py` checks actual command deltas, fresh-state retry heads, same-inode/restored-mtime reloads, artifact and history certificates, cache bounds, saved-command repair, concurrent writers, guest privacy, and 10,000-clip/long-transcript byte budgets. Compact actual service projections in `tests/fixtures/document_delta/` also run through the TypeScript parser/applier. Frontend `document/authority.test.ts`, `projectionDelta.test.ts`, and `pendingDrafts.test.ts` cover predecessor recovery, HTTP-before-WS races, scope generations, copy-on-write behavior, hostile expansion, and bounded optimistic display.

`test_gain_curve_fixture.py` renders the nine cases in `tests/fixtures/gain_curve/cases.json` through FFmpeg (edge fades, then the track volume envelope) the nine in `mute_cases.json` (mute regions) and the eight in `automatic_cases.json` (off-speaker regions) and checks the fixtures; `gui/web/src/audio/gainCurve.test.ts` checks the browser preview's evaluator against the same samples, so the two cannot drift (#1649). `test_render_clock_fixture.py` likewise places the lane cases in `tests/fixtures/render_clock/cases.json` with `timeline_render.placed_track_audio` and checks the fixture (`REGEN_RENDER_CLOCK=1` rewrites it); `gui/web/src/audio/renderClock.test.ts` checks the browser's render clock against the same placed starts, so the timeline's clock and the export's cannot drift (#1888).

Handler behavior stays in `test_document_sync.py` (constructs internal `DocumentCommand` dicts after validation).

### Shared contracts

`tests/test_contracts.py` pins `util/contracts.py` for a checkout and an installed layout and fails on any JSON under `src/podcast_mcp`. `tests/test_edit_limit_constants.py` and `gui/web/src/edit/limitConstants.test.ts` pin the Python and TypeScript geometry constants to the `constants` blocks in `contracts/`; `scripts/export_limit_contracts.py --check` (frontend job, `make generated-check`) pins the generated TypeScript.

### Timebase guards and the tool clock registry

Two meta-tests keep the source/timeline split (see [architecture.md § Timebase](architecture.md#timebase-source-vs-timeline-clock)) from regressing:

- **`test_timebase_guards.py`** scans `src/podcast_mcp` and fails if the clip mapping formula (`source_start + (t - timeline_start)`, etc.) appears outside `engines/session_timeline.py` or the `Clip.timeline_end` property. New code doing ad-hoc clip math fails CI with a pointer to `SessionTimeline`.
- **`test_raw_echo_cache.py`** exercises CLI and MCP audibility/reconcile paths without rendered stems. Its fixture shifts clips on the timeline and removes source spans, proving raw samples are placed through the mapper before the measured echo path can classify bleed. Literal PCM tests cover overlapping extra recordings, moved clips, repeated-file decode reuse, a missing primary with available extras, and abstention for missing, invalid, dangling, escaped, or short selected media.
- **`test_time_conformance.py`** introspects every registered MCP tool; any tool with a seconds-like parameter that is missing from `TOOL_TIMEBASE` in `util/tool_timebase.py` fails. It also runs a conformance suite on a shared compressed-timeline fixture (30s removed mid-track) asserting the mapper, exports, and QC touch the correct audio region. **Adding a new time-bearing tool = one registry entry.**

`test_pause_trim_geometry.py` and `test_source_remove_geometry.py` drive actual `EditService` approval, workspace mutation, saved reload and Suggested snapshot approval. They verify replay and source-hole holds, final optimizer closure, stored track-pause refusal, finite implicit primary media, unknown extent and intentional empty lanes, actual pad-adjusted loss, and late selected-batch rollback. Automatic tests verify a fresh scope hold restarts survivors without duplicate archives and excludes speech chosen only by a freshly held cut. Generated coalescing preserves independent retained manual rows. Continuous splits, origin media parked elsewhere, exact occurrences and source MUTE remain distinct positive controls. These literal geometry fixtures establish playback and transcript preservation; they do not establish pad audibility or owner listening.

`test_source_review_corrections.py`, `test_source_operation_coverage.py`, and `test_source_recovery_trials.py` cover original request rejection before optimization, complete survivor identity and review barriers, excluded-row ownership, Focus hold summaries, actual operation lanes, cascading held trials and full saved recovery. Source-positive fixtures create a real finite WAV and declare its measured duration locally; `minimal_project` stays media-less for refusal controls. Golden-ear tests call `_equalize_clip_lengths` directly with unequal matching-format WAVs in both argument orders and assert exact output frames, preserved PCM prefixes and zero tails. Real legal-pause rendering and invalid-pause refusal remain separate integration controls.

### Fixture hygiene

Tests must never write into the committed fixture tree. Mutating pytest e2e tests use the `e2e_workspace` / `*_workspace` fixtures, which copy the fixture into `tmp_path` **and rewrite the copy's `meta.workspace_dir` to point at that tmp directory** (`copy_relocated_workspace` / `rewrite_workspace_dir` in `project/io.py`, used by `tests/e2e/conftest.py`). Playwright copies `aligned_dialogue` to `tmpdir`, exports that path as `DAW_E2E_PROJECT`; the `npm run test:e2e` wrapper deletes registered copies after Playwright terminates its web server. Share and record callbacks switch to their disposable project through the existing loopback-only project-open endpoint and restore the suite project before cleanup; UX screenshot runs remain pinned to their selected project. `switchE2eProject` / `withShareableProject` (via `assertDisposableE2eProject` in `gui/web/e2e/env.ts`) refuse to target the committed `aligned_dialogue/episode.project.json` (compared after `realpath`, so symlinked aliases and case variants on case-insensitive volumes are rejected too; a path that does not exist yet is compared after `path.resolve`, and any other `realpath` error is rethrown so the guard fails closed), and throw when `DAW_E2E_PROJECT` is unset and `e2eProjectPath` falls back to it. The guard covers only that file: other committed fixtures, such as `sharecut_ux_demo` (which UX screenshot runs pin the GUI to), are not checked. Specs must switch the GUI's project only through these helpers; a direct `POST /api/project/open` bypasses the guard. Each ordinary Playwright run allocates a loopback port and exports it as `DAW_E2E_PORT` before starting the GUI, workers, and teardown; set `DAW_E2E_PORT` explicitly for a fixed origin such as UX screenshots.

The Playwright copy (`createRelocatedE2eProject` in `gui/web/e2e/liveProject.ts`) mirrors the fixture's `.gitignore`: it keeps nothing under `artifacts/`, and it skips top-level `history/`, `export/`, and `_build/`, any `.git`, and session-sync sqlite files (`sync.db`, `-wal`, `-shm`). Nested directories such as `transcripts/review/` are kept. This differs from Python's `copy_relocated_workspace` (`WORKSPACE_COPY_IGNORE` in `project/io.py`), which skips all of `artifacts/`. `gui/web/e2e/liveProject.test.ts` checks the rule against a seeded source tree and against the fixture `.gitignore`. `scripts/verify_remote_mcp_shares.py` without `--project` also publishes into a relocated temp copy, never into the fixture. To remove gitignored cruft an older run left in the committed fixture (for example `artifacts/review/` mixes), run `git clean -fX tests/fixtures/aligned_dialogue`.

Vitest tests that copy the committed large fixture use the shared `E2E_FIXTURE_COPY_TEST_TIMEOUT_MS` (20 seconds) timeout; tests that only exercise registration failure keep the default timeout. Unit tests for shareable-project lifecycle behavior inject a minimal fixture source so they verify isolation and cleanup without copying the committed audio payload; the default factory used by Playwright still copies the complete fixture.

Committed fixtures store `workspace_dir` as `"."` (no machine-specific absolute paths). `load_project` always remaps `workspace_dir` to the directory containing `episode.project.json`. The e2e copy rewrite still matters for any code that reads the JSON without going through `load_project`, and so subsequent saves do not revive a stale path. `tests/e2e/test_fixture_hygiene.py` and `tests/test_no_machine_paths.py` guard this.

Read-only tests can still use `e2e_project_file` directly, since they only load and inspect the fixture.

## E2E fixture tests

Moved to [testing-e2e.md](testing-e2e.md): beta user stories, GUI surface regressions, committed fixtures, local lab verification and the browser profiles.

## CI

Moved to [testing-ci.md](testing-ci.md): the jobs each run needs and the browser acceptance matrix.

## Ripple follower render regression

`tests/test_trim_follower_render.py` checks a same-recording follower that moves
before a muted anchor after a ripple trim. The cheap public-renderer test checks
the independently placed actors and later gap. The FFmpeg test trims through
`EditService`, reloads the saved project, then checks exact WAV frame count and
distinct PCM markers for the follower, muted anchor interval, gap and later clip.
Duration and samples are asserted together, so truncating misplaced output
cannot satisfy the test. The saved crossfade case checks 1,056,000 frames,
17,500 PCM at 10.95 seconds and 15,000 at 11.5 and 12.5 seconds.

`tests/test_crossfade_components.py` checks literal native TRI and qsin samples,
independent actor contribution, the connected short-middle chain, and the first
retained source-piece overlap cap. It also saves and reloads authored windows
with source cuts and local fades. `tests/test_bleed_review.py` retains the
half-sample window count and mute-origin checks. Envelope tests reject stems
from render revisions 10, 13, and 14 under revision 15.
`tests/test_render_precision.py` checks saved ordinary CUT boundaries and
fractional requested-window extents against literal frames and PCM.
`useNudgeRun.handoff.test.tsx` uses the real trim save with deferred boundary
loading to check clean geometry, foreign comments, drafts, stale submission,
synthetic roll refusal, and token-specific settlement.

## Render regression fingerprints

Optional sandbox-only hashes of **rendered** outputs (stems, premix, bounces) — not raw fixture WAVs and not the runtime audio-cache fingerprint (`audio_state_fingerprint()`). Compare against `aligned_dialogue` (or another gold fixture) so a pipeline/render change that alters audible output fails CI. Still unimplemented.

## Body limit middleware

GUI `MaxBodySizeMiddleware` ([`util/body_limits.py`](../src/podcast_mcp/util/body_limits.py)) is **pure ASGI**: it checks `Content-Length` when present, otherwise cap-buffers chunked bodies and replays them via a wrapped `receive`. Media upload paths (`/media/upload`, `/daw/media/upload`) and record keeper `…/upload` routes are skipped (route-owned caps; record parts 5 MB). Relay proxied record `…/upload` uses `max(PODCAST_RELAY_MAX_BODY_BYTES, PODCAST_RECORD_UPLOAD_MAX_PART_BYTES)` so a 5 MB part is not 413'd by the 4 MiB default.

Unit coverage: `tests/test_security_hardening.py` (413 oversized CL / no-CL, under-limit replay, CL pass-through, media-upload skip, record-upload skip).

### Local browser smoke

**Host GUI**

1. `PODCAST_GUI_MAX_BODY_BYTES=1024 podcast gui --project <fixture>`
2. In ShareCut Studio, perform a small mutating action (e.g. timeline comment) — must succeed.
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

Live host matrix (requires a GUI already running): `scripts/verify_remote_mcp_shares.py` — see [host-online-relay.md](host-online-relay.md) § Manual verification.

Rate limits (host + relay): `tests/test_rate_limit.py`; `tests/test_limiter_table.py` pins every limiter env name, default and bucket and that both composites are built from their `TABLE`.

## Lowering the threshold

Only change `fail_under` in `pyproject.toml` with team agreement. Prefer adding tests over lowering the bar.
## Measured results

The word-boundary benchmark and the #715 shipped pass results are in [test-results.md](test-results.md).

## Service context boundaries

`tests/test_service_boundaries.py` scans production imports for the
`services/app/`, `services/pipeline/`, and `services/support/` contexts. Callers
use their declared facades. The check rejects external imports of context
internals and service imports from `gui.routes`; app GUI launch may use the
neutral `gui.bind` and `gui.static_assets` modules. Synthetic nested and
relative imports verify the guard. Focused pipeline tests live in
`test_pipeline_config.py`, `test_pipeline_run_result.py`, and
`test_bootstrap_gui.py`; support tests live in `test_diagnostics.py`,
`test_distribution_config.py`, and `test_setup_cli.py`.
`test_import_order.py` checks app and session-sync cold imports, lazy export
identity, and CLI commands in fresh processes with the optional HTTP client
unavailable.

### Adapter governance

The same file guards the adapter seam. `cli/`, `mcp/` and `gui/` may import
`edits/`, `engines/` and `pipeline/` only through the pairs in
`_ADAPTER_DOMAIN_ALLOWLIST` (37 entries; `if TYPE_CHECKING:` imports are
typed-only and exempt), adapters may not import each other beyond the two
deletion entries and the launcher wiring, and `util/` may not import an
adapter. Inline imports count. A new edge fails the test; the fix is a service
or a typed contract. A phase that deletes an edge must remove its entry and
lower `_ADAPTER_DOMAIN_ALLOWLIST_SIZE`, because the test asserts the allowlist
matches the tree exactly. Synthetic sources (inline, relative, `TYPE_CHECKING`)
verify the guard fails on a new edge.

## Frontend architecture governance

Four Vitest suites under `gui/web/src/` pin the frontend's layering and
write-path rules. Each holds an allowlist sized at today's violations,
asserts the allowlist's exact size, fails on a stale entry, and carries
sabotage tests that feed a synthetic new violation through the same checker.
A phase that removes a violation deletes the entry and edits the asserted
size; nothing is added.

- `test/importDirection.test.ts` declares the layer order `types -> utils ->
  state -> document -> api -> services -> commands/edit -> hooks -> views`
  and a table placing every top-level `src/` entry in a layer. A
  lower layer importing a higher one (static, `import type` or dynamic
  `import(...)`) fails unless it is one of the 74 allowlisted back edges,
  listed per layer pair. A new directory fails until the table places it.
  Tests, stories and the `test/` and `storybook/` fixtures may import
  across layers, but layers below views may not import them. The import reader is
  `test/importGraph.ts`.
- `state/setProjectGovernance.test.ts` allows `setProject(` calls only in
  `document/` and `state/projectSlice.ts`. Two calls in two other files are
  allowlisted by file and call count.
- `state/readmeRuleGovernance.test.ts` checks the three rules in
  `gui/web/README.md`. Files outside `api/` import the `api.ts` facade, not
  an `api/*` adapter (26 allowlisted file and adapter pairs in 24 files).
  A file that keeps its own `[error, setError] = useState` beside an API call
  should use `useProjectMutation` instead (10 allowlisted files). `state/dawStore.ts`
  is the only DAW store (two other `create` sites allowlisted).
- `state/storeGovernance.test.ts` keeps its selector and hot-field checks.

Run them with
`cd gui/web && npx vitest run src/test/importDirection.test.ts src/state/setProjectGovernance.test.ts src/state/readmeRuleGovernance.test.ts`.

## Interaction-system governance

Five Vitest suites pin the rules in [interaction-system.md](interaction-system.md#enforcement-tests) (#1795): `commands/manifestSurfaces.test.ts`, `keymap/sharedKeys.test.ts`, the src scan in `timeline/gestureGovernance.test.ts`, `commands/controlSetters.test.ts` and `ui/dialogSheet.test.ts`. That section states each one's protection and recurring cost.

## Selected-range tests

Owner: [daw-editing.md § Exact selected ranges](daw-editing.md#exact-selected-ranges). This section keeps only the selected-range tests facet.

`tests/test_selected_range.py` proves repeated-source occurrence scope, moved clips, overlap, disjoint islands, unchanged peers, stale geometry and media, guest and agent proposal authority, atomic Undo, and intentionally empty lane rendering. Run it with retained Python and supported disposable share identity and registry overrides.

Exact selected-range checks moved to [testing-e2e.md](testing-e2e.md#exact-selected-range-checks).

## Bounded Restore and source ownership

`test_pause_hardlink_identity_contract.py` checks unchanged saved and in-memory
state for explicit, primary-media, and unclipped hardlink replays. It keeps a
sole-placement positive and excludes actual pad receipts from original quiet.
`test_media_physical_identity.py` checks missing-media geometry, filesystem errors,
transcript provenance, and acoustic exclusion across aliases.
`test_pause_primary_transcript_contract.py` retains each primary alias lane's own
words, including explicit-source transcripts stored before primary words. It
compares literal kept-word PCM before and after a later pause approval.
`test_pause_parked_transcript_contract.py` covers explicit and unique-primary parked
transcripts, unrelated transcript ordering, and atomic refusal of ambiguous owners.
`test_pause_primary_authority_contract.py` checks selected-primary transcript order,
the literal original-air floor between real words, and implicit peer clock safety.
`test_pause_peer_floor_clock_contract.py` checks shifted peer solo floors and actual
current-turn positive controls across saved approval, automatic application and Suggested.
`test_pause_ignored_peer_floor_contract.py` and `test_pause_muted_peer_floor_contract.py`
check literal solo and turn floors after editorial changes, including parked and
implicit sources, physical transcript fallback, partial fades, abutting clips and replay.
`test_editorial_word_sample_contract.py` compares real rendered 48 kHz samples with
current word placement despite stale 16 kHz metadata. It covers inclusive mute
endpoints, short fades, shared rounded boundaries, ignored-token fade overlap and
unchanged raw room calibration frames.
`test_pause_unreadable_mask_contract.py` requires a typed, atomic hold for unreadable
masked media through saved approval, automatic application and Suggested.
`test_pause_prior_join_contract.py` keeps existing incoming join modes and compares
literal PCM around an earlier crossfade before and after a later approved pause.
These signals prove rendered behavior, not owner listening acceptance.

`test_bounded_restore_contract.py` drives saved service, document HTTP, and real owner MCP refusal with the literal `local_restore_requires_history` code and four-sentence guidance. It checks unchanged editable state, project bytes, pending rows, archives, history index, and snapshot IDs. Guarded History Undo recovers parked recording identity, transcript archives, and all peer clip occurrences. Source MUTE Restore remains a positive control through every delivery boundary.

`test_manual_pending_ownership_contract.py` proves transitive manual joining ownership, atomic stale-member refusal, identity and review barriers, and excluded metadata/order preservation. `test_pause_original_placement_contract.py` uses the actual planner to distinguish original lane membership from final pause effect. `test_source_review_final_findings.py` retains disjoint-stale, original MUSIC, RESTORED confirmation, and UNKNOWN primary-error regressions. `test_bounded_restore_owner_details.py` also prevents transient before-history writes for Restore and all-held automatic application, blocks joining across an intervening review barrier, and checks real positive automatic REMOVE/MUTE actions with held rows, render bookkeeping, and guarded whole-action Undo. Applied edit inspector Vitest tests cover MUTE-only Restore, whole-action guidance, access bounds, and navigation without hidden Undo.

### Compact feedback lifetime and discovery

The compact history reach check asserts Undo, Redo, resize and Close before
any scripted recovery, then repeats those assertions after body scrolling.
Its pre-edit peek, half, and full traversal also taps unavailable Redo and checks
its reason, accessible description, caption visibility, exact panel, header, body,
and button rectangles, and absence of document commands. The blocked caption
must disappear before the first saved edit. All four orientation and root-size
cells retain the saved-history journey in both engines.
Saved Time and Level edits compare literal whole arrays through exact
`UndoHistory` and `RedoHistory` commands. Clipping receipts include every
ancestor while the card is active. Ordinary wheel discovery exposes the whole
card where it fits, or each feedback action where a long card cannot fit.
Native Tab checks every intermediate compact field with its complete label.
After Undo restores the saved envelope, the dependent Level nudge first checks
that the compact Time output displays the restored point time; saved state and
the client's displayed point are separate preconditions.
The short-form refusal uses explicitly labeled HTTP `history_stale` fault
injection after a real fade edit, whose successful save is silent.

The clipped saved feedback check measures a fully visible card, scrolls it
outside its actual body clip, and waits nine seconds without card hover or
focus. It then exposes Dismiss and verifies expiry within the remaining visible
time. Unit tests cover portal continuity, focus, remaining time and guarded
Undo through host movement. Run `npm run test:e2e:compat --
compact-history-persistence.spec.ts compact-save-refusal.spec.ts compact-feedback-lifetime.spec.ts compact-feedback-focus.spec.ts touch-chrome-reach.spec.ts compact-form-scroll.spec.ts` from `gui/web` after
building the production app. These browser receipts do not establish physical
device behavior or Linux CI results.

`compact-feedback-focus.spec.ts` preserves each native Undo and Dismiss button
through the phone-to-tablet shell switch, which remounts the sheet and
Inspector. This focused
compatibility regression needs Chromium and WebKit because their native focus
fixup and portal movement differ. It uses one viewport transition per action,
without duplicating the existing theme, text-size, or detent matrices. Component
tests cover the smaller focus-request and current valid return-target contracts,
including modal priority, refused or disabled actions, and host teardown.
A second page in the same browser context stands in for the peer; its selection
and mute are what a real second host tab sends, which the REST command route
does not reproduce because it publishes no selection.

The feedback detent matrix compares half and full height before and during a
real history refusal for Envelope and Pending selections. It covers phone and
short-tablet viewports and both text sizes, one theme per cell. Ruler ownership must remain
when the baseline detent permits it. Short-slot minimum chrome can make ruler
room impossible at enlarged text. The painted-focus matrix visits every native
compact Tab target, measures outline width and offset against canonical clip
bounds, and captures each indicator. It measures the visible grabber for the
hidden detent range. The floating lifetime case removes a genuinely long named
track through the production confirmation, then closes a compact selection while
that same guarded card remains clipped. Browser RED receipts precede repairs.

Compact discovery retains its primary header proof at the selected detent. If canonical geometry shows that the target cannot fit that body's clip, the existing reveal helper admits the actual compact Expand control before requiring full card and action containment. Receipts distinguish the selected detent from the recovered presentation. Ruler proof uses canonical positive visible area and a real unforced `x300,y12` click because the ruler intentionally spans horizontal scroll content; its whole border box need not fit the viewport. Native horizontal wheel readiness waits for the intended local `x300,y12` coordinate to enter the canonical visible bounds before evaluating ruler permission. The original Pending ruler click assertions remain unchanged.

The phone navigation focus matrix traverses every Primary navigation button
with native Tab at 16px and 32px root sizes, one theme per size. It runs
in Chromium and WebKit and saves geometry receipts and screenshots for each
focused button. The phone shell clips content at its viewport edge, so every
navigation focus indicator must fit inside its button.

## Complete cut effects

`tests/test_source_remove_geometry.py` exercises the four cut-domain authorities
through actual application. It changes real PCM or current placement after an
offer, checks atomic refusal, then disables only the owning predicate and requires
the bad effect to publish. Cases include late batch fades, GAP extension without
a removal, live MCP plan application, moved pad tiles, and duplicate source
consumption. The AST boundary test rejects direct, aliased, module-qualified, and
private writer imports outside the operation owner. Renderer tests prove pending
or applied decision labels cannot bypass publication by removing audio at render
time. These checks supplement the public pause and original mixed-mode PCM
contracts; they do not replace Lab parity or listening acceptance.

## Occurrence automatic-reduction coverage

`clipBleed.test.ts` validates host inspection DTOs and exact opaque targets. `clipBleedSession.test.ts` exercises opening generations,
materialization, recording replacement, stale reads, peer-head round trips and exact Undo receipts. Command and host-inspector tests cover queue
admission, access and current-target checks. Timeline and selection-surface tests cover mounting, placement cancellation, current-region geometry and
phone selection. Central input-contract, hit-candidate and real-router grammar tests guard direct activation, touch scroll, long press and
second-finger rollback without governance allowlists. `gui/web/e2e/bleed-band-touch.spec.ts` drives CDP touch on the built timeline at 390x844 and 844x390: a held press at a
band's selector beside a join lists the Roll and the band, a held press at a band edge beside a click-through trim handle selects the band alone, and
the selector sits farther from a comment pin than `TOUCH_HIT_RADIUS_PX`. The handle and write checks have controls; the pin gap does not.

`test_proxy_variants.py` covers whole-generation retention, actual encoded chunk
identity, partial or damaged destinations, derived saves, concurrent render
publication and namespace synchronization failures. `test_atomic_directory.py`
checks real no-replace promotion and occupied destination preservation.
`test_review_versions.py` retains its publication and quarantine race coverage
through that extracted helper. The episode shape lock is regenerated and replayed
with `scripts/project_compat.py lock --base <trusted-main-ref>`.

Synthetic PCM, browser and schema checks establish their measured behavior only.
They do not replace owner listening, supported native interaction, independent
Shipping, exact-head CI or the full action-transcript audit. Registry-backed
guest/recovery acceptance requires the application's real trusted directory
ownership checks to pass; tests must not bypass those checks to manufacture a pass.
