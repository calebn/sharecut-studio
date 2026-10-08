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

Hang protection: `pytest-timeout` (`--timeout=60` in `pyproject.toml` addopts) and job `timeout-minutes` on the GitHub Actions workflow. Nested guest+tunnel WebSocket tests use a live uvicorn server — Starlette `TestClient` nested sockets can deadlock.

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

## Python quality tooling

Local mirrors of the CI `pytest` job’s static checks (config in `pyproject.toml`):

```bash
make lint-py          # ruff check + bandit -ll + vulture + deptry
make format-py        # ruff format (write)
make format-py-check  # ruff format --check
make capabilities-check
make progress-check   # progress framework compliance (warn by default)
make decisions-index-check  # decision blocks in docs/ are valid and docs/decisions/README.md is current
make hooks            # lint-staged formats staged Ruff/Biome; check-only pre-commit hooks (incl. service-boundaries)
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
`src/podcast_mcp/whisper_models.py` / `word_aligner_models.py` that pin a model file by sha256
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

The `pytest` job's final step, on pull requests only, runs `scripts/docs_sync.py check --range` over the PR's base/head SHAs — the docs-sync gate from [AGENTS.md § Docs in sync](../AGENTS.md#docs-in-sync). It needs the job's `actions/checkout` at `fetch-depth: 0` (the merge base and commit trailers, not just the head commit). Run the same check locally with `make docs-sync` before opening a PR; the `docs-sync` pre-commit hook runs it on staged files but only warns.

The `pytest` job also runs `actions/setup-node`, so tests that run workflow JavaScript under `node` (for example the docs-lens predicate test in `tests/test_issue_pipeline_workflow.py`) always run in CI. Locally they skip when `node` is not on `PATH`. With `CI` set they fail instead of skipping.

The path-filtered `.github/workflows/release-wheel.yml` builds the web assets, then the sdist and wheel, installs the wheel into a clean venv, and runs `scripts/check_wheel_web_build.py --podcast`. It fails unless the wheel ships `index.html` plus every file it references and the installed `podcast gui` serves that `index.html` at `/`. `tests/test_wheel_web_build.py` covers the build hook in the ordinary `pytest` job without npm ([setup.md § Web build in wheels](setup.md#web-build-in-wheels)).

The `extras-import` workflow (on `pyproject.toml` changes, `workflow_dispatch`, and a weekly schedule) installs every optional extra into a fresh venv without `uv.lock` and imports its modules (`tests/test_extras_import.py`, marker `extras_install`, enabled by `PODCAST_CHECK_EXTRAS=1`). The locked suite cannot see an upstream release that breaks `pip install "podcast-mcp[extra]"`; the weekly run does. The main `pytest` job skips it because the env var is unset ([setup.md § Pip extras](setup.md#pip-extras)).

### CI dependency downloads

The `pytest` and browser matrix jobs use `.github/actions/setup-ffmpeg` to install
Ubuntu's FFmpeg without recommended packages. Every job refreshes signed APT
metadata, resolves a fresh SHA256 archive manifest, and installs FFmpeg even on a
cache hit. `scripts/ci_ffmpeg_cache.py` removes unexpected files, symlinks, and
archives with the wrong size or SHA256 before installation. Missing archives use
APT's normal download path. Setup fails if APT, `ffmpeg`, or `ffprobe` fails.

The cache holds only `.deb` downloads. The fresh manifest stays outside the cached
directory. The exact key includes the Ubuntu release, architecture, runner image,
action and helper content, and each archive's URI, filename, size, and SHA256.
There is no fallback key. Cache restore and save failures are advisory.
Only `pytest` publishes a complete verified archive set, before tests, on pull
requests and pushes to `main`. Sets larger than 150 MiB are not saved. The job
summary reports the exact hit, verified restored count, planned count and bytes,
and setup time.

Python jobs cache pip downloads with `actions/setup-python`. Both `pyproject.toml`
and `uv.lock` invalidate that cache. The editable pip install commands still run
and keep their existing resolver behavior. Pip does not use `uv.lock` as a lockfile.
Browser engines, browser system dependencies, virtual environments, and installed
Node packages are not cached by this change. Playwright still installs Chromium
and WebKit with `--with-deps` for both existing suites.

Run the archive boundary and workflow checks with
`.venv/bin/python -m pytest -q --no-cov tests/test_ci_dependency_cache.py tests/test_browser_acceptance_matrix.py`.
A cold and warm run on fresh hosted runners must use the same archive key. The
warm install must report `Need to get 0 B`, and all existing required checks must
pass before accepting a performance improvement.

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
The selected native macOS Homebrew pair is the full media acceptance lane.
Cross-platform behavioral resolver tests mock OS selection and executable
lookup policy while keeping the test host's real path semantics. Focused
resolver and readiness tests also run on real Windows in the desktop workflow;
that job does not claim Windows media acceptance. Ubuntu uses authenticated
distro packages in full CI. The Windows media lane pins 9.0.2 for a narrower
suite. The release and security policy is in
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
Sharecut Studio fixtures. This statement does not invent a license for the
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
WAV's last-use age through the `services/document/play.py` `_cache_last_used` seam
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
- S3-compatible object storage (`PODCAST_OBJECT_STORE_*` and `~/.config/podcast_mcp/relay.yaml`) → disabled so review-share `/audio` serves local `mix.mp3` instead of redirecting to object storage
- `PODCAST_SHARE_REGISTRY` → per-test `tmp_path/share_registry.sqlite` (`_isolate_share_registry`, singleton reset before/after). Do not re-`setenv` it in tests unless the test needs a specific path (verbatim-override / two-registry cases)
- `PODCAST_RELAY_CONFIG` → `tmp_path/relay.yaml` and `PODCAST_RELAY_HOST_ID` unset (`_isolate_relay_config`), so the persisted relay `host_id` never lands in the developer's home
- Process-wide `lru_cache` answers that a patch can poison (Silero availability, the asset manifest path, mocked media probes) are cleared before and after every test (`_isolate_process_caches`). Without it, a test that patches `vad_silero.is_available` to `False` left `get_shared_vad()` returning `None` for the rest of its xdist worker (#1123). `tests/process_caches.py` lists every cache under `src/` as `ISOLATED` (cleared) or `SHARED` (keyed by every input it reads, so a stale entry is harmless and clearing would only cost recompute); `tests/test_process_caches.py` fails when a new cache is in neither list. Classify a new cache in the same change

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
skip markers so `test_review_versions.py` and `test_project_commit_lock.py` skip the same
staging/quarantine/publication tests together on a platform without safe, descriptor-relative
directory operations (Windows); an autouse fixture defined once there (`unmarked_tests_run_as_unsupported_platform`, imported by name into both modules)
forces both flags off for any test without one of those markers, so a test that stages media without
`requires_safe_failed_cleanup` fails on POSIX too, not only on the Windows job (the fixture patches only the pytest process, so a spawned child that stages media still needs the marker);
`test_review_publication_support_matches_the_ci_platform` guards
that those flags are `True` on POSIX and `False` on Windows, so CI cannot silently start skipping
them everywhere.

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

Both browser suites currently run serially against shared live project state.
Do not raise `workers` or enable `fullyParallel` until each worker owns its GUI
server, project, share registry and output directory. Retries are failure
recovery, not a runtime optimization.

CI runs the main suite as four shards (`main-1of4` ... `main-4of4`, each
`npm run test:e2e -- --shard=i/4`) and the compatibility suite concurrently in
separate `frontend-e2e-suites` matrix jobs. Each runner owns its checkout,
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

The existing required `frontend-e2e` check waits for every matrix job and fails
for any failed, cancelled or skipped one. `fail-fast: false` lets all of them
finish and report failures. Local wrappers still run sequentially within one
checkout.

CI uploads one `playwright-reports-<name>` artifact per matrix job
(`playwright-reports-main-1of4` ... `playwright-reports-main-4of4` and
`playwright-reports-compat`) on successful and failed runs. Each holds
`<name>.json` with per-test durations, retries and errors. The matrix sets
`PLAYWRIGHT_JSON_OUTPUT_FILE` for each job. Download them all with
`gh run download <run-id> --pattern 'playwright-reports-*'` and sum durations
per spec file across the shard reports. Compare successful runs at the same
test scope, and separate browser execution from dependency install and
server/build setup. A local timing run can use
`PLAYWRIGHT_JSON_OUTPUT_FILE=/tmp/main.json npm run test:e2e -- --reporter=json`,
and `npm run test:e2e -- --shard=2/4` reproduces one CI shard.
Failed-spec traces remain separate `playwright-test-results-<name>` artifacts.

## What to test where

| Area | Test file |
|------|-----------|
| Models / project I/O | `test_models.py` |
| Filler / tighten edits | `test_edits.py`, `test_tighten.py` |
| Golden-ear A/B harness | `test_golden_ear_harness.py` (`scripts/golden_ear_harness.py`, `make golden-ear ARGS=…`; rollups require valid preference and leftover-consonant responses) |
| FFmpeg engine | `test_ffmpeg_engine.py` (requires `ffmpeg` on PATH) |
| Media service facade and context boundaries | `test_media_facade.py`, `test_service_boundaries.py`; focused behavior in `test_bounce.py`, `test_services_ingest.py`, `test_media_store.py`, `test_proxy_media.py`, `test_review_media_object_store.py`, `test_services.py`, and `test_waveform_service.py` |
| Audition context / audio reasoning eval | `test_audition_context.py`, `test_audition_context_eval.py` (defect injection; `scripts/eval_audition_context.py`) |
| Transcript merge | `test_transcribe.py` |
| Pipeline steps / runner | `test_pipeline.py`, `test_pipeline_steps.py`, `test_runner.py` |
| CLI | `test_cli.py` |
| MCP tool handlers | `test_mcp_tools.py` |
| Config / defaults | `test_config.py`; `test_pipeline_config.py` asserts every `ParamField.default` equals `.agents/defaults/pipeline.yaml`, and that the align module constants match it |
| History / undo-redo | `test_history.py` |
| Source↔timeline mapping | `test_session_timeline.py`, `test_timebase_regression.py` |
| Timebase architecture guards / conformance | `test_timebase_guards.py`, `test_time_conformance.py` |
| Agent ↔ DAW session sync | `test_session_sync.py`, `test_gui_api.py` (session endpoints) |
| Document-command contract (schema + boundary rejects) | `test_document_command_payloads.py`, `test_document_command_boundary.py` (HTTP/WS/MCP 422/-32602 + OpenAPI↔schema) |
| Share HTTP / MCP / WS parity | `test_share_http_mcp_parity.py` (`scripts/export_docs_site_contract.py`; WS discovery + curated notes for `/api/rec/` and `/api/review/`) |
| Document handlers / caps | `test_document_delta.py`, `test_document_sync.py`, `test_review_share.py`, `test_remote_mcp.py`, `test_structural_policy.py` |
| Review roles (Viewer / Commenter / Editor) | `test_share_roles.py` (role → capabilities, CLI and MCP mint by role only, guest MCP allowlist per role), `test_guest_document_gate.py::test_each_role_runs_exactly_its_document_commands` (role × document command matrix) |
| Document submit crash consistency (every store handoff, lock contention) | `test_document_submit_crash_recovery.py`, `test_project_commit_lock.py` (spawned children are reaped with `tests/process_helpers.py` `reap`, which kills a child that hangs) |
| GUI / timeline inspector APIs | `test_gui_api.py`, `test_waveform_zoom.py` |
| Zoom-matched waveforms | `test_timeline_zoom.py`, `test_waveform_pyramid.py`, `test_waveform_service.py`, `test_waveform_routes.py`, `test_waveform_snap.py` (incl. guest snap ACL), `gui/web/src/waveform/*.test.ts` (tile geometry, envelope reduction vs brute force, shared CPU/GL shading, stores, worker), `gui/web/src/timeline/WaveformLayer.test.tsx`, Playwright `e2e/waveform.spec.ts` (host tiles, WebGL2 + raster parity on Chromium, guest tiles through the share route with no PCM) and the compat matrix (`webgl2` or `cpu-worker`; `deep-zoom.spec.ts` geometry at the 15 M px ceiling on Chromium and WebKit) |
| Brand / public CSS | `test_brand_color_roles.py`, `test_public_sites.py`, `test_css_policy.py`, `test_css_no_important.py` |
| Body / host security hardening | `test_security_hardening.py` (pure ASGI `MaxBodySizeMiddleware`, authz, served_project) |
| Tighten propose/apply benchmark | `benchmark_tighten.py` (`pytest -m slow tests/benchmark_tighten.py`; per-cut time budgets), `test_benchmark_tighten_smoke.py` (the same scenarios on a 40-word project in the normal suite) |
| Large-project benchmark fixture | `test_large_project_fixture.py` (`scripts/build_large_project_fixture.py`; two-hour shape under `e2e_real`), Playwright `e2e/large-project.spec.ts` (opt-in) |
| Recording keeper landing | `test_record_landing.py` probes a real reader snapshot while each keeper hash is paused and checks that both project locks are free. |
| PCM WAV header | `test_wav_util.py` (`util/wav.py`, shared by record landing and the benchmark fixture) |

Low-rate MP3 padding coverage lives in `test_waveform_pyramid.py`. FFmpeg 6
reports a 1.152 s duration for the one-second 8 kHz fixture, while FFmpeg 9
reports 1.0 s after gapless trimming. The test checks each native duration and
a declared 1.152 s duration, then compares the pyramid's frames and bins with
a separate full decode.

Audio integration tests skip automatically when FFmpeg is unavailable.

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
2. Run `make schema-export` (updates `schemas/document-commands.schema.json`, `docs-site/schemas/…`, `docs-site/pages/document-commands.md`, share/MCP generated tables, and guest OpenAPI).
3. Keep human docs pointing at that file / the live catalog ([session-sync.md](session-sync.md) § Document plane, [docs.sharecut.studio/#/document-commands](https://docs.sharecut.studio/#/document-commands)) — do not re-list every field in engineer markdown.
4. CI/pre-commit (`make schema-check`) fails if the checked-in schema or docs-site outputs drift.
5. `test_document_command_boundary.py` fails if OpenAPI or MCP `inputSchema` drift, or if any submit path stops rejecting bad payloads at the boundary.

TypeScript codegen uses the web project's Biome configuration; a formatter failure
must fail export/check rather than writing an unformatted artifact. Install the
`gui/web` dependencies before running the local schema gate.

`test_document_delta.py` checks actual command deltas, fresh-state retry heads, same-inode/restored-mtime reloads, artifact and history certificates, cache bounds, saved-command repair, concurrent writers, guest privacy, and 10,000-clip/long-transcript byte budgets. Compact actual service projections in `tests/fixtures/document_delta/` also run through the TypeScript parser/applier. Frontend `document/authority.test.ts`, `projectionDelta.test.ts`, and `pendingDrafts.test.ts` cover predecessor recovery, HTTP-before-WS races, scope generations, copy-on-write behavior, hostile expansion, and bounded optimistic display.

Handler behavior stays in `test_document_sync.py` (constructs internal `DocumentCommand` dicts after validation).

### Timebase guards and the tool clock registry

Two meta-tests keep the source/timeline split (see [architecture.md § Timebase](architecture.md#timebase-source-vs-timeline-clock)) from regressing:

- **`test_timebase_guards.py`** scans `src/podcast_mcp` and fails if the clip mapping formula (`source_start + (t - timeline_start)`, etc.) appears outside `engines/session_timeline.py` or the `Clip.timeline_end` property. New code doing ad-hoc clip math fails CI with a pointer to `SessionTimeline`.
- **`test_raw_echo_cache.py`** exercises CLI and MCP audibility/reconcile paths without rendered stems. Its fixture shifts clips on the timeline and removes source spans, proving raw samples are placed through the mapper before the measured echo path can classify bleed. Literal PCM tests cover overlapping extra recordings, moved clips, repeated-file decode reuse, a missing primary with available extras, and abstention for missing, invalid, dangling, escaped, or short selected media.
- **`test_time_conformance.py`** introspects every registered MCP tool; any tool with a seconds-like parameter that is missing from `TOOL_TIMEBASE` in `util/tool_timebase.py` fails. It also runs a conformance suite on a shared compressed-timeline fixture (30s removed mid-track) asserting the mapper, exports, and QC touch the correct audio region. **Adding a new time-bearing tool = one registry entry.**

### Fixture hygiene

Tests must never write into the committed fixture tree. Mutating pytest e2e tests use the `e2e_workspace` / `*_workspace` fixtures, which copy the fixture into `tmp_path` **and rewrite the copy's `meta.workspace_dir` to point at that tmp directory** (`copy_relocated_workspace` / `rewrite_workspace_dir` in `project_io.py`, used by `tests/e2e/conftest.py`). Playwright copies `aligned_dialogue` to `tmpdir`, exports that path as `DAW_E2E_PROJECT`; the `npm run test:e2e` wrapper deletes registered copies after Playwright terminates its web server. Share and record callbacks switch to their disposable project through the existing loopback-only project-open endpoint and restore the suite project before cleanup; UX screenshot runs remain pinned to their selected project. `switchE2eProject` / `withShareableProject` (via `assertDisposableE2eProject` in `gui/web/e2e/env.ts`) refuse to target the committed `aligned_dialogue/episode.project.json` (compared after `realpath`, so symlinked aliases and case variants on case-insensitive volumes are rejected too; a path that does not exist yet is compared after `path.resolve`, and any other `realpath` error is rethrown so the guard fails closed), and throw when `DAW_E2E_PROJECT` is unset and `e2eProjectPath` falls back to it. The guard covers only that file: other committed fixtures, such as `sharecut_ux_demo` (which UX screenshot runs pin the GUI to), are not checked. Specs must switch the GUI's project only through these helpers; a direct `POST /api/project/open` bypasses the guard. Each ordinary Playwright run allocates a loopback port and exports it as `DAW_E2E_PORT` before starting the GUI, workers, and teardown; set `DAW_E2E_PORT` explicitly for a fixed origin such as UX screenshots.

The Playwright copy (`createRelocatedE2eProject` in `gui/web/e2e/liveProject.ts`) mirrors the fixture's `.gitignore`: it keeps nothing under `artifacts/`, and it skips top-level `history/`, `export/`, and `_build/`, any `.git`, and session-sync sqlite files (`sync.db`, `-wal`, `-shm`). Nested directories such as `transcripts/review/` are kept. This differs from Python's `copy_relocated_workspace` (`WORKSPACE_COPY_IGNORE` in `project_io.py`), which skips all of `artifacts/`. `gui/web/e2e/liveProject.test.ts` checks the rule against a seeded source tree and against the fixture `.gitignore`. `scripts/verify_remote_mcp_shares.py` without `--project` also publishes into a relocated temp copy, never into the fixture. To remove gitignored cruft an older run left in the committed fixture (for example `artifacts/review/` mixes), run `git clean -fX tests/fixtures/aligned_dialogue`.

Vitest tests that copy the committed large fixture use the shared `E2E_FIXTURE_COPY_TEST_TIMEOUT_MS` (20 seconds) timeout; tests that only exercise registration failure keep the default timeout. Unit tests for shareable-project lifecycle behavior inject a minimal fixture source so they verify isolation and cleanup without copying the committed audio payload; the default factory used by Playwright still copies the complete fixture.

Committed fixtures store `workspace_dir` as `"."` (no machine-specific absolute paths). `load_project` always remaps `workspace_dir` to the directory containing `episode.project.json`. The e2e copy rewrite still matters for any code that reads the JSON without going through `load_project`, and so subsequent saves do not revive a stale path. `tests/e2e/test_fixture_hygiene.py` and `tests/test_no_machine_paths.py` guard this.

Read-only tests can still use `e2e_project_file` directly, since they only load and inspect the fixture.

## E2E fixture tests

`tests/test_ingest_recorder_import_e2e.py` automates US-3: synthetic recorder folder (guest recorder starts 4 s early) → `ingest import` → `episode init` → `ingest consolidate` with default flags → asserts clip placement via the project and `/api/project`, then an `ingest verify` smoke.

### Beta user stories (US-1 … US-9)

The beta user stories come from `ux/pages/brief.md`, `ux/pages/screen-inventory.md`, `ux/pages/guest-journeys.md`, and `ROADMAP.md`. Each story's issue holds its Given/When/Then, steps, and run log; bugs found while working a story get their own issues. "Still manual" lists every step that has no automated check yet, including hardware-only steps (Tauri recording) and listening by ear.

"Automated" means every step except Tauri recording and listening by ear has an automated check. "Partial" means some other step still needs a manual run, and that step is named under "Still manual". Cite each coverage file by its full repo-relative path. Update a story's row in the same change that automates one of its steps. `tests/test_beta_story_matrix.py` guards this table: every cited path must exist, an "Automated" row may list only Tauri recording or listening by ear under "Still manual", and a "Partial" row must list at least one other step.

| Story | Issue | Status | Automated coverage | Still manual |
| --- | --- | --- | --- | --- |
| US-1 | #3 | Automated | `gui/web/e2e/record-lobby.spec.ts`, `gui/web/e2e/record-host-reconnect.spec.ts` | Tauri recording (#193) |
| US-2 | #9 | Automated | `tests/test_record_host_reconnect.py`, `gui/web/src/record/RecordPanel.test.tsx`, `gui/web/src/record/Room.test.tsx`, `gui/web/e2e/record-host-reconnect.spec.ts` | Tauri recording (#193), listening by ear |
| US-3 | #10 | Automated | `tests/test_ingest_recorder_import_e2e.py` | Tauri recording (#193) |
| US-4 | #4 | Automated | `gui/web/e2e/transcript-inline-edit.spec.ts`, `gui/web/e2e/transcript-ignore.spec.ts`, `gui/web/e2e/transcript-refine-recovery.spec.ts`, `gui/web/e2e/sharecut.mobile.spec.ts`, `gui/web/src/panels/TranscriptPanel.test.tsx`, `gui/web/src/transcript/TranscriptTurnView.test.tsx`, `gui/web/src/layout/StatusBar.test.tsx`, `tests/test_transcript_correct.py`, `tests/test_transcript_reconcile.py` | Listening by ear |
| US-5 | #5 | Automated | `gui/web/e2e/sharecut.smoke.spec.ts`, `gui/web/src/panels/TightenPanel.test.tsx`, `gui/web/src/inspector/views/PendingEditInspector.test.tsx`, `gui/web/src/panels/ImpactPanel.test.tsx`, `tests/test_tighten.py`, `tests/test_mute_in_place.py` | Listening by ear |
| US-6 | #6 | Partial | `gui/web/e2e/fade-curves.spec.ts`, `gui/web/e2e/applied-edit-seams.spec.ts`, `gui/web/e2e/transcript-inline-edit.spec.ts`, `gui/web/src/panels/HistoryPanel.test.tsx`, `tests/test_history.py`, `tests/test_pending_preview.py` | Listening by ear, a mid-run Cancel |
| US-7 | #7 | Partial | `gui/web/e2e/review-surface.spec.ts`, `tests/test_review_share.py`, `tests/test_relay_proxy.py` | Host visibility of time-anchored playback feedback and host-offline fallback |
| US-8 | #11 | Partial | `gui/web/src/shareMode.test.ts`, `tests/test_share_pending_preview.py` | Two-browser suggest/approve |
| US-9 | #8 | Partial | `gui/web/src/panels/PipelinePanel.test.tsx`, `gui/web/e2e/pipeline-warning-layout.spec.ts`, `tests/test_pipeline_run_result.py`, `tests/test_gui_export_jobs.py`, `tests/test_bounce.py` | A mid-run Cancel |

The record-lobby touch-target check holds guest room-sync frames to verify the
connecting view has no controls, then waits for **Allow microphone** before
measuring control heights. This makes the assertion deterministic across room
sync timing.

### GUI surface regressions

`gui/web/e2e/gui-surfaces.spec.ts` checks five editor panels and chapter inspectors
at desktop, tablet and phone widths in both themes with WCAG A/AA contrast
checks. It also covers long comments and vocabulary announcements, phone
Pipeline parameters/model-download focus handoff, and repeated menu-trigger
clicks. `gui/web/e2e/review-surface.spec.ts` checks that a Commenter link opens
Sharecut Studio in both themes: at 1440px the guest posts a
comment and a reply, and at 320px Comments sit one action away under More. Both
widths check overflow and axe. `gui/web/src/App.review.test.tsx` pins that a share
without `view` shows an error instead of a listen page.
`gui/web/e2e/comment-undo.spec.ts` checks host Resolve and Undo persistence,
sticky toast bounds and hit testing after two interior panel scrolls, and Dismiss
focus without changing panel, ancestor, or window scroll offsets. It runs at
desktop and phone widths in both themes, with axe while the toast is visible.
`gui/web/e2e-compat/comment-undo.spec.ts` runs one phone recovery flow in Chromium
and WebKit, including a real pending reopen request and disabled Undo focus.
These tests use disposable projects. Physical iPhone and iPad Safari checks remain
pending. Run the focused cases with `npm run test:e2e -- e2e/comment-undo.spec.ts`
and `npm run test:e2e:compat -- e2e-compat/comment-undo.spec.ts` after the E2E build.
`gui/web/e2e/envelope-recovery.spec.ts` covers envelope recovery at desktop,
tablet, and phone widths in both themes with reduced motion. The first gesture
starts with the inspector closed and a different control focused. Native mouse
input acquires circle focus and capture. The flow checks local preview highlight,
Escape retaining point focus without opening the inspector, focus-departure
cancellation, zero commands and unchanged saved points/history after cancellation,
then one completed edit and one Undo restoring the exact origin. A no-op click
opens the inspector without saving. A later native drag on an exposed second
point preserves the first point's inspector selection after Escape. Its center
must hit the circle; points covered by the incumbent tablet sheet are not tested
as native drag targets. Native movement allows one CSS pixel of engine coordinate
rounding; cancellation and Undo restore exact geometry and saved points.
Foreign pointer ID 99 move/up events are explicitly synthetic. They exercise real
app handlers while the native mouse owner remains held. This does not prove
native second-touch routing. `gui/web/e2e-compat/envelope-recovery.spec.ts` shares
that flow in Chromium and WebKit at desktop width. Physical touch, stylus, Safari,
and assistive technology remain unverified. Focused component tests cover all
foreign terminal events, non-left mouse admission, capture cleanup, setup failure,
pending saves, rejected saves preserving previous selection, read-only selection,
and unmount. Run browser wrappers sequentially with fixture/environment unit tests.
`gui/web/e2e/inspector-responsive.spec.ts` covers the #961 inspector regression
at 360×740, 360×800, 667×360, 820×1180 and 1440×900, in light/dark themes,
with reduced motion and 16px/32px CSS root text. It uses native mouse input at
the visible track identity, measured ordinary body-wheel scrolling, and full
control rectangles rather than center-only visibility. Envelope saves retain
matching Applied identity, saved stable-ID points and History receipts; Cancel,
Escape, Done and Close check visible focus recovery without a canceled write.
The Clip inspector shares the same scrolling checks. A separate phone journey
uses native Tabs and Enter for field errors and completion. The 32px root is a
200% text-size simulation, not browser/OS zoom, physical touch, Safari, assistive
technology or software-keyboard evidence; those acceptance checks remain #960.
Run the focused regression after the production E2E build:
`npm run test:e2e -- e2e/inspector-responsive.spec.ts`.
See [the baseline and result record](https://github.com/calebn/sharecut-studio/pull/963#issuecomment-5998148488) for qualified failures,
selected pixels, and a separate genuine Chromium 200% browser-zoom check. That
check uses `chrome.tabs.setZoom` with a 16px root and measured halved CSS layout
on an Xvfb display. It is distinct from this suite's root32 simulation.
Touch and pending-inspector layout regressions now measure the actual
`.bottom-sheet` scroll owner and use `wheelInspector`/`exposeControl` to reach
complete controls by native wheel input. The inner `.modifier-body` no longer
owns scrolling; desktop modifier inspectors use their outer aside. This updates
layout expectations while retaining command, focus, permission, and persistence
assertions. The responsive suite does not replace the owner recovery/CAS tests.
`gui/web/e2e/desktop-splash.spec.ts` renders native startup HTML with long errors
at narrow and wide sizes. These browser checks do not validate packaged WebViews
or physical microphone behavior.

Run browser wrappers sequentially with fixture/environment unit tests. Their
workspace-marker lifecycle must not overlap. See the
[GUI surface audit](gui-surface-audit.md) for the complete source/render/live
coverage map and platform limits.

### Committed fixtures (Tier A)

- `tests/fixtures/aligned_dialogue/` — smoke / edits (human LibriSpeech audio and corpus text; published MFA-derived word boundaries shifted with complete utterances; no model downloads to regenerate)
- `tests/fixtures/synthetic_bleed_60s/` — bleed/reconcile/precorrect gold
- `tests/fixtures/asr_gold/` — LibriSpeech WER regression
- `tests/fixtures/lab_bleed/`, `tests/fixtures/lab_tighten/` — short real lab microphone windows (reviewed bleed mutes; ASR-seeded fillers, backchannels and pauses with owner verdicts and openable projects)

Regenerate `aligned_dialogue` offline with
`uv run python scripts/build_aligned_dialogue_audio.py`, then regenerate its
linked UX demo with `uv run python scripts/build_ux_demo_fixture.py`.
The builder pins source audio and label hashes, preserves whole utterances,
and records output hashes in `provenance.json`. Fixture guards independently
reconstruct PCM and shifted labels. Text is a corpus reference; word boundaries
are machine-derived, not human-verified. See the
[fixture provenance and layout](../tests/fixtures/aligned_dialogue/README.md).
The final two-occurrence layout measured 0% reference-track WER and 8.33%
guest-track WER with CPU/int8 Whisper `base`. The live CLI regression pins
`--model base` and retains the corpus-ASR suite's 12% ceiling for both tracks.
Repeated utterances within one decode window caused omissions during fixture
selection, so each occurrence sits in a separate 30-second window. The golden-ear
smoke test seeds a pending pause cut over independently verified silence in a
temporary copy and requires two audible, different blinded exports. It no longer
skips when this audiobook fixture yields no safe automatic tighten candidates.

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

### Local lab verification (private tape)

For audio, pipeline and DAW behaviour that the Tier A fixtures are too small to show, verify locally against the maintainer's private practice tape: `calebn/sharecut-podcast-lab`, checked out at `~/projects/ShareCut_Podcast_Test`. It holds 28 minutes of 3-speaker Zoom stems locked at offset 0, a 2-minute excerpt, a seeded Whisper transcript, and a human "gold" edit. Its README covers the details.

- **Local only.** The lab is private, so it is never a CI dependency. Don't copy its media into this repo; write Tier A tests for the behaviour you fix.
- **Runs are disposable,** built from its frozen `source/` by `scripts/make-run.sh`. Issues that name the lab include the exact repro commands.
- **Parallel agents share one checkout.** Isolate your *runs*, not the lab. From the root of your worktree:

  ```bash
  export LAB=~/projects/ShareCut_Podcast_Test
  export LAB_RUNS_DIR=$PWD/.lab-runs                  # gitignored here; removed with the worktree
  $LAB/scripts/make-run.sh repro --prep               # bare + stems/reconcile/precorrect, gates waived
  cp -ac $LAB/runs/baseline $LAB_RUNS_DIR/scratch      # or clone the shared bare baseline (APFS, instant)
  ```

  - **Your branch's CLI:** the script uses `$PODCAST`, else `./.venv/bin/podcast` from the directory you run it in, and prints the branch and commit it's testing.
  - **Read-only shared data:** `$LAB/runs/baseline` and `$LAB/source/` are never edited. Clone the baseline instead.
  - **GUI port:** start the GUI on the free port the script prints (`podcast gui … --port N --no-open`), not 8765.
  - **Transcription:** use `--source excerpt` (~2 min) for ASR checks. Full-length live ASR, and any full `pipeline run`, goes through `$LAB/scripts/with-asr-lock.sh`, so parallel lanes don't transcribe 3 × 28 min at once.
  - **Alignment / word boundaries:** see [Lab tape: alignment testing grounds](#lab-tape-alignment-testing-grounds).

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
sparse WAVs are silent either way. `--history N` (default 200, the max) seeds N
before/after pairs (2N entries, 400 by default) that toggle the first clip's
fade-in and share two full-size snapshot files (`history/snapshots/benchmark-base.json`
and `benchmark-faded.json`), so undo, redo, and diff use real snapshots without
400 copies on disk; `--history 0` leaves the history empty. `ProjectStore`
(`HISTORY_ENTRY_LIMIT`) prunes a project's history to 400 entries on every
commit, so the default and the max both track that cap — `--history` values
above `HISTORY_ENTRY_LIMIT // 2` (200) are refused rather than silently
trimmed, since a fixture built past the cap could never survive a real
commit. Seeded entry ids are 12-character lowercase hex (`f"{n:012x}"`, the
shape `HistoryManager` mints via `uuid4().hex[:12]`), so a real commit prunes
the oldest entries without a `Skipping unsafe pruned history snapshot id`
warning. Pruning deletes `history/snapshots/<entry id>.json`, which the seeded
entries never have, so the two shared snapshot files stay on disk. The default
200 steps also meet the History list's `VIRTUALIZE_ON_ROWS` (200), so a
default-shape run profiles the virtualized list; `tests/test_large_project_fixture.py`
pins that.

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

The benchmark retains a versioned `EditorProfileReport` and `chrome-trace.json`
under `DAW_PROFILE_OUT`, or the test's `editor-profile` output directory. This is
Part of #879. The small profiling preset is 120 seconds, two tracks, 24 clips,
200 utterances, and 20 history steps. Generate a fresh workspace for every run:

```bash
uv run python scripts/build_large_project_fixture.py \
	--out /tmp/editor-small-1 --duration 120 --tracks 2 \
	--clips 24 --utterances 200 --history 20
DAW_E2E_PROJECT=/tmp/editor-small-1/episode.project.json \
	DAW_BENCHMARK_PROJECT=1 DAW_PROFILE_OUT=/tmp/editor-small-1-report \
	npm --prefix gui/web run test:e2e -- large-project.spec.ts --retries=0 --trace=off
```

Build once per revision before these runs. Repeat with three fresh paths per
preset. Large uses the builder's existing defaults. Do not use `--repeat-each`
with one mutating project. Retain failed repetitions rather than retrying them.

Each action records driver wall time separately from page-local rAF scheduling
intervals, long tasks, and individual CDP duration deltas. Initial-load rAF data
starts in the new document and does not cover the full navigation wall interval.
Raw intervals include their count, median, nearest-rank p95, and maximum. They do
not measure physical displayed frames or field input latency. Missing or reset
CDP fields are unavailable, never zero. Task, script, layout, and style durations
overlap and must not be summed. GC and memory checkpoints follow frame windows.
The legacy endurance wall duration includes its per-round GC; per-round timing
and frames exclude GC.

Primary actions run without Chrome tracing. A separate diagnostic keyboard seek
retains a Chrome trace after the main actions. Its traced sample has a distinct
phase and must not be pooled with primary timings. Import `chrome-trace.json`
into Chrome DevTools Performance to inspect its events. Playwright tracing follows
the runner's configured mode and is recorded separately. Use `--trace=off` for
primary repetitions; a separate body-traced diagnostic run is not comparable to
those repetitions. The report persists partial measurements before rethrowing a failed action. The test remains failing.

The report records actual served asset hashes and hook markers, source revision
and dirty state, host and browser metadata, page settings, fixture counts, and
canonical and raw fixture hashes. Its canonical hash ignores only generated
creation timestamps and workspace paths. It also includes actual prebuilt `.wfpk`
content hashes keyed by stable track reference, excluding generated media-key
filenames. Missing waveform identity refuses comparison; silent and synthetic
pyramids are different workloads. The pure `compatibilityReasons` function
rejects mismatched definitions, fixture, machine, browser, viewport, motion,
cache/GC policy, instrumentation, and unknown build or page provenance. Revision
and asset hashes may differ for a before/after comparison. The original `editor-response-v1` profile has no speedup claim. The supplemental
workload runner and local comparison procedure below use a separate measurement
version.

The supplemental `editor-workloads-v2` suite isolates clip dragging, boundary
rolling, Original playback, cache-cold waveform generation, real pipeline
progress, and deterministic progress replay (ordinary and reduced motion):

```sh
npm --prefix gui/web run build
npm --prefix gui/web run profile:remaining -- --preset small --repeat 5 --out /tmp/editor-small-baseline
npm --prefix gui/web run profile:remaining -- --preset large --repeat 5 --out /tmp/editor-large-baseline
npm --prefix gui/web run profile:remaining -- --preset small --out /tmp/editor-small-holdout
npm --prefix gui/web run profile:compare -- --baseline /tmp/editor-small-baseline --holdout /tmp/editor-small-holdout --out /tmp/editor-small-budget.json
npm --prefix gui/web run profile:remaining -- --preset small --out /tmp/editor-small-candidate
npm --prefix gui/web run profile:compare -- --budget /tmp/editor-small-budget.json --candidate /tmp/editor-small-candidate --out /tmp/editor-small-comparison.json
```

Use an independently generated holdout for each preset. Run on a quiet worker
with no other browser, fixture decode, build, or full suite. The runner reuses the
existing Playwright process/port cleanup and starts a fresh server/context for
each scene. `--scene clip|boundary|playback|cold-waveform|progress-replay|progress-real|progress-reduced`
selects one scene for validity debugging; a selected scene does not establish
whole-issue coverage. `--trace --scene progress-replay` or
`--trace --scene cold-waveform` retains a separate Chrome diagnostic trace.
Both use diagnostic sample phases excluded from primary timing budgets.
The original `large-project.spec.ts` remains the wheel/zoom/ruler-seek and
extended editor/memory protocol. In Comment mode, ruler dragging anchors a
comment range. In the ordinary mode, the ruler uses click/keyboard seeking; these measurements do not claim
continuous held-pointer scrubbing.

Both presets keep their full 120 s or 7200 s source clock and original counts.
`--tone-seconds 20` adds deterministic nonzero PCM only at the start of each
source; the remaining full-length payload is sparse silence. This establishes
actual graph sampling during bounded playback without generating dense two-hour
tone files. The report hashes full actual media bytes and validates WAV duration.
Prebuilt pyramids remain synthetic UI resources. The cold scene removes only
its owned pyramids before opening the project, then uses real status/tile
requests, generated artifacts, and painted production canvases. At fit-session
zoom, two-hour clips can use the narrow fallback rather than a canvas. The cold
protocol uses ordinary ruler Home and zoom keys to expose an 80 px first clip;
clip dragging separately prepares a 120 px body and verifies its actual hit
target. Reports retain fit/prepared geometry, actual scale, and zoom-key counts.
These are full-source decode plus detailed canvas paint measurements, not
fit-zoom initial canvas paint. OS file caches are uncontrolled; this is pyramid-cache cold, not disk cold.

Drag windows separate held preview from release/durable save. Captured commands,
affected clip geometry, and an exact Undo outside the measured window establish
that real edits occurred. Playback uses the real Original control, nonzero
per-track graph meter samples, successful media responses, advancing transport,
and a held Pause. It does not establish heard fidelity or device latency. Memory
checkpoints force GC outside input windows and retain raw heap and DOM counts.
The positive part of final-minus-initial growth is a diagnostic, not proof of a
leak; the raw checkpoints also preserve decreases.

Progress replay substitutes only its named EventSource transport and status
response; the production pipeline hook and UI consume the snapshots. It is
labeled replay, not backend throughput. Visible bar height, changing widths and
percentages, delivered cadence, and settled terminal geometry are retained.
Real-job progress uses the ordinary Run control from `compress_tracks`, with
`balance_tracks` and their required ingest/clean prerequisites enabled. The job
executes Compress and Balance only. The default `progress-real` measurement now
uses the passive `native-progress-passive-v2` observer; the superseded three-state
implementation has been removed. Its previous reports, invalid/unstable results
and frozen budgets remain historical evidence, without recalibration. Default
`pipeline-progress.spec.ts` regressions still check short-panel geometry and both
motion modes without injecting CSS.

Run the current default observer on one fresh small fixture with the ordinary
remaining-workload command. Reduced motion is an explicit observation setting:

```sh
npm --prefix gui/web run profile:remaining -- --preset small --scene progress-real --out /tmp/native-progress-normal
DAW_PROFILE_NATIVE_MOTION=reduce npm --prefix gui/web run profile:remaining -- --preset small --scene progress-real --out /tmp/native-progress-reduced
```

The current protocol records the actual POST snapshot, passive CDP native EventSource
message receipt, passively available browser status responses, raw DOM mutation
batches, indeterminate presence, bar generations, and event-triggered first/last
sampled geometry with viewport, ancestor clipping and CSS visibility exclusions.
Nonrectangular masks/clips and capped ancestor inspection are explicit unknowns;
style and layout reads are counted. Caps bound retained records and parsing,
not the transient already-materialized CDP strings or browser response bodies;
up to 32 response-body reads can be pending. Missing native receipt, meaningful DOM, or
geometry channels remains incomplete even when backend processing succeeds. Network receipt is not application acceptance;
DOM mutations are not React render commits or compositor paints. Clock domains
remain separate, and network/page cutoff timestamps prohibit absence joins
outside a demonstrated common observation window. Bounded or unavailable channels make causal conclusions
inconclusive. It prepositions the existing shortcut region, focuses the actual
Run control without scrolling, and activates it through keyboard Enter; no
post-start scroll or fabricated zero/dwell changes the natural job. Successful
processing and retained observation are separate from a three-visible-state
pass. Project/config hashes and resulting project/artifact references are
captured outside the action because Compress/Balance legitimately changes state.

`DAW_PROFILE_NATIVE_OBSERVER=control-v2` uses the same preparation, native action,
terminal polling, and enabled Network domain without the added collector. Its
observations are a control, not native-progress causal evidence. Use this only in
a predeclared AB/BA overhead experiment; raw paired wall/CDP values do not prove
negligible overhead or an acceptable latency. Observer settings are recorded in
`protocol.nativeObserver`, so earlier reports and current reports are incompatible for
frozen-budget application. The historical diagnostic allocation was one normal
and one reduced small attempt, retained without replacements. Tests, source/build
pins and the campaign manifest were frozen for the two retained natural runs.
Their observed clipping and unmeasured overhead are summarized below; previous
three-state budgets remain historical and reject current-protocol reports.

The default command was also checked once on a fresh small fixture without
observer or motion environment flags. It selected passive/normal observation,
completed genuine Compress and Balance, and retained native receipt, DOM and
layout evidence. All sampled geometry remained clipped. This checks default
wiring without establishing visible progress, producer cadence or collector
overhead; it does not replace the historical allocations or frozen budgets.

Each report has a distinct execution ID and start time. Missing required
coverage, failed validity, or metadata/retention errors preserves the partial
report and fails the supplemental run. Failed fixtures and per-scene Playwright
evidence remain inspectable; successful fixtures are disposable. Output paths
must be new. Reports record dirty source for validity, but budget comparisons
require clean source and a served production build without E2E hooks.

The report declares frame-percentile applicability before measurements. Initial
load, cold decode/detail paint, held clip/boundary preview, playback, real/replayed
progress, scrub endurance, and multi-key history navigation require at least two
uncapped rAF intervals for a percentile budget. Atomic zoom, seek, save, and other
short command windows retain all raw intervals but use no percentile budget.
This policy follows workload definitions, never observed timing. Missing required
frame data fails budget creation; it is not padded or removed after results.
Driver wall time remains available separately. Supported long-task and CDP task
metrics retain their explicit availability, which must match between runs.

The comparison command requires at least five compatible baseline repetitions
and an independent holdout. It freezes each local diagnostic upper limit as the
baseline maximum plus the largest adjacent absolute difference, then checks the
holdout. An exceeding holdout is retained as an unstable baseline; the limits
are not padded or rerun until a favorable result. Unstable baselines cannot
become regression gates. Copied execution IDs or repeated real report paths
refuse independence. A separate `--budget FILE --candidate DIR` invocation
applies the stored limits without recalibrating them. It verifies original
report SHA-256 digests, execution IDs, chronological baseline order, metric keys
and raw values, and the original maximum/variation/limit arithmetic and holdout
truth. Candidates never enter that derivation check. Machine/browser/viewport,
fixture/media/resources, protocol, cache, motion and instrumentation must match;
source/assets may differ only for candidates. Raw reports, source/build IDs,
numeric limits and holdout outcomes remain in the budget artifact. These limits
are a worker-specific reproducibility envelope, not a universal FPS target or
user-experience SLA. No production optimization or speedup follows merely from
running this command.

In the original `editor-response-v1` suite, timeline and transcript scrolling
uses programmatic offsets. Keyboard seek and existing panel/history controls retain their functional assertions.
A measured one-key zoom precedes a trusted horizontal wheel event over a timeline
with more than 100 CSS pixels of scroll range; changed visible clip IDs establish
scrolling. An ordinary ruler click changes the observed playhead. Focus and
programmatic scroll resets occur outside these measurement windows. The playhead
returns to zero before measuring transcript opening, so playhead follow exposes
the first turn on both fixture sizes.
That original suite gives clip and boundary drags, playback, cold waveform
generation, and native touch explicit not-run reasons. Its synthetic progress
replay was not run: an attempt attached the real consumer, but the rendered bar
had zero computed height before and after ordinary panel resizing. Its failed reports and geometry
were retained; no progress width-transition cost was measured in that original
slice. Supplemental v2 uses the separate drivers above, with native touch still
unavailable. The 0.5rem fix prevents flex-height collapse; it does not guarantee that a bar
is inside an ancestor's visible clip or establish a speedup; the
original suite adds no production telemetry or timing CI gate. Silent
media, ready pyramids, uncontrolled OS/server caches, and desktop Chromium do not
establish audio quality, cold decoding, physical-device behavior, or Safari parity.

`make test` builds a two-minute fixture; the full two-hour shape is checked by
`test_large_project_fixture_default_two_hour_shape` under the `e2e_real`
marker (`make e2e-real`).

### Retained responsiveness findings (#879)

The retained desktop Chromium measurements establish workload coverage, not a
latency SLA. Small fixtures use 120 seconds/24 clips/200 utterances; large uses
7200 seconds/1200 clips/10000 utterances. Reports retain their machine, browser,
source, served assets, viewport and resource identities. Driver wall time is not
input latency, rAF intervals are not displayed FPS, and overlapping CDP counters
must not be summed.

Eight original supplemental workload budgets validated against their independent
holdouts. Both original `editor-response-v1` budgets remained unstable. Applying
those unchanged budgets to the later control revision produced six within-envelope
results, two diagnostic exceedances and two unusable v1 comparisons. Small clip
save wall time was 327.230953 ms against 313.364891 ms; small boundary preview rAF
p95 was 16.8 ms against 16.7 ms. These remain literal observations, without
rounding away failures, recalibration or favorable replacement runs. The limits
are local reproducibility diagnostics, not acceptable-UX targets.

Large full-source cold loading took 69.8–79.8 seconds across the original five
runs, 77.4 seconds in holdout and 77.729 seconds in the later control. Its frozen
rAF p95 limit was 1433.1 ms. This is a material responsiveness finding despite
being within a broad local envelope. The window includes canonical preparation,
real full-source pyramid generation and detailed canvas readiness; it is not a
pure decoder benchmark or fit-zoom first paint.

Bounded repeated-use checks also retain positive heap growth. In the first small
baseline, scrub rounds 1→20 (ten keys each) changed post-GC heap from
10,244,464 to 11,210,432 bytes (+965,968), with 752 DOM nodes at both endpoints.
The first large baseline changed 68,653,164→74,851,876 bytes (+6,198,712), with
8760→8755 nodes. These are specific within-endurance examples, distinct from
whole-run final-minus-initial growth metrics and first load. They establish
neither a leak nor a memory plateau, and do not cover native/audio/GPU memory.
Playback in Original mode separately retained media responses, advancing clocks,
nonzero graph meters and Pause; it does not establish heard quality or device
latency.

The pipeline flex-bar correction changed the reproduced zero-height bar to its
8 px default height; responsive consumer regressions cover normal/reduced
motion. Four replay cohorts (small/large × normal/reduced) validated, with thirty
scheduled/delivered snapshots and nominal 50 ms scheduling. Replay is synthetic
transport through the real consumer, not backend cadence. The earlier small real-job report completed processing but observed only 50/100 percent, so its three-state
measurement remains invalid. The large real-job holdout exceeded its CDP task
limit (9676.412 > 9639.009 ms), so that budget remains unstable.

The separate passive native observer later captured genuine Compress/Balance
in one normal and one reduced small run, eighteen native receipts each, with
0/50/100 DOM states. Both retained complete-in-window observations, but every
sampled bar was below its panel clip (top 724.594 px; clipping bottom 684 px).
These samples prove neither visible progress nor its absence in every layout.
POST, native SSE receipt, consumer status, driver status, mutation and sampled
layout remain distinct channels; receipt is not consumption, mutation is not a
React commit, and layout is not compositor presentation. Producer sent count/
cadence and collector overhead remain unmeasured. No forced dwell, fabricated
zero or additional three-visible-state campaign is needed to relabel the old
results. Width-transition optimization is unsupported by the retained profile.

A separate renderer prototype was **rejected from the final change** because
native correctness validation was incomplete. Its one marked warm A→B diagnostic
pair measured 3374.567→2621.260 ms complete wall and
1537.936→1116.014 ms style/layout union. The union covers
Layout/UpdateLayoutTree/RecalculateStyles, not all main-thread work. One A-first
pair with uncontrolled OS caches/order is not a statistical speedup; one
post-workload heap checkpoint per arm cannot establish growth.

The v4 desktop A/B sequence passed with matching retained control/geometry
checkpoints, clip mutation/Undo, and terminal screenshots. In v5, baseline A-phone
passed the initial, far-focus and selected-offscreen checkpoints, then failed the
held fade-preview focus assertion. Its evidence contains one submitted
SetClipFade request and no accepted-response receipt. Separately retained saved
first-clip and history records show a persisted 1 ms fade: history cursor 400,
401 entries, with current operation `set_clip_fade`. Candidate B-phone did not
run, so no candidate focus
regression or successful phone comparison is established. The cause remains
unproven. The matched canonical D0 cold comparison was source-prepared but not
run. There is no production renderer gain, completed cold comparison, or pending
optimization promise to infer from this rejected experiment. Historical cold
measurements and frozen budgets remain unchanged.

These opt-in diagnostics measure defined editor workloads and retain provenance,
raw observations and adverse findings. The commands above reproduce those
workloads and apply frozen local budgets without recalibration. Slow, unstable,
clipped or unavailable observations remain part of the record; they do not become
acceptable UX merely because a run completes or fits a local envelope.

## CI

GitHub Actions workflow `.github/workflows/test.yml` runs Python, frontend and
two browser-suite jobs (plus the advisory `pytest-python-floor`) in parallel on push and pull requests to `main`. **All must pass** (including Playwright axe) for a green build:

| Job | What |
|-----|------|
| `pytest` | `ruff check` + `ruff format --check` + `bandit` + `vulture` + `deptry` + `mypy` + `pytest -n auto -m "not e2e_slow and not e2e_real"` (Python coverage gate) |
| `pytest-python-floor` | Advisory (not an issue-pipeline required check): Python 3.11, the `requires-python` floor, runs `tests/test_wav_util.py` and `tests/test_bleed_gate_channels.py`, which pin the EXTENSIBLE-WAV reads that 3.11's stdlib `wave` rejects (#1183). The full `pytest` job stays on 3.12; a local 3.11 venv reproduces the gap. |
| `frontend` | In `gui/web`: `npm ci`, `npm audit --omit=dev --audit-level=high` (advisory, `continue-on-error`, failures noted in the job summary; see [§ Dependency updates and audit](#dependency-updates-and-audit)), `npm run lint` (oxlint + Stylelint tokens/rem/`@container`; `!important`/`@layer` consent-gated), `npm run format:check` (Biome), `npm run typecheck` (strict `tsc`), `npm test` (Vitest + `axe-core` via `expectNoA11yViolations`; all `.stories.ts` and `.stories.tsx` modules are discovered, rendered with Storybook preview annotations, played, and axe-checked including body portals by `gui/web/src/test/allStories.test.tsx`; keeper PCM/WAV/segment bars in `gui/web/src/record/keeper/`; mix-minus MM1–MM9 in `gui/web/src/audio/mixMinus.test.ts`; stories/Storybook/test helpers never imported by app code or root build configs in `gui/web/src/test/storyGovernance.test.ts`), `npm run build` (Vite module-ID guard rejects story/Storybook inputs in every app build) |
| `frontend-e2e-suites` → `frontend-e2e` | Separate main-shard and compat matrix runners build Sharecut Studio, install Chromium + WebKit (`--with-deps`), Playwright smoke against a **temp copy** of `aligned_dialogue` (no committed waveform data: pyramids build on demand from the fixture WAVs; the copy keeps nothing under `artifacts/` and skips `history/`, `export/`, `_build/`, `.git`, and sync sqlite — see [§ Fixture hygiene](#fixture-hygiene)). Ordinary loopback Playwright launches leave `podcast gui` unpinned and explicitly provide each temporary `?project=` path, allowing share and record scenarios to use a fresh relocated fixture. `npm run test:e2e` (CI passes `-- --shard=i/4`) deletes the live copy after Playwright terminates its web server (sqlite stays in the temp workspace — never rewritten in place). Host→guest follow seeds a temp premix and needs `ffmpeg` on PATH to publish the share mix. Presence follow also covers tab follow, chrome ghosts, lane-bottom no-jump, guest Pipeline/FX degrade, and the 360px phone guest follow banner's text truncation and Stop following fit (`e2e/presence-follow.spec.ts`). Full-page axe via `expectPageAxeClean` in `gui/web/e2e/axe.ts`. The compatibility runner executes the Chromium/WebKit compatibility matrix (`npm run test:e2e:compat`; see [§ Browser compatibility matrix](#browser-compatibility-matrix)). When a step fails, the job uploads `gui/web/test-results/` (Playwright traces for failed specs; a WebKit trace records a WebSocket's handshake but not its frames, so read record-room state from DOM snapshots and the host snapshot the failure message prints) as the `playwright-test-results-<name>` artifact (`main-1of4` ... `main-4of4` or `compat`), kept for 7 days. Successful and failed runs also upload per-test JSON timing reports. The required `frontend-e2e` aggregate rejects any failed, cancelled or skipped matrix result (the four main shards and compat). Firefox pending-inspector layout remains [Follow-up](../ROADMAP.md#follow-up) (original #155 report was Firefox @ 1280). `e2e/root-pin.spec.ts` checks that `/` with a pinned project redirects to it and never POSTs `/api/project/close`; specs that need Home load `/?home=1`. |

The Playwright job and `make test-web-e2e` build with `VITE_SHARECUT_E2E=1` so
recording test hooks are available. Ordinary `npm run build` omits them; its
bundle guard fails if E2E page flags or signal counters remain in emitted assets.

`expectPageAxeClean(page, selector)` can also check a focused surface; the open transport-menu test scopes its axe check to the menu while unrelated track-header and loading-timeline ARIA names are tracked in #114. Do not disable additional axe rules to hide failures.

### Storybook browser geometry

`npm run test:e2e:storybook` in `gui/web` builds the static Storybook catalog,
serves it on port 6010, and runs Chromium against the production edit-boundary
stories. Testing the build avoids dev-server compilation and reloads while
Docs iframe previews initialize.
The restored-word fixtures make ghost preview geometry observable without a
live episode or backend. Real mouse trajectories check stable text and row
layout, handle displacement, preview bounds, and Escape cleanup at 1440px
and 360px in light and dark themes. `.github/workflows/storybook.yml` installs
Chromium and runs this suite against the catalog build. This supplements
the jsdom story interaction and axe checks.

`e2e-storybook/story-layout.spec.ts` checks floating panels in both standalone
Canvas and Docs at desktop and phone widths in both themes. Menus must fit
their inline host. Fixed popovers and body-portaled dialogs must fit their
own Docs iframe. Shell examples must keep document attributes inside their
frame. These checks preserve intentional scrolling inside production panes.
`e2e-storybook/docs-theme.spec.ts` changes the manager theme toolbar while
Docs frames are mounted, including an OS preference opposite to the explicit
toolbar choice. The Docs page and its stories must follow the chosen theme.

Storybook specs open story frames through `storyUrl()` in
`gui/web/e2e-storybook/storyUrl.ts`, which adds the `a11y.manual:!true` global.
The Storybook a11y addon otherwise runs its own axe instance in every story
frame and replaces `window.axe` when it loads, so a spec's own scan
(`expectPageAxeClean`, `AxeBuilder`) that overlaps it fails with "Axe is already
running" (#1120). The helper handles it, so a spec does not set the global
itself. `e2e/storybookStoryUrl.test.ts` fails a spec that hardcodes an
`iframe.html` URL or scans without `storyUrl`. The addon still runs in the
Storybook UI.

### Shared live project in Playwright

Specs share one live project with `workers: 1`, so rows from earlier specs (for
example `guest:suggest` pending edits) are still present. A spec that acts on a
row it just created must wait for its own mutation's response and select the row by the id it returns
(`e2e/pendingEdit.ts` `openSuggestedPendingEdit`, Impact rows carry `data-pending-id`)
rather than trusting `.last()`.

Specs that set up state through the API post it with `e2e/documentCommand.ts`
(`postDocumentCommand`, `waiveRefineGate`) and undo each command they applied
in `finally`, so later specs see the fixture unchanged
(`e2e/applied-edit-seams.spec.ts`, `e2e/edit-boundary-touch.spec.ts`).

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

The US-2 host-disconnect scenario (`gui/web/e2e/record-host-reconnect.spec.ts`)
models a host drop with `installNetworkOutage` (`gui/web/e2e/networkOutage.ts`).
It uses `page.routeWebSocket` to proxy the host's `/api/host/ws` (the host
record plane) and the guest's `/api/rec/<token>/ws`, and it aborts the guest's
`/api/rec/` HTTP. A drop closes both sides of the proxied sockets, so the
server sees the host leave. Until restore, it refuses new sockets before they
open. A 2 s blip must reconnect in under 9 s and stay REC with one keeper
segment per side. A 14 s outage must show the guest "Host offline" copy
while its keeper grows, refuse a remint (409), then force PAUSED with
`pause_reason: host_reconnect` on the host's return. After Resume, Stop, and
file ACKs on the same `/rec/` token, the clips land. Auto-land does not return
its drift report to the browser, so the drift report after a host-reconnect
pause is asserted in `tests/test_record_host_reconnect.py`
(`test_land_after_host_reconnect_pause_reports_drift`).
Because a drop closes both proxy sides at once, the server always sees a clean
close with a fresh heartbeat. The stale-heartbeat branch of
`RecordSessionService.disconnect` (a socket that closes long after the network
died, `HOST_HEARTBEAT_STALE_MS`) and a sidecar restart without Leave are
covered only in `tests/test_record_host_reconnect.py`
(`test_delayed_host_disconnect_uses_stale_beat_for_reconnect_threshold`,
`test_restart_without_leave_still_pauses_on_host_join`).

### Browser acceptance matrix

Per-engine results for every check in the
[§ Browser compatibility matrix](#browser-compatibility-matrix) run. Each Pass
cell is backed by the required `frontend-e2e` job on `main`, which is what the
guard below enforces. The matrix was first assembled from #703 (Chromium,
PR #739) and #704 (WebKit, PR #747); those numbers are provenance only.
The Chromium column is Playwright's bundled Chromium,
standing in for Chrome (branded Chrome runs only locally, with
`E2E_BRANDED_CHROME=1`). The WebKit column is Playwright WebKit, standing in
for Safari; it is not Apple's Safari. No compat project runs Firefox, so no
Firefox result is claimed.

"Pass" means the required `frontend-e2e` gate includes the check on that engine
with `retries: 0` and no skip, so a green `main` is a measured pass. "Not run"
means no compat project runs it. Core-flow rows are the `test.step`s of its one
test; other rows are whole tests.

| Check | Spec | Area | Chromium (Chrome) | WebKit (Safari) | Firefox |
| --- | --- | --- | --- | --- | --- |
| record: keeper capture, upload and landing | `gui/web/e2e-compat/core-flow.spec.ts` | getUserMedia | Pass | Pass | Not run |
| transcribe: the episode transcript hydrates | `gui/web/e2e-compat/core-flow.spec.ts` | Core flow | Pass | Pass | Not run |
| tighten: the panel opens on its empty state | `gui/web/e2e-compat/core-flow.spec.ts` | Core flow | Pass | Pass | Not run |
| edit: correct a transcript word, then undo it | `gui/web/e2e-compat/core-flow.spec.ts` | Core flow | Pass | Pass | Not run |
| share: a viewer plays the per-track MP3 proxies | `gui/web/e2e-compat/core-flow.spec.ts` | Audio playback | Pass | Pass | Not run |
| export: bounce the mix to a non-silent WAV | `gui/web/e2e-compat/core-flow.spec.ts` | Core flow | Pass | Pass | Not run |
| advances playback across browser engines | `gui/web/e2e-compat/browser-matrix.spec.ts` | Audio playback | Pass | Pass | Not run |
| persists an offline comment across reload and replays its command | `gui/web/e2e-compat/browser-matrix.spec.ts` | IndexedDB | Pass | Pass | Not run |
| applies document updates after the socket reconnects | `gui/web/e2e-compat/browser-matrix.spec.ts` | WebSocket | Pass | Pass | Not run |
| rasterizes waveform tiles on every engine | `gui/web/e2e-compat/browser-matrix.spec.ts` | Waveform | Pass | Pass | Not run |
| keeps the listening shell usable on a touch phone | `gui/web/e2e-compat/browser-matrix.spec.ts` | CSS / layout | Pass | Pass | Not run |
| takes a recording guest from microphone consent to a live level | `gui/web/e2e-compat/browser-matrix.spec.ts` | getUserMedia | Pass | Pass | Not run |
| keeps ruler, tiles, envelope and scroll range exact at 15 M px | `gui/web/e2e-compat/deep-zoom.spec.ts` | CSS / layout | Pass | Pass | Not run |
| snap ticks, mute regions and a live trim ghost share the ruler geometry | `gui/web/e2e-compat/timeline-geometry.spec.ts` | CSS / layout | Pass | Pass | Not run |
| short desktop lanes reach the horizontal end with classic scrollbars | `gui/web/e2e-compat/timeline-scroll-end.spec.ts` | CSS / layout | Pass | Pass | Not run |
| Wordbar native boundary release and exact Undo work across browsers | `gui/web/e2e-compat/transcript-wordbar.spec.ts` | Core flow | Pass | Pass | Not run |
| phone Mix native edits and touch geometry across engines | `gui/web/e2e-compat/phone-mix.spec.ts` | Core flow | Pass | Pass | Not run |
| comment recovery keeps native disabled-button focus and sticky controls | `gui/web/e2e-compat/comment-undo.spec.ts` | Core flow | Pass | Pass | Not run |
| native envelope owner cancels locally and ignores synthetic foreign events | `gui/web/e2e-compat/envelope-recovery.spec.ts` | Core flow | Pass | Pass | Not run |
| actual sheet controls and help copy work in the compatibility browser | `gui/web/e2e-compat/touch-affordances.spec.ts` | CSS / layout | Pass | Pass | Not run |
| a phone held sideways keeps three compact lanes and Undo in reach | `gui/web/e2e-compat/phone-chrome.spec.ts` | CSS / layout | Pass | Pass | Not run |
| a phone in portrait keeps Undo and Redo on the tool row and five lanes | `gui/web/e2e-compat/phone-chrome.spec.ts` | CSS / layout | Pass | Pass | Not run |
| the phone timeline shows Undo and Redo; a Safari tab offers the Home Screen once | `gui/web/e2e-compat/phone-chrome.spec.ts` | CSS / layout | Pass | Pass | Not run |
| one finger moving never edits; a long-press arms, and the armed point drags in time and level | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| at 390x844 by default, one finger dragging a selected clip's trim end saves nothing and opens the strip, not the half sheet | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| an armed drag holds at a soft boundary, and saves there | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| a long-press arms a clip, which moves in time only, holds at its neighbour's edge and saves there | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| a second finger cancels an armed clip move | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| a long-press on empty space opens the create menu; Add envelope point adds one there | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| a long-press past the last clip opens the create menu and selects no text | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| the strip follows the finger; a flick opens or closes it fully, a slow drag lands at the nearest detent | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| a second finger cancels an armed drag and the create menu | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| the crossfade grip drags only once a long press arms it | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| #1135: a long-press at a join offers the ripple trim, which shows where later clips go | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| #1154: a touch ripple trim over the guest's speech asks first, and Leave a gap keeps it | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| #1135: a plain mouse grab at a join rolls it, as on main | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| a held nudge repeats, saves once, and one Undo restores it | `gui/web/e2e-compat/touch-nudge.spec.ts` | Core flow | Pass | Pass | Not run |
| a held nudge stops at a soft boundary with a cue; a fresh press goes past | `gui/web/e2e-compat/touch-nudge.spec.ts` | Core flow | Pass | Pass | Not run |
| pending and envelope strips: nudge rows, targets and axe (portrait-360) | `gui/web/e2e-compat/touch-nudge.spec.ts` | Core flow | Pass | Pass | Not run |
| pending and envelope strips: nudge rows, targets and axe (landscape-844) | `gui/web/e2e-compat/touch-nudge.spec.ts` | Core flow | Pass | Pass | Not run |
| chip: slid on, settled, slid along the axis | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |
| chip: lifted at the origin, chip pressed again, slid along the axis | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |
| chip: slid on and lifted without moving | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |
| chip: rested a long press, then dragged off the axis (fallback) | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |
| no grab while passing over chips or moving off the axis | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |
| the strip and the expanded inspector leave the selection in view | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |
| a drag stows the strip, which returns with the new value: portrait-360 | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |
| a drag stows the strip, which returns with the new value: landscape-844 | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |
| Expand is remembered for the next selection, and so is Collapse: portrait-360 | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |
| Expand is remembered for the next selection, and so is Collapse: landscape-844 | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |
| axe, both themes and reduced motion with the strip open | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |
| a second finger cancels the drag and pinches (portrait-360) | `gui/web/e2e-compat/touch-pinch.spec.ts` | Core flow | Pass | Pass | Not run |
| a second finger cancels the drag and pinches (landscape-844) | `gui/web/e2e-compat/touch-pinch.spec.ts` | Core flow | Pass | Pass | Not run |
| timeline text takes no selection or callout | `gui/web/e2e-compat/touch-selection.spec.ts` | CSS / layout | Pass | Pass | Not run |
| no shell row draws over the strip, nor the strip over it: portrait-360 | `gui/web/e2e-compat/touch-strip-stacking.spec.ts` | CSS / layout | Pass | Pass | Not run |
| no shell row draws over the strip, nor the strip over it: landscape-844 | `gui/web/e2e-compat/touch-strip-stacking.spec.ts` | CSS / layout | Pass | Pass | Not run |
| a pending edit's Approve and Reject sit above the strip, upright and sideways | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |
| Expand keeps the header, Collapse and Close usable at 844x390 with a 16 px root font | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |
| Expand keeps the header, Collapse and Close usable at 844x390 with a 24 px root font | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |
| Expand keeps the header, Collapse and Close usable at 844x390 with a 32 px root font | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |
| a timeline tap while a track's sheet is open goes to the strip: portrait-390 | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |
| a point saved from a track's envelope form stays in that sheet: portrait-390 | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |
| Tab focus never lands a field under the drawer header at 32 px text: a pending cut | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |
| the strip leaves the timeline undimmed and the half sheet dims it: portrait-390 | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |

A dated snapshot, not a threshold (measured locally on macOS as of #739 and
#747; no test re-checks these figures): the core-flow landed track peaked at
about 0.9999 on Chromium and 0.636 on WebKit, and the bounced WAV at about
0.892 on both. The walk took about 12.5–13.3 s on Chromium and 15.5–18 s on
WebKit.

Not covered, so still manual:

- Apple Safari, including Private Browsing.
- Native microphone permission prompts and hardware capture. Chromium records
  from its fake capture device and WebKit from its "Mock audio device 1".
- Firefox. It has no compat project; the Firefox pending-inspector layout is a
  [Follow-up](../ROADMAP.md#follow-up).
- Mobile browsers on physical devices (#301). The phone row uses an emulated
  `iPhone 13` profile.
- Live ASR and filler detection, which run server-side (`make e2e-slow`,
  `tests/test_tighten.py`).

`tests/test_browser_acceptance_matrix.py` guards this table (shared parsing in
`tests/markdown_table.py`). It derives the rows from
`gui/web/e2e-compat/*.spec.ts` and each engine cell from
`playwright.compat.config.ts`: a project for that engine that does not
`testIgnore` the spec means "Pass". It also fails if a compat spec uses
`test.skip`, `fixme`, `fail` or `only`, if the compat config's `retries` is not
0, if the `frontend-e2e-suites` matrix stops running the complete main shard set or the compat suite, or
installing an engine with a Pass cell, if the `frontend-e2e` aggregate can pass
without every matrix job succeeding, or if one of #30's areas (Audio
playback, getUserMedia, WebSocket, IndexedDB, CSS / layout) loses its last row
passing on both Chromium and WebKit. It reads the spec and config sources with
regexes, so it fails loudly on shapes it cannot read: a spec that mixes
`test.step` with a second `test()`, or a `testIgnore` entry that is not a
`"**/<file>.spec.ts"` string literal. A new spec or step, a `testIgnore` or a
Firefox project fails the guard until this table is updated.

