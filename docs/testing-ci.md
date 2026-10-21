# CI jobs and browser acceptance

What each CI job runs, which jobs a run needs, and the browser acceptance matrix. [testing.md](testing.md) keeps the test commands, quality tooling and coverage policy.

## Superseded PRs and main bursts

The test, desktop, Storybook, extras-import, secret-scan,
registry-backup-windows, and relay-ci workflows cancel a superseded first-attempt
PR run in the same workflow and PR group. A rerun gets its own group so rerunning
an older head cannot cancel the latest head's checks.

First-attempt pushes to `main` share one group per workflow and do not cancel the running run.
GitHub keeps at most one running and one pending run in each group, replacing an
older pending run when another arrives. A burst can therefore discard intermediate runs. The last run to enter the
pending slot is retained, which can be an older commit because GitHub does not
guarantee dispatch ordering. Coalescing does not guarantee validation of the
current main tip. Before merging,
verify the exact PR head and its integration with current `main` as usual.

If a coalesced main run fails, inspect or bisect the commits since the previous
successful run. Each retained main run and the full nightly test run retain the
coverage floor and both browser engines. Scheduled and manual dispatch runs have
unique groups, so pushes cannot cancel them or replace their pending runs.
This policy changes scheduling, not which checks a run plans.

## CI