### Browser compatibility matrix

Timeline geometry specs import stable DOM test IDs from
`gui/web/src/timeline/selectors.ts`. `e2e-compat/timeline-geometry.spec.ts`
uses a disposable aligned-dialogue copy with nonzero source and timeline starts,
then zooms, scrolls, and drags a trim-out handle. It compares snap ticks and mute
regions against rendered ruler ticks within 0.5 CSS px, and the trim ghost
waveform against the committed clip edge before verifying the saved trim.
The deep-zoom journey keeps its accessible envelope-point query and measures
waveform tiles, ruler ticks, and envelope chunks through the same hooks.

The `frontend-e2e-suites` compatibility job runs the focused
`gui/web/e2e-compat/` matrix (`playwright.compat.config.ts`) in bundled Chromium
and Playwright WebKit, concurrently with the sharded main Chromium suite on
separate runners. The required `frontend-e2e` check gates every shard and compat. It covers
fixture Raw audition playback
time advancing and staying fixed after Pause (the disposable fixture has no premix), a host
comment queued in IndexedDB across reload and replayed with the original
command identity until the queue drains, and an update from a second page
appearing through the reconnected document WebSocket. It also
covers the phone listening shell under an `iPhone 13` touch profile (coarse
pointer, viewport-derived x/y bounds), and the recording guest's
microphone-consent-to-level path. Per-engine results: [§ Browser acceptance
matrix](#browser-acceptance-matrix).

`e2e-compat/core-flow.spec.ts` walks the core flow in one test on a disposable
`aligned_dialogue` copy, with one `test.step` per stage, and runs on both the
`chromium` and `webkit` projects (#704). Chromium's fake capture device
(`--use-fake-device-for-media-stream`) feeds the real `getUserMedia`, and the
guest keeper goes through the AudioWorklet and OPFS writer, uploads, and lands
with a non-silent peak (`landedTrackPeak`; measured peaks per engine are in
[§ Browser acceptance matrix](#browser-acceptance-matrix)). WebKit needs its own
harness handling for the host and guest pages, both recorders:
`newContext({ permissions: ["microphone"] })` (`RECORDER_CONTEXT`) so real
`getUserMedia` resolves to WebKit's built-in "Mock audio device 1" instead of
staying blocked, and — because WebKit's ephemeral `browser.newContext()`
rejects `navigator.storage.getDirectory()` with `UnknownError` —
`browserType.launchPersistentContext("")` instead of `browser.newContext()`
for every page (`keeperContextSource`, `gui/web/e2e/keeperContexts.ts`), which
also has WebKit's `createSyncAccessHandle` working inside a worker. Both are
harness-only; the app needs no change for either. A WebKit run takes about
16–18 s end to end, against about 12.5 s on Chromium. The episode transcript
hydrates; "transcribe" is the browser rendering only, because live ASR is
server-side (`make e2e-slow`). The Tighten panel opens on its empty state. A
transcript word is corrected and undone with Mod+Z. A viewer review share
plays the per-track MP3 proxies through Web Audio (a 200 `audio/mpeg` chunk on
Play). A host Bounce dialog passes full-page axe (`expectPageAxeClean`) and
writes one non-silent WAV under `export/bounces/` — its own result copy goes
through `runAnnouncedJob` (`expectJobResult` → `announceJobResult`), and
`useJobStatusAnnouncement` speaks it in place of the generic Activity "ok"
headline instead of racing it (a real bug, not WebKit-only; `BounceDialog.tsx`
and `export.deliverables` in `commands/host.ts` share the fix, and it covers
the phone shell too). The stages run serially in one test
because export bounces the landed track, so with `retries: 0` a failing stage
skips the later ones until it is fixed; the report names the failing
`test.step`.

`e2e-compat/deep-zoom.spec.ts` stretches a disposable `aligned_dialogue` copy
to a one-hour session (`e2e/deepZoom.ts` `stretchProjectToSession`) and zooms to
`effectiveMaxZoomPxPerSec(3600)` (about 15 M px of content). At the end it
checks, within 1 px: `scrollWidth`, the reachable scroll end, the last ruler
label, tick offsets (`t × zoom`), tile placement on the 512 px grid ending at
the session end, and envelope point and chunk offsets. The Vitest helper test
also validates the actual stretched project against
`schemas/episode.project.schema.json` with strict draft 2020-12 Ajv, and checks
that malformed clip timing and envelope values report their schema paths.
`e2e-compat/timeline-scroll-end.spec.ts` uses the running desktop app, two
short lanes, and a rem-sized classic scrollbar. It checks for vertical fit,
horizontal overflow, and an end gap of at most 2 px on Chromium and WebKit.
Firefox is not in the matrix. Its layout limit (about 17.9 M px, from Gecko's
`nscoord_MAX`; see
[waveform.md § Deep zoom](waveform.md#deep-zoom)) comes from the engine source,
is not measured, and is above `max_content_px`.

The recording check uses `stubSyntheticMicrophone`
(`gui/web/e2e/syntheticMicrophone.ts`):
`getUserMedia` returns a live oscillator track, and the test polls the Level
meter until it reads a non-zero value. Chromium keeps its native Permissions
API; WebKit hides `navigator.permissions` so the matrix exercises Safari's
missing-`permissions.query` branch (`src/record/micPermission.ts`). It does not
verify native permission prompts or hardware capture; keeper audio and upload
are covered on both engines by the core-flow spec above.
Record rooms and E2E flags come from shared helpers: `gui/web/e2e/recordRoom.ts`
(`openHostRecordRoom`, `ensureHostRecordCommand`, `clickHostTransport`,
`landParticipant`, `joinAsGuest`, which names the guest only after its socket
has joined (`fillGuestDisplayName`) and returns once the room's roster lists
that name (#764), `joinAsProducer`, whose socket opens only on Join so it
registers the typed name; both type the name through `fillDisplayNameField`),
`gui/web/e2e/keeperContexts.ts` (`RECORDER_CONTEXT`,
`keeperContextSource`) and `gui/web/e2e/keeperOpfs.ts` for keeper OPFS inspection,
`gui/web/e2e/wavPeak.ts` (landed and bounced WAV peaks, via `landedTrackPeak`
(and `landedTrackPeakOrPending` for polling) in `recordRoom.ts` and
`bouncedWavs` in `gui/web/e2e/exportFiles.ts`),
`gui/web/e2e/playback.ts` (`expectPlaybackAdvancesThenHolds`) and
`gui/web/e2e/transcriptEdit.ts` (`openTranscriptPanel`,
`withDocumentCommandTypes`) and `gui/web/e2e/launchOptions.ts`
(`withLaunchArgs`, and `CHROMIUM_FAKE_MEDIA_ARGS`, which the main suite's
record specs share); guest review
shares come from `createReviewShare` in `gui/web/e2e/shareNavigation.ts`. This
keeps coverage focused on high-risk entry points without multiplying the
full suite across engines.

The compat config pins `workers: 1` / `fullyParallel: false` and `retries: 0`
(one shared web server and live project fixture) and writes to
`test-results/compat` so the main run's traces survive. `playwright.config.ts`, `playwright.compat.config.ts`,
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

The path-filtered `.github/workflows/deploy-config.yml` validates `deploy/` with real `caddy` and `docker compose` (see [§ Deploy config validation](#deploy-config-validation)).

The path-filtered `.github/workflows/desktop.yml` also builds the web distribution,
runs the portable desktop scaffold checks on Linux, and runs `cargo check` for the
Windows desktop binary. The Windows job logs
`cargo tree --locked -d --target x86_64-pc-windows-msvc --features app`
so reviewers can check for duplicate `windows` and `windows-result` versions.
The Windows job compiles WebView2-only adapters that macOS
and Linux cannot typecheck; installer creation remains in the reusable release
workflow. A `pinned-media-windows` job runs `tests/test_pinned_media.py` on `windows-latest` with Python 3.11 and 3.12 so the Windows fallback of pinned media reads is tested on NTFS at the `requires-python` floor and the sidecar's version, not only simulated. A `project-commit-lock-windows` job runs `tests/test_project_commit_lock.py`, `tests/test_history.py`, and `tests/test_review_versions.py` on `windows-latest` with Python 3.12 (installing a pinned FFmpeg 9.0.2 via Chocolatey first, since `tests/conftest.py::sample_wav` skips without it) so the cross-process commit lock and every review-publication test that does not stage media runs on real Windows; `requires_safe_cleanup` / `requires_safe_failed_cleanup` (`tests/review_platform.py`) skip the staging/quarantine paths that publication does not support there (see `docs/persistence.md`'s Inventory row for review publication).

Local mirrors:

```bash
make lint-py format-py-check typecheck  # Python static gates
./scripts/check_deploy_config.sh  # caddy validate + docker compose config for deploy/ (Docker required)
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
## Word-boundary benchmark

The real-speech reference fixture and its attribution are in
`tests/fixtures/word_boundary/README.md`. Three LibriSpeech `dev-clean` clips
have published MFA-generated word boundaries. They are a consistent reference,
not manually audited ground truth. Run the native baseline for each `*.gold.json`
with the locally cached faster-whisper `base` model:

```bash
.venv/bin/python scripts/benchmark_word_boundaries.py \
  --gold tests/fixtures/word_boundary/1988-147956-0023.gold.json \
  --native-model base --output /tmp/1988-native.json
```

Use `--prediction candidate.json` instead of `--native-model base` for another
aligner on the **same** audio; the candidate file contains the audio SHA-256,
nonempty `provenance` metadata (model, version, settings, license and optional
runtime), and an ordered `words` array of text/start/end objects. The script checks both
the gold fixture and candidate hashes against the audio
SHA-256, preserves predicted words and provenance in the report, and never
downloads a model. Scores count only normalized matching words in sequence.
Each gold and prediction transcript may contain at most 256 words; this
benchmark targets short clips and rejects longer inputs before alignment.
Report missed/extra words alongside boundary MAE (mean absolute start and end
error) and the fraction of matched words with either boundary off by >150 ms.
If no words match, MAE and the >150 ms fraction are `null`; missed/extra counts
still show the failed coverage. Exact monotone matching prefers lower timing
error when repeated words create equal text matches. The 256-word limit bounds
matching time and traceback memory even when a candidate inserts or omits a
long contiguous span.

The metric also reports a signed bias over matched words:
`mean_start_error_ms` and `mean_end_error_ms` are `prediction - reference`
in milliseconds, so a positive start means the candidate starts late and a
negative end means it clips the tail. CTC forced alignment tends to do both;
#641 and #639 use this bias to tune boundary padding, not just the
unsigned MAE.

The checked-in `*.native-base.json` reports measured 42 matching words across
48 reference words: 82.3 ms boundary MAE, 15/42 (35.7%) over 150 ms, six
missed and four extra words. The 24.0 s combined wall time includes three
separate Python/model-start processes on the local CPU and is not a normalized
inference-speed comparison. The benchmark does not alter production ASR
timestamps or the pipeline.

**Synthetic fixture.** `tests/fixtures/word_boundary_synthetic/` is a 2.5 s
tone-burst WAV with a hand-authored 5-word gold transcript and prediction.
Its README works out the expected metrics by hand (45.0 ms MAE, 1/4 words
over 150 ms, +40.0 ms start bias, −20.0 ms end bias), and a test asserts them
through both the library and the CLI. It is not speech and proves the metric
and harness, not aligner accuracy.

**Forced-aligner harness.** `scripts/benchmark_forced_aligners.py` runs pinned
CTC forced-aligner candidates (`plan` / `run` / `agree` / `download-commands` /
`verify-candidates` subcommands) that re-time an existing word list — native Whisper output, or a
candidate re-timing another candidate — using the numpy CTC Viterbi in
`src/podcast_mcp/engines/ctc_forced_align.py` (shared with the opt-in pipeline
pass in `engines/word_align.py`, #714). Targets:

- `librispeech` — scored against the same gold fixture as above.
- `aligned_dialogue` and `lab` — agreement only (native vs. each candidate,
  and candidates against each other). `aligned_dialogue` now composes
  complete human LibriSpeech utterances with shifted MFA-derived labels. This
  harness target retains its agreement-only contract; use `librispeech` for
  boundary scoring. Neither target supplies human-verified boundary gold.

**Shipped-pass harness (#715).** The `run`/`agree` subcommands above drive the
harness's own `align_prediction` (`retime_spans` against a bare backend), not
production code. A separate `pipeline` subcommand
(`--target librispeech|lab`) instead scores the exact shipped call chain
`transcribe.py`'s `_align_words` uses: `WordAligner.load` (pinned,
sha256-verified) → `WordAligner.align` → `apply_word_spans`. It shares
`prepare_items()` with `run`: decode audio, then take native words from the
checked-in fixtures, else from a `<id>.native.json` already in the runs dir
for the same `audio_sha256`, else from a fresh Whisper pass. A cached file for
the same audio with no recorded model, a different `--native-model`, or a
different installed version of its recorded native library is an error, never
overwritten, so an earlier pass's predictions in that dir stay paired with the
native words they re-timed. Point `pipeline` at the same runs dir as `run`
(both default to `$LAB_RUNS_DIR/align/<target>`) and both passes score the
exact same native words and audio; delete `<id>.native.json` to force a fresh
Whisper pass. Each item's cache check, Whisper run and write hold
`<id>.native.lock` in the runs dir (`util.file_locks.hold_shared_file_lock`, up to
an hour), so a second pass started into the same dir waits for the first,
then reuses its native words (or errors on a mismatch) instead of both
running Whisper. A refusal (mismatched cached words, a bad runs dir, a lock
still held after an hour) prints one `error: …` line to stderr and exits 2. It
writes `<id>.onnx-base-pipeline.json` predictions/reports plus a
`summary.onnx-base-pipeline.json` (never `run`'s `summary.json`, so both can
share one runs dir) with `scored`, `agreement`, `load_sec`, `asr_runtime_sec`
(recorded Whisper time for non-checked-in native words, cached ones included —
`None` for `librispeech`, which reuses checked-in native words) and a
per-item `duration_profile` (`word_boundary_metrics.word_duration_profile()`:
max/p95/p99 and counts over each of `DURATION_THRESHOLDS_SEC` — 1.00, 1.25,
1.50, 1.75, 2.00, 2.25, 2.50 s). `aligned_dialogue` is not a pipeline target:
when #715 ran, the fixture was non-speech tone with zero native words; since
#801 it is TTS speech but stays agreement-only. The label
is `onnx-base-pipeline`, not `pipeline-onnx-base`, so it never matches the
`run` harness's own `*.onnx-base.json` glob. A fast test
(`test_run_pipeline_pass_end_to_end_with_fakes`) covers the pass with a fake
aligner; `tests/test_word_align_real.py` (`e2e_real`) runs it for real. See
"Shipped pass results (#715)" below for the checked-in, measured numbers.

```bash
uv run python scripts/benchmark_forced_aligners.py pipeline --target librispeech --runs-dir .lab-runs/align/librispeech-pipeline
$LAB/scripts/with-asr-lock.sh uv run python scripts/benchmark_forced_aligners.py pipeline --target lab --lab "$LAB"
```

Candidates are declared in `tests/fixtures/word_boundary/candidates.json`
(Hugging Face repo + pinned revision + license; `onnx-base` also pins a
per-file `file_sha256` manifest checked against the production catalog).
Nothing in CI checks those
pins; run `uv run python scripts/benchmark_forced_aligners.py verify-candidates`
(network, metadata only — no weights) before relying on them. It exits 1 and
lists each candidate whose revision or repo no longer resolves, whose repo is
gated (needs an HF token / accepted terms), whose model-card license differs,
or whose pinned files are missing; a model card that declares no license is
not drift: it prints a `note:` line saying the pinned license was not
verified, and the exit code stays 0 (both ONNX candidates' repo,
`onnx-community/wav2vec2-base-960h-ONNX`, has no card license; its
`apache-2.0` pin comes from the upstream `facebook/wav2vec2-base-960h`); a
rate limit, Hub outage, timeout or connection error is reported as "could not
verify" (the pin may be fine — retry) rather than as drift. The harness
resolves each
model with `snapshot_download(..., local_files_only=True)` and **never
downloads**: an uncached model (a Hugging Face `LocalEntryNotFoundError`)
raises `FileNotFoundError` naming the exact download command, which
`download-commands` also prints; any other hub error (permissions, a corrupt
cache) propagates unchanged. Native words the
aligner leaves unaligned keep their Whisper times; zero-duration ones
(`start == end`, a known faster-whisper output) are dropped from each
candidate prediction and counted in `provenance.alignment_stats.dropped_zero_duration`.
Each side's `dropped_zero_duration` count in `*.agree.json` is that recorded
upstream count plus any zero-duration word still in the compared payload
(the native reference's are dropped there), so a candidate's agree count
matches its `alignment_stats`. `torch-large`
needs `uv sync --extra dev --extra gui --extra relay --extra joinqc`; the ONNX
candidates need only `onnxruntime`, which the base install gets transitively
through `faster-whisper` (it is not a direct dependency, so declare it if
faster-whisper ever drops it).

Each prediction's provenance records `runtime_sec`, `realtime_factor`,
`load_sec` and `peak_rss_mb`. `peak_rss_mb` is the process RSS high-water mark
(`peak_rss_scope: "process"`, `None` on Windows), so in a multi-candidate
`run` later candidates inherit earlier peaks; for per-candidate memory run one
`--candidate` per invocation.

**Candidate results (#641).** Measured 2026-09-27 on an Apple M2 Pro (12
cores, 32 GiB RAM), `--threads 4`, onnxruntime 1.27.0, torch 2.14.0,
transformers 5.17.0, faster-whisper 1.2.1. Reproduce with:

```bash
uv run python scripts/benchmark_forced_aligners.py download-commands   # then run what it prints
uv run python scripts/benchmark_forced_aligners.py run --target librispeech --runs-dir .lab-runs/align/librispeech --threads 4
```

For per-candidate peak RSS (`peak_rss_mb` is process-wide) run one
`--candidate` per process, and for the agreement targets:

```bash
uv run python scripts/benchmark_forced_aligners.py run --target librispeech --candidate onnx-base --runs-dir .lab-runs/align/librispeech-onnx-base --threads 4
uv run python scripts/benchmark_forced_aligners.py run --target librispeech --candidate onnx-base-int8 --runs-dir .lab-runs/align/librispeech-onnx-base-int8 --threads 4
uv run python scripts/benchmark_forced_aligners.py run --target librispeech --candidate torch-large --runs-dir .lab-runs/align/librispeech-torch-large --threads 4
uv run python scripts/benchmark_forced_aligners.py run --target aligned_dialogue --runs-dir .lab-runs/align/aligned_dialogue --threads 4
$LAB/scripts/with-asr-lock.sh uv run python scripts/benchmark_forced_aligners.py run --target lab --lab "$LAB" --threads 4
```

**Table 1 — scored, LibriSpeech, 3 clips (42 matched / 48 reference words).**

| Candidate       | matched/ref | MAE (ms) | over 150 ms  | start bias (ms) | end bias (ms) | unaligned words | alignment runtime (s, summed) | RTF    | load (s, per-candidate run) | peak RSS (MiB, per-candidate run) | download |
| --------------- | ----------- | -------- | ------------ | ---------------- | -------------- | ---------------- | ------------------------------ | ------ | -------- | -------------- | -------- |
| native `base`   | 42/48       | 82.26    | 15/42 (35.7%) | −62.38            | −85.95          | n/a (ASR)         | n/a (23.96 s incl. 3 process starts) | n/a  | n/a      | n/a            | already cached |
| `onnx-base`     | 42/48       | 42.98    | 2/42 (4.8%)   | +43.81            | −40.24          | 0                 | 0.81                            | 0.044  | 0.67     | 843.9          | 451 MiB (shared repo) |
| `onnx-base-int8`| 42/48       | 47.26    | 4/42 (9.5%)   | +43.81            | −48.81          | 0                 | 1.36                            | 0.074  | 0.41     | 599.3          | 451 MiB (shared repo) |
| `torch-large`   | 42/48       | 48.69    | 1/42 (2.4%)   | +58.57            | −34.05          | 0                 | 3.32                            | 0.181  | 11.70    | 2070.7         | 1.2 GiB |

`onnx-base` and `onnx-base-int8` share one Hub repo
(`onnx-community/wav2vec2-base-960h-ONNX`), so 451 MiB (`du -sh` on the cache
snapshot) covers both `onnx/model.onnx` and `onnx/model_int8.onnx` together;
`torch-large`'s 1.2 GiB is `facebook/wav2vec2-large-960h-lv60-self`'s
`pytorch_model.bin` plus config files. Native's row is faster-whisper ASR, not
a forced aligner, so its runtime/RTF/RSS aren't comparable to the candidates.

The `load` and `peak RSS` columns are a single local measurement (the machine
and date above) from the one-`--candidate`-per-process runs
(`--runs-dir .lab-runs/align/librispeech-<label>` above). Those per-candidate
reports are not checked in, so no test re-verifies these two columns; re-run
the three per-candidate commands above to reproduce them. Every other
candidate column comes from the combined `run --target librispeech` whose
reports are checked in as `tests/fixtures/word_boundary/<id>.<label>.json` and
re-scored by `test_checked_in_candidate_reports_match_reference_fixture` in
`tests/test_word_boundary_metrics.py`.
`load_sec` is measured once per candidate per run and copied into each clip's
provenance, so it is reported once here, not summed across clips. The
checked-in combined-run reports record `load_sec` 0.61 / 0.12 / 47.70 s and a
max `peak_rss_mb` of 852.9 / 852.9 / 2243.7 MiB for `onnx-base` /
`onnx-base-int8` / `torch-large`. RSS there is process-wide, so each candidate
inherits the earlier candidates' peaks (`onnx-base-int8` inherits fp32's
852.9 MiB). Load times also vary between runs with library-import and
disk-cache state (`torch-large` took 47.70 s combined vs 11.70 s alone), so
treat `load` as order-of-magnitude only.

**Table 2 — agreement against native Whisper `base`.** Measured before #801,
when `aligned_dialogue` was a non-speech tone fixture: `aligned_dialogue`
(2 × 60 s) produced **zero** native words: its old canned transcript did not match
the synthesized audio closely enough for faster-whisper `base` to transcribe
anything, so every candidate — which re-times the native word list, not the
audio directly — also has zero predicted words there. There is no agreement
number to report for `aligned_dialogue`; the lab tape is the only agreement
source below. On the **lab** tape (3 × 60 s, real 3-speaker Zoom speech):

| Candidate        | MAE vs native (ms) | over 150 ms   | start bias (ms) | end bias (ms) | RTF   | `onnx-base~X` pairwise MAE (ms) |
| ---------------- | ------------------- | -------------- | ---------------- | -------------- | ----- | -------------------------------- |
| `onnx-base`       | 115.56               | 53/162 (32.7%) | +162.59           | +18.40          | 0.018 | —                                 |
| `onnx-base-int8`  | 120.00               | 51/162 (31.5%) | +159.75           | +17.53          | 0.031 | 28.22 (163 matched)               |
| `torch-large`     | 127.65               | 58/162 (35.8%) | +185.06           | +42.35          | 0.035 | 33.37 (163 matched)               |

Agreement is not accuracy: it says how much the candidates disagree with
native Whisper's own (possibly wrong) word timestamps on real speech, not how
close either is to the truth. `onnx-base`'s share over 150 ms (32.7%) is under
the 50% threshold that would call for auditing `largest_disagreements` by
ear (see § Lab tape below), so no audit was needed.

**Recommendation: ship `onnx-base`.** Walking the fixed decision rule
(candidate #640 → #641 handoff) against the numbers above:

1. *Eligible* means lower MAE than native (82.26 ms) and fewer words over
   150 ms than native (15 of 42), with `unaligned_words` ≤ 3. All three
   candidates clear this (MAE 42.98/47.26/48.69 ms; over-150 counts 2/4/1;
   `unaligned_words` 0 for all three) — every candidate is eligible.
2. Prefer ONNX among eligible candidates (no new heavy framework, per #639).
   `onnx-base-int8` would be preferred over `onnx-base` only if its MAE were
   within 5 ms of fp32 **and** its over-150 ms count within 1 word of fp32.
   The MAE gap is 4.29 ms (within 5 ms) but the over-150 ms gap is 2 words
   (4 vs 2, not within 1) — so `onnx-base` (fp32) stays the ONNX pick.
3. `torch-large` only wins if it beats the best eligible ONNX candidate
   (`onnx-base`) by ≥15 ms MAE **and** ≥3 fewer over-150 ms words.
   `torch-large`'s MAE (48.69 ms) is *worse* than `onnx-base`'s (42.98 ms),
   so it does not qualify regardless of its over-150 ms count.
4. The winner's LibriSpeech RTF must be <0.5 at `--threads 4`. `onnx-base`'s
   RTF is 0.044 — comfortably under. No runtime fallback is needed.
5. At least one candidate is eligible, so this is not a "do not integrate"
   result.
6. Lab audit: `onnx-base`'s over-150 ms share on the lab tape is 32.7%, under
   the 50% by-ear-audit trigger, so no audit was performed.
7. **Small-sample caveat.** 42 matched read-speech words across 3 LibriSpeech
   clips is not podcast accuracy; the ~82 ms native MAE and the candidates'
   ~43–49 ms MAE are read-speech numbers. The lab agreement numbers (real,
   messier 3-speaker Zoom audio) exist to catch a candidate that only works
   on read speech — `onnx-base` stays the best (or tied-best) agreement
   candidate there too, so nothing in the lab run contradicts the LibriSpeech
   pick, but treat both as directional, not production accuracy claims.

**Padding hint for #639.** `onnx-base`'s signed LibriSpeech bias is
`mean_start_error_ms = +43.81 ms` (the candidate starts words late) and
`mean_end_error_ms = −40.24 ms` (the candidate clips word ends early). If
#639 adds boundary padding around `onnx-base` cuts, that suggests roughly
44 ms of pre-roll and 40 ms of post-roll to compensate — data only; #641
does not tune anything. See [#639](https://github.com/calebn/sharecut-studio/issues/639).

### Lab tape: alignment testing grounds

The lab checkout (see [Local lab verification](#local-lab-verification-private-tape)
above) has real 3-speaker Zoom speech with clipped consonants, quiet words and
overlap that the LibriSpeech clips don't exercise. With `LAB` and
`LAB_RUNS_DIR` exported as above, `run --target lab` clips each stem
(`source/zoom_excerpt_pan/audio*.m4a` by default, overridable with
`--lab-glob`) to 60 s, decoding only that window through ffmpeg, and writes
outputs under `$LAB_RUNS_DIR/align/lab`.

There is no ground truth on the lab tape, so read agreement, runtime/RTF, and
the ranked disagreement list (largest first) to audition candidates by ear
instead of trusting a single number. A hallucinated word over gated silence
(#521) is an ASR error, not a boundary error — don't blame the aligner for it.
To get real ground truth for a clip, hand-check its native words and save
them beside the clip WAV as a local `*.gold.json` in the same format as the
checked-in fixture gold, then score it with
`scripts/benchmark_word_boundaries.py --gold`.

**Rules**, on top of the lab rules above:

- Never write under `$LAB/source` or `$LAB/runs/baseline` — the harness
  refuses a `--runs-dir` inside the lab checkout.
- Full-length stems go through `$LAB/scripts/with-asr-lock.sh`.
- Never commit lab audio, transcripts or word text, and never paste word
  text into PRs or issues. Aggregate numbers (MAE, RTF, counts) are fine.

## Shipped pass results (#715)

[#641](#word-boundary-benchmark) benchmarked forced-aligner *candidates*
through the harness's own `align_prediction` (`retime_spans` against a bare
backend). [#715](https://github.com/calebn/sharecut-studio/issues/715) instead
measures the **shipped production pass** — `WordAligner.load` (pinned,
sha256-verified) → `WordAligner.align` → `apply_word_spans`, exactly what
`transcribe.py`'s `_align_words` drives — via `scripts/benchmark_forced_aligners.py
pipeline` (see "Shipped-pass harness (#715)" above) and real
`podcast pipeline run` timings. Measured 2026-09-28 on the same machine as
#641: Apple M2 Pro (12 cores, 32 GiB RAM), macOS 26.6.2, onnxruntime 1.27.0,
faster-whisper 1.2.1, Python 3.14.2, `onnx-base` pinned to
`onnx-community/wav2vec2-base-960h-ONNX` rev `729c1a6730fb549c20a1c73a3d3f96f11020225e`.
Reproduce with:

```bash
podcast bootstrap --component word-aligner
uv run python scripts/benchmark_forced_aligners.py pipeline --target librispeech --runs-dir .lab-runs/align/librispeech-pipeline
$LAB/scripts/with-asr-lock.sh uv run python scripts/benchmark_forced_aligners.py pipeline --target lab --lab "$LAB"
```

**Table 3 — scored, LibriSpeech, shipped pass (`onnx-base-pipeline`), 3 clips (42
matched / 48 reference words).** Checked in as
`tests/fixtures/word_boundary/<id>.onnx-base-pipeline.json`; re-scored and pinned
by `test_checked_in_shipped_pass_report_matches_pipeline_fixture`
(`tests/test_word_boundary_metrics.py`) and reproduced live by the `e2e_real`
`tests/test_word_align_real.py`.

| Pass                        | matched/ref | MAE (ms) | over 150 ms  | start bias (ms) | end bias (ms) | align runtime (s, summed) | RTF    | load (s) | peak RSS (MiB) |
| ---------------------------- | ----------- | -------- | ------------ | ---------------- | -------------- | -------------------------- | ------ | -------- | -------------- |
| native `base` (Whisper only) | 42/48       | 82.26    | 15/42 (35.7%) | −62.38            | −85.95          | n/a (ASR)                   | n/a    | n/a      | n/a            |
| `onnx-base` (#641 harness, `align_prediction`) | 42/48 | 42.98 | 2/42 (4.8%) | +43.81 | −40.24 | 0.81 | 0.044 | 0.67 | 843.9 |
| `onnx-base-pipeline` (#715 shipped pass, `WordAligner.align`) | 42/48 | 42.98 | 2/42 (4.8%) | +43.81 | −40.24 | 1.04 | 0.056 | 0.73 | 569.3 |

The shipped pass's scored numbers match the #641 harness's `onnx-base` row
exactly (same model, same CTC Viterbi in `engines/ctc_forced_align.py`, same
LibriSpeech clips) — this table exists to prove the shipped call chain, not the
harness's own path, produces these numbers. `runtime`/`load`/`peak RSS` differ
slightly: the shipped pass constructs `TranscriptWord`s and calls through
`apply_word_spans` (production's clamp-unaligned-runs pass), one process, no
per-candidate isolation, so peak RSS is lower than the harness's own
per-`--candidate` process measurement.

**Table 4 — lab agreement (real 3-speaker Zoom speech), shipped pass, 3 × 60 s
(162/162 matched — every native word matched; no ground truth, agreement vs.
native `base` only).**

| Pass                 | MAE vs native (ms) | over 150 ms    | start bias (ms) | end bias (ms) | align runtime (s, summed) | RTF    | ASR runtime (s, summed) | load (s) |
| --------------------- | ------------------- | --------------- | ---------------- | -------------- | --------------------------- | ------ | ------------------------- | -------- |
| `onnx-base-pipeline`  | 115.56               | 53/162 (32.7%)  | +162.59           | +18.40          | 3.49                         | 0.019  | 6.06                       | 0.42     |

Higher MAE and bias than the read-speech LibriSpeech table is expected —
real 3-speaker Zoom audio has overlap, clipped consonants and quiet words
that LibriSpeech doesn't exercise (see "Lab tape: alignment testing grounds"
above); over-150 ms share (32.7%) is under the harness's 50%-by-ear-audit
trigger. Not checked in (lab audio/words never enter the repo); reproduce
with the `pipeline --target lab` command above.

**Table 5 — `transcribe_tracks` runtime, flag off vs on** (2-minute lab
excerpt, `source/zoom_excerpt_pan`, 3 tracks, 416 words, large-v3-turbo CPU,
`podcast pipeline run --only transcribe_tracks --force`, 3 alternating reps
under `with-asr-lock.sh`, median reported; wall time via `/usr/bin/time -l`).

| Setting | Rep 1 (s) | Rep 2 (s) | Rep 3 (s) | Median (s) | Median align_sec (summed, 3 tracks) |
| ------- | --------- | --------- | --------- | ---------- | ------------------------------------- |
| `forced_alignment.enabled=false` | 55.02 | 54.77 | 53.85 | **54.77** | n/a |
| `forced_alignment.enabled=true`  | 66.60 | 64.00 | 72.20 | **66.60** | **9.09** (9.09 / 8.77 / 10.25) |

Forced alignment adds ~11.8 s median wall time (+21.6%) to `transcribe_tracks`
on this 2-minute, 3-track excerpt — consistent with the summed `align_sec`
(9.09 s median) transcribe.py now records per job (#715 Commit 1) plus process
overhead. One full `podcast pipeline run` per setting (`--skip
align_tracks,require_align_accept`, same excerpt) also passed, `export_qc.json`
`ok`, both settings: flag off **69.08 s** real, flag on **77.44 s** real
(+8.36 s, +12.1%; a smaller share than the `transcribe_tracks`-only delta
above, since the rest of the pipeline's fixed steps — stems, reconcile,
mix, master, export — take the same time either way).

**Table 6 — word-duration sensitivity table** (`word_boundary_metrics.
word_duration_profile`, `DURATION_THRESHOLDS_SEC`; counts strictly over each
threshold, across all predicted words on that target).

| Target | words | max (s) | p95 (s) | p99 (s) | over 1.00 | over 1.25 | over 1.50 | over 1.75 | over 2.00 | over 2.25 | over 2.50 |
| ------ | ----- | ------- | ------- | ------- | --------- | --------- | --------- | --------- | --------- | --------- | --------- |
| LibriSpeech (46 predicted words, 3 clips) | 46 | 0.76 | 0.76 | 0.76 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Lab (163 predicted words, 3 × 60 s)       | 163 | 0.60 | 0.56 | 0.60 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

No word on either target — read speech or real 3-speaker Zoom audio — comes
within 0.24 s of even the lowest 1.0 s threshold; the longest aligned word
anywhere measured is 0.76 s (LibriSpeech). This is the data behind the
Threshold (#715) rule in
[docs/transcript-workflow.md § ASR timing flags](transcript-workflow.md#asr-timing-flags):
L (longest aligned word 0.76 s + worst |duration error| vs gold 0.22 s) = 0.98
s, so `L + 0.5 = 1.48 <= 2.0` and `DEFAULT_MAX_WORD_DURATION_SEC` stays **2.0
s** (see the comment above the constant in `engines/asr_timing.py`).

### Aligner evidence floor (#195)

`test_evidence_floor_separates_real_words_from_silence_and_noise_probes`
(`tests/test_word_align_real.py`, `e2e_real`) force-aligns every LibriSpeech
word in `tests/fixtures/word_boundary/*.native-base.json` (46 words, 3 clips)
with the real, locally cached `onnx-base` aligner, then appends two probes
after `1988-147956-0023.wav`: 1.5 s of digital silence and 1.5 s of seeded
(`np.random.default_rng(0)`) Gaussian noise at −50 dBFS RMS, each given a
plausible word span. Reproduce with:

```bash
podcast bootstrap --component word-aligner
uv run pytest --no-cov -q -s -m e2e_real tests/test_word_align_real.py -k evidence
```

Measured 2026-09-28 on the same machine as #715 and #641: Apple M2 Pro (12
cores, macOS 26.6.2), 4 aligner threads.

| Signal | n | min | p5 | median |
| ------ | - | --- | -- | ------ |
| Real LibriSpeech words | 46 | 0.2499 | 0.8760 | 0.9765 |
| Digital-silence probe | 1 | 0.0008 | — | — |
| Low-level (−50 dBFS) noise probe | 1 | 0.0001 | — | — |

**Rule applied:** the real-word minimum (0.2499) is well above 10× the
shipped default (10 × 0.01 = 0.1), and both probes score far below the
default floor. Branch 1 (lower the default) and branch 2 (turn the signal
off) do not apply; the shipped default stays **`min_word_score: 0.01`** in
`.agents/defaults/pipeline.yaml`, `AsrOptions.forced_alignment_min_word_score`
and the `transcribe.forced_alignment.min_word_score` `ParamField`.


### Retained mixed bleed and local phrase alignment

`test_bleed_delay_evidence.py` covers signed 150–350 ms recorded copies with
extended reference context, EQ/noise/gain variations, shifted-null and periodic
controls, independent co-speech, changing local delays, and numerical stability
near silent references. Long-delay profile evidence is opt-in and bounded; the
existing short-delay echo rates and threshold contract are unchanged.

`test_retained_bleed_alignment.py` renders literal PCM to check complete direct
phrase preservation, byte-identical mixed speech, unchanged audio outside the
requested region, quiet slack in every channel (including anti-phase activity
and short bursts), crossfade-clock abstention for each participant, independent
held-out delay stability, supported copy endpoints (interior-only evidence
abstains), agreement across all known retained peers, original outer fade preservation, stale-plan rejection,
repeat/reopen convergence, history restoration of timing choices, source-scoped
quiet-overlap provenance, no stacked-media QC issues, and saved mix mutes. It
includes comparable broadband and narrowband overlapping-owner cases. Seed-reporting
controls compare a supported 150 ms copy with the same samples after erasing only
copy words, missing transcripts, out-of-scope seeds, and no-copy audio in the
transcript-only workflow. They check
`no_retained_bleed_candidate`, unchanged project/PCM on empty-plan apply, and
preserved mute, implicit-timeline, empty-lane, missing-audio, recorder-lock, and
saved-choice outcomes. Cross-role controls preserve a lane's missing-copy-seed
status when it serves as a direct reference elsewhere. Service and CLI tests
check default-gate propagation and nonmutating preview output. A louder-owner case
currently abstains because evidence is weak; amplitude alone does not establish
that delay is unidentifiable.

The local planner uses NCC >= 0.25 plus >= 0.2 shifted-null margin, >= 0.05
competing-peak margin, at least three disjoint supported windows, and <= 2 ms
held-out residual. Supported probes must also cover both inferred copy phrase
endpoints. This bounds measured lag consistency; it does not establish samplewise
perfect alignment between probes. General long-delay profiling retains NCC >= 0.5.
Independent held-out calibration (20 seeds per condition) accepted 100/100 clean, EQ, room,
noise, and equal-RMS overlapping-owner cases, 1/20 owner-at-+10-dB cases, and
0/60 drift, periodic, and unrelated controls. Multipath can select the dominant
audible copy rather than first arrival. These synthetic controls are finite
validation, not a guarantee for every room or speaker. The prior transcript-seeded
investigation of a private episode found zero complete phrases meeting all
automatic guards; that result does not assess the bounded discovery path. Isolated
copy evidence must not be reported as a successful correction.

Full-band seam reads are restricted to complete phrase candidates (maximum
30 seconds plus boundary context); plans examine at most 64 candidate phrases
and at most 10 independent delay windows per relevant lane pair/phrase. The
coarse evidence runs at 8 kHz and source-decode temporaries are released after
each local pair measurement. Delay reads include the configured maximum lag and
shifted-null context, with the window's timeline origin passed to measurement.
Instrumentation on a two-hour source bounds a three-second local probe to at
most 32 decoded seconds per lane while checking copy, periodic, and unrelated
controls. Default echo profiling does not invoke long-delay measurement.
The alignment suite also checks manual per-clip locks after split/punch and scoped
override/reopen, competing batch footprints, preservation of both nearby phrases,
secondary-source transcript selection and word coverage, explicit unresolved
missing/suppressed/unmatched phrases through the default service, and safe abstention
on implicit full-media timelines. Operation counts verify one phrase-index build
per direct lane and termination once the 64-phrase budget is exhausted.
`test_retained_bleed_discovery.py` proves explicit finite lane/start/end discovery
recovers the identical complete -150 ms move after copy words are erased, with
stationary mixed PCM, preserved retained words, unchanged out-of-scope audio and
reopen convergence. Controls cover unrelated/periodic/weak audio, insufficient
null context, endpoints and active interiors, source-specific secondary/alias
transcripts, overlapping unknown sources, saved holds and recorder locks. Unknown
third lanes must agree or be measured quiet; conflicting, unrelated, unreadable
and crossfade lanes veto. A global budget charges every phrase attempt, pair
measurement and quiet read, with reservation before required peer checks. Tests
reject partial candidates, enforce the completed 30-second bound, forbid cold
whole-recording gate plans and bound whole-planner reads on a two-hour source.
The unbounded workflow remains transcript-seeded and retains its prior budget.
CLI and default-gate tests distinguish unbounded no-candidate reporting from
explicit scoped discovery. Actual-WAV ownership regressions add a local-only
237 Hz tone and retain explicitly foreign words: bleed status, foreign dominant
lane and foreign speaker match each forbid owner authorization through both
candidate origins, including manual unsuppression. Conflicting own-lane status
does not override a foreign speaker match. Unattributed, own-lane and manually
retained local-owner controls retain the supported 150 ms move without changing
text decisions. Interior and completion-margin foreign controls cover retained,
suppressed and ignored rows under both identity and shifted timeline placements;
other-recording and outside-source-interval positives remain supported. Synthetic
evidence does not replace artifact listening.

Additional regressions cover reciprocal batch dependencies with supported scoped
own-only proposals, reciprocal foreign-interval refusals, stationary secondary
references during another supported move and competing secondary-reference
dependencies, previous-evidence-revision plan rejection,
unsupported measured active interiors despite agreeing endpoints, distinct ASR
seeds expanding to one acoustic phrase, and declined choices after actual
move-away/back source pinning and workspace reopening. Identity controls cover
legacy decisions, relative/absolute aliases, another selected recording, and the
absence of plaintext paths from persisted recording digests.
Selected-source regressions also cover missing secondary transcripts in phrase
planning, quiet-trim authorization, ignored-word muting, and conversation tokens.
Actual gate plans must abstain for an untranscribed secondary recording while
relative/absolute primary aliases and exact secondary transcripts remain usable.
Secondary transcript suppression and dominant-source changes invalidate the gate
payload and rendered-stem hash; all consumed source identities and word evidence
are fingerprinted.

### Wordbar timing regression coverage

`test_transcript_timing.py` covers exact primary/extra source keys, primary aliases, unplaced words, no-op history, stale sequence/flags/neighbors/media, measured waveform duration, automatic evidence versus locked choices, and exact Undo. `test_word_timing_adapters.py` covers the host adapter and source audio boundary. Frontend Wordbar tests exercise one save per pointer release, cancellation, explicit keyboard/numeric Apply, exact raw preview identity, local waveform viewport, stale recovery and axe. Transport/session tests cover ownership, unchanged timeline position, player reuse and suppression of pending WebSocket fallback writes. Browser checks must verify actual saved timing and Undo, source URLs/clocks and populated local waveforms; an artifact trace does not certify perceptual listening.

### Sequenced browser fixtures

Browser fixtures that alter project view data intercept `/api/document/state` and
modify the envelope's `project` member or its detail `patch`. Bootstrap timing tests
hold this sequenced endpoint and suppress the document socket hello, so they exercise real loading chrome.

### Transcript boundary archive

`tests/test_transcript_archive.py` and `tests/test_edit_boundaries.py` exercise real cuts, source identity, complete-word restoration, metadata, source ordering, save/reload, and history. Run `uv run pytest -q --no-cov tests/test_transcript_archive.py tests/test_edit_boundaries.py` for focused feedback. `gui/web/e2e/edit-boundary-archive.spec.ts` drives a real cut and mouse roll, verifies the restored chip after reload, then checks undo and redo against the disposable project. Run it with `npm run test:e2e -- e2e/edit-boundary-archive.spec.ts` after the E2E build.

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

## Exact selected ranges

`tests/test_selected_range.py` proves repeated-source occurrence scope, moved clips, overlap, disjoint islands, unchanged peers, stale geometry and media, guest and agent proposal authority, atomic Undo, and intentionally empty lane rendering. Run it with retained Python and supported disposable share identity and registry overrides.

## Exact selected-range checks

`tests/test_selected_range.py` covers repeated recordings, same-baseline bulk
approval, mixed cuts/mutes, stale atomic rejection, unknown implicit extents,
canonical microfades and whole-action Undo. `tests/test_range_audio.py` decodes
actual PCM to check selected-lane/full-mix isolation, gain parity, silent island
gaps, full-lane duration and all-muted pending A/B. The frontend selection,
gesture and shared-action suites cover resolution, permissions and live guards.
`gui/web/e2e/contextual-range.spec.ts` walks guest suggestion → host approval →
Undo, host repeated-copy Cut/Mute, phone armed clip-body selection, orphan edit
reachability after inspector collapse, and desktop/phone action-surface axe.

The Commenter scenarios mint a Commenter link through `POST /api/shares` with
`role: "commenter"`. They check the guest banner, an unapplied proposal, denied
approval, Suggested audio playback, host review in Impact, and the guest's
refreshed clip geometry after approval. The Editor scenario remains separate
because an Editor applies instead of proposing.

`useProxyTransport.test.tsx` runs the proxy and HTML audio hooks together to
check preview ownership, a paused proxy, unchanged session playhead and playback
intent, suppressed timeline clock and meters, release back to timeline playback,
and disposal on a project switch. A stopped preview keeps its ownership until
explicit release.

`tests/test_bleed_review.py` generates stereo WAVs and exercises registered MCP proposals, retries, HTTP host approval, pending/approved PCM, stale geometry/media, undo and range starts inside mute envelopes. Discovery regressions cover broad versus narrow requests with missing, partial, gapped or ambiguous peer placement; actual receiving and peer source duration, including alternate source offsets; repeated selected media probe counts; zero probing without eligible intervals; and complete protection after diagnostic truncation.

Generated unequal-audio-stream M4A and video-with-short-audio MOV files exercise receiving and peer selected-stream bounds. M4A multiple-stream extents refuse conservatively, while a known MOV audio interior remains eligible. Unknown and estimated audio extents refuse.

`tests/test_media_probe.py` verifies distinct container and first-audio duration policies over shared successful probe metadata, revision invalidation, copied results and failed-probe retries. Discovery separately verifies failed-probe memoization per receiving lane and retry on the next call. Full recording auditions supplement these regressions. Short reviewed excerpts are checked in under `tests/fixtures/lab_bleed/`; neither the excerpts nor the auditions prove automatic ownership detection. See [reviewed bleed ranges](transcript-reconcile.md#reviewed-bleed-ranges).