GitHub Actions workflow `.github/workflows/test.yml` runs Python, frontend and
a six-job browser matrix (plus the advisory `pytest-python-floor`) in parallel on
pushes to `main`, nightly and on `workflow_dispatch`. On pull requests the
`changes` job skips what the diff cannot reach (see
[§ Which jobs a run needs](testing.md#which-jobs-a-run-needs)). **All required checks must pass** (including Playwright axe) for a green build:

| Job | What |
|-----|------|
| `changes` | Not a required check. Runs `scripts/ci_plan.py plan` and hands `frontend-suite` and the browser matrix their plan; both required frontend aggregates fail when it does not succeed. |
| `pytest` | Python 3.14 with CTracer. `ruff check` + `ruff format --check` + `bandit` + `vulture` + `deptry` + `mypy` + `pytest -n auto -m "not e2e_slow and not e2e_real"` (Python coverage gate; `tests/test_generated_artifacts.py` runs every generated-artifact and contract check, so one failing file names the stale output). On a PR that changes only `gui/web/`, or only docs, it runs only the test files that read those paths, without coverage. A strictly proven version-only release refresh runs the planner and version-policy tests without coverage; [final release validation](#release-refreshes-and-final-validation) still requires a full pre-merge receipt. |
| `pytest-python-floor` | Advisory (not a required repository merge check): Python 3.11, the `requires-python` floor, runs `tests/test_wav_util.py` and `tests/test_bleed_gate_channels.py`, which pin the EXTENSIBLE-WAV reads that 3.11's stdlib `wave` rejects (#1183). The full `pytest` job uses 3.14; a local 3.11 venv reproduces the gap. |
| `frontend-suite` → `frontend` | The workload runs in `gui/web`: `npm ci`, `npm audit --omit=dev --audit-level=high` (advisory, `continue-on-error`, failures noted in the job summary; see [§ Dependency updates and audit](testing.md#dependency-updates-and-audit)), `npm run lint` (oxlint + Stylelint tokens/rem/`@container`; `!important`/`@layer` consent-gated), `npm run format:check` (Biome), `npm run typecheck` (strict `tsc`), `npm test` (Vitest + `axe-core` via `expectNoA11yViolations`; all `.stories.ts` and `.stories.tsx` modules are discovered, rendered with Storybook preview annotations, played, and axe-checked including body portals by `gui/web/src/test/allStories.test.tsx`; keeper PCM/WAV/segment bars in `gui/web/src/record/keeper/`; mix-minus MM1–MM9 in `gui/web/src/audio/mixMinus.test.ts`; stories/Storybook/test helpers never imported by app code or root build configs in `gui/web/src/test/storyGovernance.test.ts`), `npm run build` (Vite module-ID guard rejects story/Storybook inputs in every app build) |
| `frontend-e2e-suites` → `frontend-e2e` | On `main`, nightly and dispatch, six matrix jobs build Sharecut Studio and install only their declared browser engine with Playwright `--with-deps`: the four main-suite shards (`main-1of4` through `main-4of4`) use Chromium, `compat-chromium` uses Chromium, and `compat-webkit` uses WebKit. They run Playwright against a **temp copy** of `aligned_dialogue` (no committed waveform data: pyramids build on demand from fixture WAVs; the copy skips `artifacts/`, `history/`, `export/`, `_build/`, `.git`, and sync sqlite; see [§ Fixture hygiene](testing.md#fixture-hygiene)). Ordinary loopback Playwright launches leave `podcast gui` unpinned and provide each temporary `?project=` path. The main jobs run `npm run test:e2e -- --shard=i/4`; each deletes its live copy after Playwright terminates the web server. Host→guest follow seeds a temp premix and needs `ffmpeg` on PATH. `e2e/host-tab-selection.spec.ts` opens two host tabs on one project: a click in one leaves the other's selection alone, and an agent-set selection reaches both. Presence follow also covers tab follow, chrome ghosts, lane-bottom no-jump, guest Pipeline/FX degrade, and the 360px phone guest follow banner (`e2e/presence-follow.spec.ts`). Full-page axe runs through `expectPageAxeClean` in `gui/web/e2e/axe.ts`. Each compatibility job runs the complete matrix for its named engine with one worker and one CI retry (see [§ Browser compatibility matrix](#browser-compatibility-matrix)). A pull request with a GUI-facing change runs the four main shards and `compat-webkit-1of2` / `compat-webkit-2of2` instead of the two compat engines. Failed-spec traces upload as `playwright-test-results-<name>` (`main-1of4` through `main-4of4`, `compat-chromium`, or `compat-webkit`; `compat-webkit-1of2` or `compat-webkit-2of2` on a PR). Every job uploads timing JSON as `playwright-reports-<name>` with the same suffixes. Both artifact types are kept for 7 days. The required `frontend-e2e` aggregate rejects any failed or cancelled matrix result, a skip the plan did not order, and a `changes` job that did not succeed. Firefox pending-inspector layout remains [Follow-up](../ROADMAP.md#after-the-beta) (original #155 report was Firefox @ 1280). `e2e/root-pin.spec.ts` checks that `/` with a pinned project redirects to it and never POSTs `/api/project/close`; specs that need Home load `/?home=1`. |

The [release refresh and final validation policy](#release-refreshes-and-final-validation) describes the advisory selector jobs and the mandatory full release receipt.

First-attempt PR runs of `test.yml` share a concurrency group by workflow and
PR number. A new head cancels older first-attempt work for that PR. Runs for
other PRs and pushes to `main` have separate groups. Manual reruns use their
unique run ID instead of the PR group, because a rerun retains its original
head. This prevents an old-head rerun from cancelling running latest-head work
or replacing pending latest-head work. Deliberate reruns execute independently
and can still consume runner time. Recheck required CI on the exact final head
before merge. Cancellation of an obsolete head never certifies the latest head.

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

### Python test runtime

The required `pytest` job uses one locked Python 3.14 environment for quality
checks, compatibility checks, and all four planner scopes. Its job environment
sets `COVERAGE_CORE=ctrace`. The `dev` extra requires `coverage[toml]>=7.16.2`,
and `uv.lock` pins coverage 7.16.2.

The same lock resolves uvloop 0.23.0 on Uvicorn's existing supported platforms.
CLI/MCP handoff tests retain production `auto` loop selection. Relay WebSocket
test helpers enter the connection context before hello/register and close it even
when the handshake fails. SQLite tests explicitly close their own resources;
[store ownership](persistence.md) also covers normal last-owner cleanup, cycles,
cross-thread release, failed close, and registry replacement.

After the temporary-storage privacy check, the context preflight starts a
coverage probe with `data_file=None`, records the active core from
`Coverage.sys_info()`, and stops the probe without writing coverage data.
Any core other than `CTracer` fails before the planned workload. The context
artifact records the interpreter, package versions, and active core.

The supported Python floor remains 3.11, Ruff targets `py311`, and mypy targets
3.12. Other jobs keep their existing interpreters. Coverage sources, branch
collection, exclusions, worker policy, marker selection, and both 95% gates
remain unchanged.

### Temporary storage

The `pytest` and `frontend-e2e-suites` jobs in `test.yml` and the `extras` job in
`extras-import.yml` first create a random private directory under `/var/tmp` with
`umask 077` and `mktemp -d /var/tmp/sharecut-ci.XXXXXX`. The runner owns this
mode-0700 leaf; the shared parent remains root-owned. The first step publishes
`TMPDIR` through `$GITHUB_ENV` before checkout or installation, so Python temporary
directories, clean extra environments, and Node E2E fixture copies inherit it.
This avoids the `/tmp` tmpfs quota and the extended ACLs on hosted `/home` ancestry.

After dependencies are installed, each job calls the production `registry_privacy`
guard with empty names and `create=False`, then invokes its verifier. This read-only
preflight checks the leaf and every ancestor without creating registry files or
changing permissions. A rejected path stops the workload. The pytest context
artifact, browser dependency-install log, and extras probe log record `TMPDIR` and
`df -hT /tmp "$TMPDIR"`. Fixture isolation, existing cleanup ownership, concurrency,
and the 95% coverage gate remain unchanged.

### Locked Python installation

`.github/actions/install-locked-python` serves Linux and Windows callers with
their existing extras. Its bootstrap still runs `python -m pip install --upgrade
pip uv`. It records the active interpreter's absolute `sys.executable`, Python
major and minor, installed uv version, and the native path from `uv cache dir`.
`actions/cache@v6` stores only that package content directory. Its key includes
runner OS and architecture, Python major and minor, uv version, and hashes of both
`uv.lock` and `pyproject.toml`, and the sorted unique requested extras. A shared
restore prefix reuses package content while each extras set saves its complete
cache. It does not restore an installed environment or
change PATH. Existing `actions/setup-python` pip caches remain for bootstrap and
editable builds where callers configure them.

The default `environment: project` exports all requested extras with `uv export
--locked --no-emit-project --no-hashes`. A stale lock fails before dependency installation.
`uv pip install --python "$PYTHON_EXE" --compile-bytecode -r` consumes the exported
requirements and targets the captured interpreter. Eager bytecode compilation
preserves pip's existing installation behavior. The final step remains
`python -m pip install --no-deps -e .`. Neither a cache hit nor a miss skips export,
installation, caller checks, or the coverage gate. The weekly `extras-import`
workflow keeps its deliberately unlocked environments to detect upstream changes.

Only `frontend-suite` selects `environment: frontend-exporters`, with no extras.
It exports `dependency-groups.frontend-exporters` using `uv export --locked
--only-group frontend-exporters --no-hashes`. The group declares `pydantic`,
`pyyaml`, `filelock`, `numpy`, and `coolname` with the existing project constraints;
uv selects their locked transitive dependencies. Installation uses the same
captured interpreter and bytecode compilation, then runs `uv pip check --python
"$PYTHON_EXE"` and omits editable project installation. The four generated-file
exporters still run after `npm ci`, importing the checkout's `src` tree. A new
unavailable import fails those checks. This group does not install the GUI runtime;
browser suites keep their `gui` extras.

An unknown environment or exporter mode with nonempty extras fails before
bootstrap. Exporter mode uses a tagged selection hash distinct from project extras;
project hashes, cache dimensions, and the shared package-content restore prefix
keep their existing behavior. Cache hits still require locked export, installation,
and dependency validation. Export, install, and dependency-check failures stop the
recipe without falling back to a larger environment.

`tests/test_ci_dependency_cache.py` checks cache identity and executes the shell
recipe in disposable environments with local command controls. Full package
inventory, exporter behavior, Windows interpreter identity and PATH, and existing
native jobs require their normal CI checks. Local installer timing establishes
only the measured local path, not whole-job or CI savings.
The pytest context artifact records visible logical CPUs and CPU affinity beside
the unchanged four-worker cap so runner execution can qualify local measurements.

### Browser acceptance matrix

Per-engine results for every check in the
[§ Browser compatibility matrix](#browser-compatibility-matrix) run. Each Pass
cell is backed by the required `frontend-e2e` job on `main` and nightly, which
is what the guard below enforces. Pull requests run only the WebKit column. The matrix was first assembled from #703 (Chromium,
PR #739) and #704 (WebKit, PR #747); those numbers are provenance only.
The Chromium column is Playwright's bundled Chromium,
standing in for Chrome (branded Chrome runs only locally, with
`E2E_BRANDED_CHROME=1`). The WebKit column is Playwright WebKit, standing in
for Safari; it is not Apple's Safari. No compat project runs Firefox, so no
Firefox result is claimed.

"Pass" means the required `frontend-e2e` gate on `main` includes the check on
that engine with at most one retry and no skip, so a green `main` is a measured
pass. "Not run" means the CI compat project for that column does not run it. Core-flow rows are the `test.step`s of its one
test; other rows are whole tests. The seven direct compat axe owners and the
shared touch-affordance and Mix helpers assign compat scans to WebKit.
Main Chromium Studio scans and all reading-surface scans remain enabled.
Chromium retains every non-axe assertion in the compat specs it runs.
Branded Chrome keeps its full local inventory. Its `browserName` is `chromium`,
so those conditional scans do not run there. Comment-undo and wordbar retain
their existing unconditional helper scans in branded Chrome.

The drawer-drag rows also run on Firefox from the opt-in `playwright.firefox.config.ts`
(`npm run test:e2e:drawer-firefox`), which is why their Firefox cell stays Not run here.

The touch-nudge strip rows and touch-peek theme and motion row describe
assertions both engines run. WebKit also scans every collected strip state
with axe before the collected results are asserted.

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
| the drawer handle drags up and back down repeatedly | `gui/web/e2e-compat/drawer-drag.spec.ts` | CSS / layout | Pass | Pass | Not run |
| the handle's hit area stays below the timeline's scrollbar and keeps its grip visible | `gui/web/e2e-compat/drawer-drag.spec.ts` | CSS / layout | Pass | Pass | Not run |
| double-clicking the drawer handle collapses it and the rail handle reopens it at the same height | `gui/web/e2e-compat/drawer-drag.spec.ts` | CSS / layout | Pass | Pass | Not run |
| Wordbar native boundary release and exact Undo work across browsers | `gui/web/e2e-compat/transcript-wordbar.spec.ts` | Core flow | Not run | Pass | Not run |
| phone Mix native edits and touch geometry across engines | `gui/web/e2e-compat/phone-mix.spec.ts` | Core flow | Pass | Pass | Not run |
| comment recovery keeps native disabled-button focus and sticky controls | `gui/web/e2e-compat/comment-undo.spec.ts` | Core flow | Not run | Pass | Not run |
| native envelope owner cancels locally and ignores synthetic foreign events | `gui/web/e2e-compat/envelope-recovery.spec.ts` | Core flow | Pass | Pass | Not run |
| actual sheet controls and help copy work in the compatibility browser | `gui/web/e2e-compat/touch-affordances.spec.ts` | CSS / layout | Pass | Pass | Not run |
| a phone held sideways keeps three compact lanes and Undo in reach | `gui/web/e2e-compat/phone-chrome.spec.ts` | CSS / layout | Pass | Pass | Not run |
| phone zoom keeps the compact transport and Listen timer inside the viewport (#1636) | `gui/web/e2e-compat/phone-transport-zoom.spec.ts` | CSS / layout | Pass | Pass | Not run |
| compact transport at 200% text keeps More History below the bar (#1636) | `gui/web/e2e-compat/phone-transport-zoom.spec.ts` | CSS / layout | Pass | Pass | Not run |
| a phone in portrait keeps Undo and Redo on the tool row and five lanes | `gui/web/e2e-compat/phone-chrome.spec.ts` | CSS / layout | Pass | Pass | Not run |
| a 360px phone keeps Zoom, Undo and Redo on the tool row, and Zoom runs | `gui/web/e2e-compat/phone-chrome.spec.ts` | CSS / layout | Pass | Pass | Not run |
| an iPad Air 1180 wide in landscape keeps Select, Blade, Select range, + Track and Import on the rail | `gui/web/e2e-compat/phone-chrome.spec.ts` | CSS / layout | Pass | Pass | Not run |
| an iPad Pro 11 1194 wide in landscape keeps Select, Blade, Select range, + Track and Import on the rail (#1674) | `gui/web/e2e-compat/phone-chrome.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 932x430: the edited lane stays above the sheet and Add point and Done are in reach | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 932x430: the form, Save and Cancel are visible with the lane, and with the keyboard up | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 932x430: Add point, Save and Cancel run from inside the sheet | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 914x331: the edited lane stays above the sheet and Add point and Done are in reach | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 914x331: the form, Save and Cancel are visible with the lane, and with the keyboard up | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 914x331: Add point, Save and Cancel run from inside the sheet | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| a typed envelope draft survives rotating from portrait to landscape | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| the bottom panel splitter can shrink a short window's default panel | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 667x375 phone shell (iPhone SE): the edited lane, the form and Done stay on screen, with and without the keyboard | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 740x360 phone shell: the edited lane, the form and Done stay on screen, with and without the keyboard | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 767x375 phone shell (widest phone width): the edited lane, the form and Done stay on screen, with and without the keyboard | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 568x320 phone shell: the edited lane, the form and Done stay on screen, with and without the keyboard | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 914x331 with marker rows: the edited lane, the form and Done stay on screen, with and without the keyboard | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 932x430 with marker rows: the edited lane, the form and Done stay on screen, with and without the keyboard | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 844x390 with marker rows: the edited lane, the form and Done stay on screen, with and without the keyboard | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| rotating a phone to 932x430 with the form open leaves the edited lane fully visible | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| rotating a phone to 844x390 with the form open leaves the edited lane fully visible | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 1194x834 iPad landscape keeps the regular envelope form and its visible help | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 568x320 phone landscape shows the dense one-row envelope form without the help copy | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 932x430 phone landscape keeps the regular stacked form and its help, in the Inspector column (#1696) | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 914x331 idle: a touch tap on the guest track header opens its details and reaches Add volume envelope | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 667x375 phone shell idle: the marker rows scroll with the lanes | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 667x500 phone shell idle: the marker rows stay pinned under the ruler | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 914x331 idle: the marker rows scroll with the lanes | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 932x430 idle: the marker rows stay pinned under the ruler | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 1194x834 idle: the marker rows stay pinned under the ruler | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 1024x768 idle: the marker rows stay pinned under the ruler | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 914x331 with the envelope sheet open: the status line, its live region and the save state stay | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 914x331 with a failed save and the envelope sheet open: the status line keeps the save state and the sheet rests on it | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| a soloed track keeps Clear solo tappable at the top of the timeline at 914x331 while the envelope sheet is open | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| a clip's Inspector is a column beside a whole timeline, and Close returns the shell | `gui/web/e2e-compat/inspector-column.spec.ts` | CSS / layout | Pass | Pass | Not run |
| an envelope point's lane stays whole and uncovered beside the column | `gui/web/e2e-compat/inspector-column.spec.ts` | CSS / layout | Pass | Pass | Not run |
| a pending edit's Approve and Reject float beside the column, not under it | `gui/web/e2e-compat/inspector-column.spec.ts` | CSS / layout | Pass | Pass | Not run |
| with the keyboard up the column shortens to the visible viewport and keeps its header | `gui/web/e2e-compat/inspector-column.spec.ts` | CSS / layout | Pass | Pass | Not run |
| with iOS's shrunk layout height the column is exactly the visible band, not the keyboard twice | `gui/web/e2e-compat/inspector-column.spec.ts` | CSS / layout | Pass | Pass | Not run |
| with Safari's chrome collapsed the column stops above the status strip, not over the focused field | `gui/web/e2e-compat/inspector-column.spec.ts` | CSS / layout | Pass | Pass | Not run |
| turning upright keeps an unsaved draft and its focus in the Inspector | `gui/web/e2e-compat/inspector-column.spec.ts` | CSS / layout | Pass | Pass | Not run |
| the Inspector stays a bottom sheet | `gui/web/e2e-compat/inspector-column.spec.ts` | CSS / layout | Pass | Pass | Not run |
| rotating a phone from portrait to landscape moves the open Inspector into a column and back | `gui/web/e2e-compat/inspector-column.spec.ts` | CSS / layout | Pass | Pass | Not run |
| phone shells keep every control a finger can use at 360, 390 and 767 wide | `gui/web/e2e-compat/reachability-sweep.spec.ts` | CSS / layout | Pass | Pass | Not run |
| tablet and desktop shells keep every control a finger can use across 768 to 1195 wide | `gui/web/e2e-compat/reachability-sweep.spec.ts` | CSS / layout | Pass | Pass | Not run |
| loaded tablet playback stays inline at 200% text | `gui/web/e2e-compat/reachability-sweep.spec.ts` | CSS / layout | Pass | Pass | Not run |
| a phone held sideways and an iPad keep every control a finger can use | `gui/web/e2e-compat/reachability-sweep.spec.ts` | CSS / layout | Pass | Pass | Not run |
| a track with an envelope and an effect chain keeps every control a finger can use | `gui/web/e2e-compat/reachability-sweep.spec.ts` | CSS / layout | Pass | Pass | Not run |
| pending-edit and transcript-word sheet bodies keep every control reachable | `gui/web/e2e-compat/reachability-sweep.spec.ts` | CSS / layout | Pass | Pass | Not run |
| Pipeline native targets stay clear in the original short panel | `gui/web/e2e-compat/pipeline-toolbar-fit.spec.ts` | CSS / layout | Pass | Pass | Not run |
| Pipeline retains a scrolled focused control across viewport resizes | `gui/web/e2e-compat/pipeline-toolbar-fit.spec.ts` | CSS / layout | Pass | Pass | Not run |
| Pipeline keeps an oversized native control targetable | `gui/web/e2e-compat/pipeline-toolbar-fit.spec.ts` | CSS / layout | Pass | Pass | Not run |
| Pipeline native flow keeps phone and coarse-pointer targets usable | `gui/web/e2e-compat/pipeline-toolbar-fit.spec.ts` | CSS / layout | Pass | Pass | Not run |
| the phone sheet lays its related and more zones out like the inspector above them | `gui/web/e2e-compat/selection-sheet-zones.spec.ts` | CSS / layout | Pass | Pass | Not run |
| the tablet sheet lays its related and more zones out like the inspector above them | `gui/web/e2e-compat/selection-sheet-zones.spec.ts` | CSS / layout | Pass | Pass | Not run |
| agent range controls stay reachable from a tablet clip sheet | `gui/web/e2e-compat/selection-agent-range-reachability.spec.ts` | CSS / layout | Pass | Pass | Not run |
| a zero-start agent range arriving at the short-tablet column stays reachable | `gui/web/e2e-compat/selection-agent-range-reachability.spec.ts` | CSS / layout | Pass | Pass | Not run |
| a tablet track sheet owns the agent range controls | `gui/web/e2e-compat/selection-agent-range-reachability.spec.ts` | CSS / layout | Pass | Pass | Not run |
| agent range arrival and removal keep the short-tablet column reachable | `gui/web/e2e-compat/selection-agent-range-reachability.spec.ts` | CSS / layout | Pass | Pass | Not run |
| Reject all asks with the count, then one Undo brings the pending edits back | `gui/web/e2e-compat/phone-chrome.spec.ts` | CSS / layout | Pass | Pass | Not run |
| a long press then a drag selects a word range, and the sheet clears it | `gui/web/e2e-compat/transcript-touch-range.spec.ts` | CSS / layout | Pass | Pass | Not run |
| a finger that moves before the hold scrolls and selects nothing | `gui/web/e2e-compat/transcript-touch-range.spec.ts` | CSS / layout | Pass | Pass | Not run |
| the open editor menu draws over the Text panel's Ignore button | `gui/web/e2e-compat/phone-menu-layering.spec.ts` | CSS / layout | Pass | Pass | Not run |
| the phone timeline shows Undo and Redo; a Safari tab offers the Home Screen once | `gui/web/e2e-compat/phone-chrome.spec.ts` | CSS / layout | Pass | Pass | Not run |
| native Tab keeps every Primary navigation indicator inside its clip | `gui/web/e2e-compat/phone-navigation-focus.spec.ts` | CSS / layout | Pass | Pass | Not run |
| Track actions opens inside a 390 and a 393 wide phone viewport in both detents and its first item works | `gui/web/e2e-compat/menu-viewport.spec.ts` | CSS / layout | Pass | Pass | Not run |
| an app toast stays topmost and tappable over a transport menu opened after it | `gui/web/e2e-compat/menu-viewport.spec.ts` | CSS / layout | Pass | Pass | Not run |
| an app toast stays topmost and tappable over a transport menu that was open before it | `gui/web/e2e-compat/menu-viewport.spec.ts` | CSS / layout | Pass | Pass | Not run |
| focused feedback Undo survives a phone turning sideways | `gui/web/e2e-compat/compact-feedback-focus.spec.ts` | CSS / layout | Pass | Pass | Not run |
| focused feedback Dismiss survives a phone turning sideways | `gui/web/e2e-compat/compact-feedback-focus.spec.ts` | CSS / layout | Pass | Pass | Not run |
| focused feedback Undo stays in the column or its toast when a phone turns to 844x390 | `gui/web/e2e-compat/compact-feedback-focus.spec.ts` | CSS / layout | Pass | Pass | Not run |
| focused feedback Dismiss stays in the column or its toast when a phone turns to 844x390 | `gui/web/e2e-compat/compact-feedback-focus.spec.ts` | CSS / layout | Pass | Pass | Not run |
| an agent's selection and a peer's edit that remove the focused Undo hand focus to the sheet Close | `gui/web/e2e-compat/compact-feedback-focus.spec.ts` | CSS / layout | Pass | Pass | Not run |
| feedback preserves selected half and full geometry and permitted ruler and lane room | `gui/web/e2e-compat/compact-feedback-detents.spec.ts` | CSS / layout | Pass | Pass | Not run |
| clipped removal feedback keeps remaining lifetime after closing the compact host | `gui/web/e2e-compat/compact-feedback-host-lifetime.spec.ts` | CSS / layout | Pass | Pass | Not run |
| unavailable history feedback stays above a real inspector refusal | `gui/web/e2e-compat/compact-history-hint.spec.ts` | CSS / layout | Pass | Pass | Not run |
| every native compact Tab target paints its focus indicator inside actual clips | `gui/web/e2e-compat/compact-painted-focus.spec.ts` | CSS / layout | Pass | Pass | Not run |
| scrolled fades and pinned actions retain pointer and keyboard ownership | `gui/web/e2e-compat/compact-form-scroll.spec.ts` | CSS / layout | Pass | Pass | Not run |
| native traversal skips covered tools and Close restores them | `gui/web/e2e-compat/compact-form-scroll.spec.ts` | CSS / layout | Pass | Pass | Not run |
| one finger moving never edits; a long-press arms, and the armed point drags in time and level | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| at 390x844 by default, one finger dragging a selected clip's trim end saves nothing and opens the strip, not the half sheet | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| an armed drag holds at a soft boundary, and saves there | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| a long-press arms a clip, which moves in time only, holds at its neighbour's edge and saves there | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| a second finger cancels an armed clip move | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| a long-press on empty space opens the create menu; Add envelope point adds one there | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| a long-press past the last clip opens the create menu and selects no text | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| in a short viewport the create menu stays in view off the finger, and lifting without moving saves nothing | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| tablet landscape at 200% text still lets Zoom hit the ruler | `gui/web/e2e-compat/touch-grammar.spec.ts` | CSS / layout | Pass | Pass | Not run |
| the create menu reaches every item and stays off the finger at every text size and screen height | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| a create menu taller than 90% of the screen, with room beside the finger, is not cut to 90% | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| the strip follows the finger; a flick opens or closes it fully, a slow drag lands at the nearest detent | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| a second finger cancels an armed drag and the create menu | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| the crossfade grip drags only once a long press arms it | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| #1135: a long-press at a join offers the ripple trim, which shows where later clips go | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| #1154: a touch ripple trim over the guest's speech applies as one manual trim | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| #1135: a plain mouse grab at a join rolls it, as on main | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| Compact history stays reachable through unavailable Redo and saved Undo and Redo | `gui/web/e2e-compat/compact-history-persistence.spec.ts` | CSS / layout | Pass | Pass | Not run |
| guarded feedback actions retain their saved edit and touch targets | `gui/web/e2e-compat/compact-feedback-lifetime.spec.ts` | CSS / layout | Pass | Pass | Not run |
| clipped saved feedback pauses its remaining visible lifetime | `gui/web/e2e-compat/compact-feedback-lifetime.spec.ts` | CSS / layout | Pass | Pass | Not run |
| compact header queues Undo behind a pending save | `gui/web/e2e-compat/compact-save-refusal.spec.ts` | Core flow | Pass | Pass | Not run |
| the Cut button of the blade confirmation can be tapped at 16px text: portrait | `gui/web/e2e-compat/touch-chrome-reach.spec.ts` | CSS / layout | Pass | Pass | Not run |
| the Cut button of the blade confirmation can be tapped at 32px text: portrait | `gui/web/e2e-compat/touch-chrome-reach.spec.ts` | CSS / layout | Pass | Pass | Not run |
| the Cut button of the blade confirmation can be tapped at 16px text: landscape | `gui/web/e2e-compat/touch-chrome-reach.spec.ts` | CSS / layout | Pass | Pass | Not run |
| the Cut button of the blade confirmation can be tapped at 32px text: landscape | `gui/web/e2e-compat/touch-chrome-reach.spec.ts` | CSS / layout | Pass | Pass | Not run |
| a held nudge repeats, saves once, and one Undo restores it | `gui/web/e2e-compat/touch-nudge.spec.ts` | Core flow | Pass | Pass | Not run |
| a held nudge stops at a soft boundary with a cue; a fresh press goes past | `gui/web/e2e-compat/touch-nudge.spec.ts` | Core flow | Pass | Pass | Not run |
| pending and envelope strips: nudge rows and targets (portrait-360) | `gui/web/e2e-compat/touch-nudge.spec.ts` | Core flow | Pass | Pass | Not run |
| iPhone envelope Time field is at least 16px | `gui/web/e2e-compat/touch-field-size.spec.ts` | CSS / layout | Pass | Pass | Not run |
| iPhone comment field is at least 16px | `gui/web/e2e-compat/touch-field-size.spec.ts` | CSS / layout | Pass | Pass | Not run |
| pending and envelope strips: nudge rows and targets (landscape-636) | `gui/web/e2e-compat/touch-nudge.spec.ts` | Core flow | Pass | Pass | Not run |
| chip: slid on, settled, slid along the axis | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |
| chip: lifted at the origin, chip pressed again, slid along the axis | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |
| chip: slid on and lifted without moving | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |
| chip: rested a long press, then dragged off the axis (fallback) | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |
| no grab while passing over chips or moving off the axis | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |
| the strip and the expanded inspector leave the selection in view | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |
| a drag stows the strip, which returns with the new value: portrait-360 | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |
| a drag stows the strip, which returns with the new value: landscape-636 | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |
| Expand is remembered for the next selection, and so is Collapse: portrait-360 | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |
| Expand is remembered for the next selection, and so is Collapse: landscape-636 | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |
| both themes and reduced motion with the strip open | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |
| a second finger cancels the drag and pinches (portrait-360) | `gui/web/e2e-compat/touch-pinch.spec.ts` | Core flow | Pass | Pass | Not run |
| a second finger cancels the drag and pinches (landscape-844) | `gui/web/e2e-compat/touch-pinch.spec.ts` | Core flow | Pass | Pass | Not run |
| timeline text takes no selection or callout | `gui/web/e2e-compat/touch-selection.spec.ts` | CSS / layout | Pass | Pass | Not run |
| no shell row draws over the strip, nor the strip over it: portrait-360 | `gui/web/e2e-compat/touch-strip-stacking.spec.ts` | CSS / layout | Pass | Pass | Not run |
| no shell row draws over the strip, nor the strip over it: landscape-636 | `gui/web/e2e-compat/touch-strip-stacking.spec.ts` | CSS / layout | Pass | Pass | Not run |
| a pending edit's Approve and Reject stay reachable in pinned chrome at enlarged text sizes | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |
| live waiver draft survives a short to tall tablet resize | `gui/web/e2e-compat/pending-actionbar-lifecycle.spec.ts` | Core flow | Pass | Pass | Not run |
| docks in the inspector sheet | `gui/web/e2e-compat/pending-actionbar-ruler.spec.ts` | CSS / layout | Pass | Pass | Not run |
| floats between the ruler and the bottom panel | `gui/web/e2e-compat/pending-actionbar-ruler.spec.ts` | CSS / layout | Pass | Pass | Not run |
| leaves Approve and Reject to the inspector | `gui/web/e2e-compat/pending-actionbar-ruler.spec.ts` | CSS / layout | Pass | Pass | Not run |
| pending card: a marker lane that grows while it floats moves the card clear of the lane | `gui/web/e2e-compat/pending-actionbar-reflow.spec.ts` | CSS / layout | Pass | Pass | Not run |
| pending card: a bottom panel that grows while it floats moves the card clear of the panel | `gui/web/e2e-compat/pending-actionbar-reflow.spec.ts` | CSS / layout | Pass | Pass | Not run |
| pending review: the inspector's inline Approve and Reject stay reachable after approving at 720 and shrinking to 360 | `gui/web/e2e-compat/pending-actionbar-reflow.spec.ts` | CSS / layout | Pass | Pass | Not run |
| Expand keeps the header, Collapse and Close usable at 636x390 with a 16 px root font | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |
| Expand keeps the header, Collapse and Close usable at 636x390 with a 32 px root font | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |
| the half drawer keeps a readable title at 390x844 with a 16 px root font | `gui/web/e2e-compat/touch-peek.spec.ts` | CSS / layout | Pass | Pass | Not run |
| the half drawer keeps a readable title at 390x844 with a 32 px root font | `gui/web/e2e-compat/touch-peek.spec.ts` | CSS / layout | Pass | Pass | Not run |
| a timeline tap while a track's sheet is open goes to the strip: portrait-390 | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |
| a point saved from a track's envelope form stays in that sheet: portrait-390 | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |
| Tab focus never lands a field under the drawer header at 32 px text: a pending cut | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |
| the strip leaves the timeline undimmed and the half sheet dims it: portrait-390 | `gui/web/e2e-compat/touch-peek.spec.ts` | Core flow | Pass | Pass | Not run |
| phone: a boundary load the server never answers says to try again and recovers on Try again | `gui/web/e2e-compat/precision-boundary-timeout.spec.ts` | Core flow | Pass | Pass | Not run |
| desktop: a boundary load the server never answers says to try again and recovers on Try again | `gui/web/e2e-compat/precision-boundary-timeout.spec.ts` | Core flow | Pass | Pass | Not run |
| desktop: network boundary load keeps focus through recovery | `gui/web/e2e-compat/precision-boundary-timeout.spec.ts` | Core flow | Pass | Pass | Not run |
| desktop: stale boundary load keeps focus through recovery | `gui/web/e2e-compat/precision-boundary-timeout.spec.ts` | Core flow | Pass | Pass | Not run |
| Auto drags directly when a step is 4 px wide at a deep zoom | `gui/web/e2e-compat/precision-drag.spec.ts` | Core flow | Pass | Pass | Not run |
| jog: a ripple over the guest's speech applies as one manual trim | `gui/web/e2e-compat/precision-drag.spec.ts` | Core flow | Pass | Pass | Not run |
| jog: a second finger cancels the drag and saves nothing | `gui/web/e2e-compat/precision-drag.spec.ts` | Core flow | Pass | Pass | Not run |
| jog: moves a trim end exactly one 10 ms step and saves it | `gui/web/e2e-compat/precision-drag.spec.ts` | Core flow | Pass | Pass | Not run |
| jog: a tap outside the pad finishes and saves | `gui/web/e2e-compat/precision-drag.spec.ts` | Core flow | Pass | Pass | Not run |
| a document state load the server never answers shows a banner whose retry recovers | `gui/web/e2e-compat/initial-load-recovery.spec.ts` | Core flow | Pass | Pass | Not run |
| the banner sits in view, not under the fixed shell, and its retry recovers | `gui/web/e2e-compat/initial-load-recovery.spec.ts` | Core flow | Pass | Pass | Not run |

Two compat Chromium specs have exact main Chromium owners:

| Omitted compat spec | Retained main spec and helper | Exact shared profile |
| --- | --- | --- |
| `comment-undo.spec.ts` | `gui/web/e2e/comment-undo.spec.ts`, `exerciseCommentUndo` | 360x800, dark, default motion |
| `transcript-wordbar.spec.ts` | `gui/web/e2e/transcript-wordbar.spec.ts`, `checkWordbarOutsideRelease` | inherited Desktop Chrome viewport, default theme and motion |

Envelope recovery, touch affordances, and phone Mix keep both engines. Their
compat profiles or combined focus scenarios have no exact existing main owner.

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
  [Follow-up](../ROADMAP.md#after-the-beta).
- Mobile browsers on physical devices (#301). The phone row uses an emulated
  `iPhone 13` profile.
- Live ASR and filler detection, which run server-side (`make e2e-slow`,
  `tests/test_tighten.py`).

`tests/test_browser_acceptance_matrix.py` guards this table (shared parsing in
`tests/markdown_table.py`). It derives the rows from
`gui/web/e2e-compat/*.spec.ts` and each engine cell from
`playwright.compat.config.ts`: a project for that engine that does not
`testIgnore` the spec means "Pass". Its closed two-entry main ownership map
rejects every other Chromium exclusion, all WebKit exclusions, unknown and
duplicate ignores, and drift in the retained main helper/profile evidence.
`StudioAxeOwnership` in `e2e/studioAxeOwnership.ts` keeps main and WebKit scans.
Shared helpers require an explicit owner. Owned touch scans retain collected
results until their original assertion points, after geometry and action evidence.
`e2e/mainAxeProfiles.test.ts` imports both actual configs and rejects inherited
viewport, color scheme, or reduced-motion drift in either Chromium profile.
Behavioral Vitest checks preserve main/reading scan execution and fail on
injected violations. Live WebKit checks still qualify the actual scan states. The guard also fails if a compat spec uses
`test.skip`, `fixme`, `fail` or `only`, or if the compat config's `retries` is
not `process.env.CI ? 1 : 0`. It also fails if the `main` / nightly plan stops
running the complete main shard set or either complete compat engine, or stops
installing an engine with a Pass cell. It fails if the PR plan's WebKit shards
stop covering the whole WebKit project, if the `frontend-e2e` aggregate can pass
without the plan succeeding or with a suite the plan ordered skipped, failed or
cancelled, or if one of #30's areas (Audio
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

`e2e-compat/pipeline-toolbar-fit.spec.ts` checks eight independent cases per
engine. The cases cover Pipeline controls in the original short panel at 16px
and 32px text, focused-control and scroll-anchor retention at both text sizes,
an oversized native control, and phone/coarse-pointer flows at two phone text
sizes and a short iPad landscape viewport. Each case uses its own disposable
project. These are bundled Chromium and Playwright WebKit checks, not physical
Safari or Firefox coverage.

The `frontend-e2e-suites` compatibility job runs the focused
`gui/web/e2e-compat/` matrix (`playwright.compat.config.ts`) in bundled Chromium
and Playwright WebKit, concurrently with the sharded main Chromium suite on
separate runners. Pull requests run the WebKit half only, in two shards. The
required `frontend-e2e` check gates every shard and compat job the plan ran. It covers
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
Play). A host Bounce dialog passes full-page axe on WebKit (`expectPageAxeClean`) and
writes one non-silent WAV under `export/bounces/` — its own result copy goes
through `runAnnouncedJob` (`expectJobResult` → `announceJobResult`), and
`useJobStatusAnnouncement` speaks it in place of the generic Activity "ok"
headline instead of racing it (a real bug, not WebKit-only; `BounceDialog.tsx`
and `export.deliverables` in `commands/host.ts` share the fix, and it covers
the phone shell too). The stages run serially in one test
because export bounces the landed track, so a stage that fails on both attempts
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

The compat config pins `workers: 1` / `fullyParallel: false` (one shared web
server and live project fixture), retries once in CI like the main suite, and writes to
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

Playwright traces and JSON reports from these runs can contain guest
record-share tokens (`/rec/<token>` URLs and `/api/shares/record` responses).
CI uploads timing reports on every run and uploads only native `trace.zip` and
`error-context.md` files when they exist. Keep the seven-day retention and
treat these artifacts as sensitive. Do not widen the upload to all of
`gui/web/test-results/` or add other capture files without a sanitization plan.

The path-filtered `.github/workflows/deploy-config.yml` validates `deploy/` with real `caddy` and `docker compose` (see [§ Deploy config validation](testing.md#deploy-config-validation)).

The centrally selected `.github/workflows/desktop.yml` also builds the web distribution,
runs the portable desktop scaffold checks on Linux, and runs `cargo check` for the
Windows desktop binary. The Windows job logs
`cargo tree --locked -d --target x86_64-pc-windows-msvc --features app`
so reviewers can check for duplicate `windows` and `windows-result` versions.
The Windows job compiles WebView2-only adapters that macOS
and Linux cannot typecheck; installer creation remains in the reusable release
workflow. A `pinned-media-windows` job runs `tests/test_pinned_media.py` on `windows-latest` with Python 3.11 and 3.12 so the Windows fallback of pinned media reads is tested on NTFS at the `requires-python` floor and the sidecar's version, not only simulated. A `project-commit-lock-windows` job runs `tests/test_project_commit_lock.py`, `tests/test_history.py`, and `tests/test_review_versions.py` on `windows-latest` with Python 3.12 (acquiring the catalog-pinned prebuilt FFmpeg pair first, since `tests/conftest.py::sample_wav` skips without it) so the cross-process commit lock and every review-publication test that does not stage media runs on real Windows; `requires_safe_cleanup` / `requires_safe_failed_cleanup` (`tests/review_platform.py`) skip the staging/quarantine paths that publication does not support there (see `docs/persistence.md`'s Inventory row for review publication).

Native PR selection uses the seven families documented in
[Native workload selection](testing.md#native-workload-selection). Desktop and
registry workflows run fully on main, nightly, and manual events. Cargo checks
use the checked-in desktop splash and run independently of the web artifact.
The Windows cargo check stages its sidecar stub without downloading web output.
Linux and Windows CI must qualify that dependency removal on the changed head.

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

## Native workload selection

`scripts/ci_native.py` owns the native dependency rules, exact contract consumers,
and workload inventory. `ci_plan.py` emits seven positive skip proofs for web,
cargo, pinned media, resolver, project lock, payload, and registry. Both native
workflows read those proofs through `.github/actions/ci-plan`. Only successful
planning with the digit string `1` skips work. Other values run work.
Digit strings avoid GitHub's case-insensitive string equality. Failed, skipped, missing, or malformed
planning runs ordinary workloads unless the workflow is cancelled. The newer
Linux host also requires successful payload production.

PR rules union all matching consumers. Unknown paths and unknown contracts run
all families. Empty, unreadable, or malformed diffs also run all families. Git
uses NUL-delimited paths and disables rename detection so deletions and both
rename directions remain visible. A filename containing a newline stays one
path and requests full native coverage.

Desktop PR event paths are exactly `['**', '!contracts/test-wait-allowlist.json']`.
An allowlist-only PR starts no desktop workflow jobs. Other docs PRs start cheap
planners but no expensive native jobs. Registry PR events remain broad. Neither
workflow excludes broad docs patterns at the event boundary. Every main push,
nightly, and manual dispatch runs all native workloads. Proven release-only PRs
skip all native families.

Six Python contracts plus the FFmpeg artifact catalog are native inputs.
`tests/test_native_ci_plan.py` checks contract inventory, literal readers, the
dynamic bootstrap manifest, generated TypeScript provenance, the payload's local
Python import closure including package initializers, job identities, output
forwarding, actual YAML predicates, and prerequisite outcomes. Unresolved or
dynamic payload imports require explicit classification. Classify
new contracts explicitly before narrowing their conservative fallback.

These are projected matrix executions from YAML, excluding the two cheap PR
planners. They are not measured savings.

| PR paths | Desktop executions | Registry executions |
|---|---|---|
| Docs | 0 | 0 |
| `gui/web/src/App.tsx` | 1 | 0 |
| `src/podcast_mcp/edits/tighten/propose.py` | 4 | 1 |
| `contracts/test-wait-allowlist.json` | 0 | 0 |
| `contracts/ffmpeg-artifacts.json` | 6 | 1 |
| Full event | 12 | 1 |

Generic algorithm-only zero-native acceptance remains partial. Autouse fixtures
import backend algorithms even in focused native tests. All native Python
families retain broad source, tests, defaults, dependency, installer, and storage
coverage. Narrower selection needs a proved fixture boundary without removing
tests or protections.

## Release refreshes and final validation

The shared `.github/actions/ci-plan` supplies the PR source ref, both repository
identities, base ref, and exact diff SHAs to `scripts/ci_plan.py`. The release
shortcut requires the same-repository release-please branch for main and exactly
ten modified regular files. The classifier compares immutable merge-base and
head blobs. Only the known version literals and changelog can change. Dependency,
hash, code, formatting, file-mode, malformed-data, and ambiguous-identity changes
receive the full plan. The version fields must agree, increase, and remain plain
canonical `0.x` versions. The existing locked installation and 1.0 policy still
run; neither the lockfile nor its consistency check is bypassed.

A proven refresh skips the advisory Python-floor job and the expensive desktop,
extras-import, and registry Windows workloads. Each advisory workflow has a cheap
PR selector. Missing or failed advisory planning requests ordinary work; workflow
cancellation stops it. Main, scheduled, manual, and reusable wheel validation keep
their existing full work. The reusable wheel workflow stays outside this shortcut.
The four required checks still report. Frontend aggregates accept only their
existing successful-plan and planned-workload combinations, and the full-history
secret scan runs on every PR.

Lightweight green checks are not permission to cut a release. Before merging a
release PR, the independent Shipping verifier must retain a full validation
receipt for release head H atop current main B:

1. Resolve H and B. Update the release branch only if needed so B is an ancestor
   of H, then keep H stable during validation.
2. Dispatch `test.yml` on the release ref with `compatibility-base=B`. The pytest
   job checks that its checkout is H, B is the current remote main tip, and B is
   an ancestor of H. It records the checkout and compatibility base. Dispatch
   always requests full pytest with the 95% floor and both browser engines.
3. Dispatch `desktop.yml`, `extras-import.yml`, `registry-backup-windows.yml`,
   `release-wheel.yml`, and `secret-scan.yml` on that same release ref. Retain
   successful full workloads, not skipped required work or partial reruns.
4. Record repository, PR, H, B, every workflow run ID and attempt, event, actual
   run/checkout SHA, full scope, and terminal job results. Context names alone
   cannot distinguish a lightweight PR run from full dispatch validation.
5. Immediately before the separately authorized merge, re-read H and current B.
   Either moving invalidates the receipt. Also require the four exact-head PR
   checks, the independent Shipping verdict, and all existing owner gates.

A full main run after release merge is insufficient because release-please can
create the tag before that parallel run finishes. The receipt is a contributor
procedure, not a new server-enforced merge hold or an atomic base lock. Existing
repository settings are unchanged. Additional required contexts, strict settings,
or a merge queue require an owner decision. Do not arm auto-merge before the
full release receipt is valid.

## SQLite registry failure diagnostics

For a concurrent registry initialization failure, inspect the first child-process
traceback before the parent's queue timeout. A terminal `retry_transient` failure
adds a note to the original SQLite `OperationalError` with `sqlite_errorcode`,
`sqlite_errorname`, `sqlite_version`, `attempts`, `elapsed_sec`, and
`terminal_reason`. `not_transient` means the existing classifier rejected that
attempt; `deadline` means a qualifying error reached the retry deadline.
The code and name describe the terminal attempt and are `None` when unavailable.
Elapsed time includes the work in each attempt and the retry sleeps, so a SQLite
busy wait can carry it past the deadline. The note records no database path,
SQL, or secret values. A passing native run proves non-reproduction in that run;
it does not establish the cause of an earlier Windows failure.
