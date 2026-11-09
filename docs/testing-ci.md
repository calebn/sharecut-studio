# CI jobs and browser acceptance

What each CI job runs, which jobs a run needs, and the browser acceptance matrix. [testing.md](testing.md) keeps the test commands, quality tooling and coverage policy.

## Superseded PRs and develop bursts

The test, desktop, Storybook, extras-import, secret-scan,
registry-backup-windows, and relay-ci workflows cancel a superseded first-attempt
PR run in the same workflow and PR group. A rerun gets its own group so rerunning
an older head cannot cancel the latest head's checks.

First-attempt pushes to `main` share one group per workflow and pushes to `develop` another (`<workflow>-main`, `<workflow>-develop`); neither cancels the running run.
Storybook is the exception: it coalesces pushes to `main`, the only branch it deploys from.
GitHub keeps at most one running and one pending run in each group, replacing an
older pending run when another arrives. A burst can therefore discard intermediate runs. The last run to enter the
pending slot is retained, which can be an older commit because GitHub does not
guarantee dispatch ordering. Coalescing does not guarantee validation of the
current `develop` tip. Before merging,
verify the exact PR head and its integration with current `develop` as usual.

If a coalesced `develop` run fails, inspect or bisect the commits since the previous
successful run. Pushes to `develop` run only lint, types, compat checks and
Vitest/build; the promotion dispatch keeps the coverage floor and both
browser engines. A failed promotion opens a `nightly-failure` issue. GitHub disables
scheduled workflows after 60 days without repository activity, which would
silence the promotion and its alert.
Dispatched runs, including the ones promotion starts on its `promote/*` branches, have unique groups, so pushes cannot cancel
them or replace their pending runs. Grouping changes scheduling, not which
checks an event plans.

## Promotion

`.github/workflows/promote.yml` is the only nightly schedule (`23 7 * * *`) that gates a branch. It runs the full CI on the `develop` tip and fast-forwards `main`. `test.yml`, `desktop.yml` and `registry-backup-windows.yml` have no `schedule` and no alert job of their own. `secret-scan.yml` and `extras-import.yml` keep their weekly drift runs.

Lane PRs merge into `develop` after the fast, path-filtered checks. Each night `scripts/promote.py run` freezes the `develop` tip S and the `main` tip M, then:

1. Stops with "merge main into develop" when M is not an ancestor of S, and only redispatches Storybook when S equals M.
2. Pushes the temporary branch `promote/<S12>-<epoch>-<run_id>-<attempt>` at S, where `<epoch>` is the creation time in seconds.
3. Dispatches `test.yml` (with `compatibility-base=M` and `compatibility-base-ref=refs/heads/<target>`), `secret-scan.yml`, `desktop.yml`, `registry-backup-windows.yml` and `storybook.yml` (the build and the story sweep; its deploy job runs only on `main`) on that branch, then polls each run by branch, `head_sha=S` and `workflow_dispatch`.
4. Counts a missing, cancelled, timed-out or skipped run as red, and requires each of `pytest`, `frontend`, `frontend-e2e` and `gitleaks-history` (`config/branches.json` `required_jobs`) to have succeeded. A timeout cancels the runs still going.
5. Re-checks that `main` is still M, then runs a plain `git push origin S:refs/heads/main`. It never forces, so the push fails unless it is a fast-forward.
6. Dispatches `storybook.yml` on `main` to deploy the catalog, because a `GITHUB_TOKEN` push triggers no workflow. A failure there alerts and never rolls `main` back.

The `always()` cleanup step deletes this run's branch and every `promote/*` branch whose name carries an epoch more than a day old (the branch's creation time, not its commit date, so a quiet `develop` never loses a live branch). A rerun picks S again and redispatches everything. The alert job opens or updates the `nightly-failure` issue on a red run and closes it on a green one. Dry runs never alert, and dry runs and non-`main` targets use a separate concurrency group so they cannot cancel the pending nightly. The job runs only from `main`.

**Dry run.** Dispatch `promote` with `dry-run` set, or run `python scripts/promote.py run --no-push`. Everything through polling runs for real. With the PAT set and a workflow-touching range, the temporary-branch push is also real and uses the PAT. The script then prints the push and the Storybook dispatch it would make and exits on the verdict. `--target` must be the release branch or start with `promote-canary`; anything else is refused. Dispatching with `target=promote-canary` rehearses the push against a throwaway branch; the `main` ruleset does not cover that branch, so it proves the mechanics, not the ruleset.

**Cutover.** `config/branches.json` `base` is `develop`. Caleb skipped the canary at the cutover; the fallback is a manual push of the verified commit to `main`. [Contributing § Cutover record](contributing.md#cutover-record) has the state. Setting `base` equal to `release` turns `promote.py run` back into a nightly on the `main` tip that pushes nothing.

**Push credential.** `GITHUB_TOKEN` cannot push a change to `.github/workflows/*`. When the fast-forward range touches those files, `promote.py` makes both the temporary-branch push and the final push to `main` with the repository secret `PROMOTE_TOKEN`, else `RELEASE_PLEASE_TOKEN` (a PAT with contents and workflows write). No other push or API call uses it, and a range with no workflow change keeps `GITHUB_TOKEN`, which triggers no `push: main` workflows. A PAT push does trigger them, once, on those nights. With no bypass actors the PAT is an ordinary pusher: the ruleset still requires the four checks to have passed on the pushed SHA.

**PRs to other branches.** Workflows that filter `pull_request` to `develop` and `main` (`test.yml`, `registry-backup-windows.yml`) run no CI for a PR whose base is any other branch.

**Known limits.**

- Promotion runs S's own workflow files, so whoever can land a workflow change on `develop` can weaken the gate. Accepted: it is the same trust as merging to `develop`, and the gate is a CI check, not an access control.
- `promote.yml`'s promote job runs only from `main`, so dispatching it needs write access and a run on `main`; a branch copy of the workflow cannot push to `main` past the ruleset, because it has no bypass either.
- `deploy-config`, `release-wheel`, `extras-import` and `relay-ci` neither gate promotion nor run on the promoted `main`.
- A `GITHUB_TOKEN` push cannot create or update `.github/workflows/*`, and a ruleset bypass does not lift that. The canary that would have tested this was skipped, so `promote.py` uses the PAT for both the temporary-branch push and the final push when the range touches workflows, and `GITHUB_TOKEN` alone would be refused. Until the first promotion carrying this change lands, `main`'s copy of `promote.yml` and `promote.py` runs without PAT support. A rejected PAT push is reported by branch name and fails the run; with neither secret set, or a PAT without the workflows scope, the fallback is a manual push of the verified commit to `main` with Caleb's own credentials; a `develop` to `main` PR would rewrite SHAs and leave `main` ahead of `develop`.
- `release-please.yml` refuses to run while the last manifest-touching commit on `develop` is not an ancestor of `main`. `main`'s copy of the workflow has no such guard until the first promotion carrying this change lands.
- `GITHUB_TOKEN` pushes trigger no `push: main` workflows. Never add a `push: main` trigger expecting it to fire after a promotion; `promote.py` dispatches Storybook explicitly.
- Main-ahead cases that cannot be avoided (Dependabot security updates ignore `target-branch`) stop promotion at "merge main into develop". Neither ruleset has a bypass actor (GitHub rejects an Actions bypass on a personal repository), and `develop` accepts only rebase-merged PRs, so close or retarget such a PR before it merges. Release PRs are not such a case: release-please targets `develop`.

**Red `develop`.** A red promotion never skips a night. Rerun once, bisect, and revert the culprit PR on `develop` before fixing forward. The owning lane re-lands it afterwards.

**Hotfix.** A hotfix PR targets `develop` and runs the same checks. After it merges, dispatch `promote` by hand to promote it.

## CI

GitHub Actions workflow `.github/workflows/test.yml` runs Python, frontend and
a six-job browser matrix (plus the advisory `pytest-python-floor`) in parallel on
promotion dispatch and on `workflow_dispatch`; a push to `develop` runs only `pytest-quality`
and `frontend-suite` (the planner's `quick` scope). On pull requests the
`changes` job runs only the tests the diff reaches and a browser smoke job; promotion runs the rest (see
[§ Which jobs a run needs](testing.md#which-jobs-a-run-needs)). **All required checks must pass** (including Playwright axe) for a green build:

**Runner minutes.** On a full run the four `pytest-shard` jobs and `pytest-quality` each install the project, so a full run uses about five Python jobs at once against the Actions concurrency quota.

| Job | What |
|-----|------|
| `changes` | Not a required check. Runs `scripts/ci_plan.py plan` and hands `frontend-suite` and the browser matrix their plan; both required frontend aggregates fail when it does not succeed. |
| `pytest-quality` | Python 3.14. `ruff check` + `ruff format --check` + `bandit` + `vulture` + `deptry` + `mypy`, project compatibility, the docs-sync gate and Conventional Commit subjects. Runs once per run, beside the shards. |
| `pytest-shard` | Four matrix jobs on Python 3.14 with CTracer, each running its hash share of `pytest -n auto -m "not e2e_slow and not e2e_real"` with `--cov-fail-under=0` and uploading its coverage data (`tests/test_generated_artifacts.py` runs every generated-artifact and contract check, so one failing file names the stale output). On a PR that changes only `gui/web/`, only docs, or both, a single job runs only the test files that read those paths, without coverage. On any other PR a single job runs only the test files the diff reaches, without coverage, and the planner chooses the full suite when a changed file is named by no test. A strictly proven version-only release refresh runs the planner and version-policy tests without coverage; [final release validation](#release-refreshes-and-final-validation) still requires a full pre-merge receipt. |
| `pytest` | The required check. Needs `changes`, `pytest-quality` and `pytest-shard`, and fails unless the plan, quality and every planned shard succeeded (a `quick` plan, a push, accepts skipped shards). On full runs it combines the shard coverage and enforces the 95% floor. |
| `pytest-python-floor` | Advisory (not a required repository merge check): Python 3.11, the `requires-python` floor, runs `tests/test_wav_util.py` and `tests/test_bleed_gate_channels.py`, which pin the EXTENSIBLE-WAV reads that 3.11's stdlib `wave` rejects (#1183). The `pytest-shard` jobs use 3.14; a local 3.11 venv reproduces the gap. |
| `frontend-suite` → `frontend` | The workload runs in `gui/web`: `npm ci`, `npm audit --omit=dev --audit-level=high` (advisory, `continue-on-error`, failures noted in the job summary; see [§ Dependency updates and audit](testing.md#dependency-updates-and-audit)), `npm run lint` (oxlint + Stylelint tokens/rem/`@container`; `!important`/`@layer` consent-gated), `npm run format:check` (Biome), `npm run typecheck` (strict `tsc`), `npm test` (Vitest + `axe-core` via `expectNoA11yViolations`; all `.stories.ts` and `.stories.tsx` modules are discovered, rendered with Storybook preview annotations, played, and axe-checked including body portals by `gui/web/src/test/allStories.test.tsx`; keeper PCM/WAV/segment bars in `gui/web/src/record/keeper/`; mix-minus MM1–MM9 in `gui/web/src/audio/mixMinus.test.ts`; stories/Storybook/test helpers never imported by app code or root build configs in `gui/web/src/test/storyGovernance.test.ts`), `npm run build` (Vite module-ID guard rejects story/Storybook inputs in every app build) |
| `frontend-e2e-suites` → `frontend-e2e` | On dispatch, which promotion uses (the planner's `e2e` output; skipped on push to `develop`), six matrix jobs build ShareCut Studio and install only their declared browser engine with Playwright `--with-deps`: the four main-suite shards (`main-1of4` through `main-4of4`) use Chromium, `compat-chromium` uses Chromium, and `compat-webkit` uses WebKit. They run Playwright against a **temp copy** of `aligned_dialogue` (no committed waveform data: pyramids build on demand from fixture WAVs; the copy skips `artifacts/`, `history/`, `export/`, `_build/`, `.git`, and sync sqlite; see [§ Fixture hygiene](testing.md#fixture-hygiene)). Ordinary loopback Playwright launches leave `podcast gui` unpinned and provide each temporary `?project=` path. The main jobs run `npm run test:e2e -- --shard=i/4`; each deletes its live copy after Playwright terminates the web server. The main Chromium suite also runs `e2e/record-timeline-layering.spec.ts`, which checks recording and paused bands above an existing chapter marker at 1280px desktop and 360px and 390px phone widths in light and dark themes. Host→guest follow seeds a temp premix and needs `ffmpeg` on PATH. `e2e/host-tab-selection.spec.ts` opens two host tabs on one project: a click in one leaves the other's selection alone, and an agent-set selection reaches both. Presence follow also covers tab follow, chrome ghosts, lane-bottom no-jump, guest Pipeline/FX degrade, and the 360px phone guest Following pill (`e2e/presence-follow.spec.ts`). Full-page axe runs through `expectPageAxeClean` in `gui/web/e2e/axe.ts`. Each compatibility job runs the complete matrix for its named engine with one worker and one CI retry (see [§ Browser compatibility matrix](#browser-compatibility-matrix)). A pull request with a GUI-facing change runs one `main-smoke` job (the `SMOKE_SPECS` in `scripts/ci_plan.py`); a release-please pull request runs the four main shards and `compat-webkit-1of3` through `compat-webkit-3of3`. Failed-spec traces upload as `playwright-test-results-<name>` (`main-1of4` through `main-4of4`, `compat-chromium`, or `compat-webkit`; `main-smoke` on a PR). Every job uploads timing JSON as `playwright-reports-<name>` with the same suffixes. Touch-peek screenshots upload as `playwright-touch-peek-<name>` with the same suffixes. All three artifact types are kept for 7 days. The required `frontend-e2e` aggregate rejects any failed or cancelled matrix result, a skip the plan did not order, and a `changes` job that did not succeed. Firefox pending-inspector layout remains [Follow-up](../ROADMAP.md#after-the-beta) (original #155 report was Firefox @ 1280). `e2e/root-pin.spec.ts` checks that `/` with a pinned project redirects to it and never POSTs `/api/project/close`; specs that need Home call `openHome` from `e2e/home.ts` (it loads `/?home=1` and, unless a spec is about the Setup card, dismisses that card first). |

The [release refresh and final validation policy](#release-refreshes-and-final-validation) describes the advisory selector jobs and the mandatory full release receipt.

First-attempt PR runs of `test.yml` share a concurrency group by workflow and
PR number. A new head cancels older first-attempt work for that PR. Runs for
other PRs and pushes to `develop` have separate groups. Manual reruns use their
unique run ID instead of the PR group, because a rerun retains its original
head. This prevents an old-head rerun from cancelling running latest-head work
or replacing pending latest-head work. Deliberate reruns execute independently
and can still consume runner time. Recheck required CI on the exact final head
before merge. Cancellation of an obsolete head never certifies the latest head.

The Playwright job and `make test-web-e2e` build with `VITE_SHARECUT_E2E=1` so
recording test hooks are available. Ordinary `npm run build` omits them; its
bundle guard fails if E2E page flags or signal counters remain in emitted assets.

`expectPageAxeClean(page, selector)` can also check a focused surface; the open transport-menu test scopes its axe check to the menu while unrelated track-header and loading-timeline ARIA names are tracked in #114. Do not disable additional axe rules to hide failures.

### Browser installation

Browser matrix jobs install the matrix-selected engine and system dependencies
through the locked Playwright package with `--with-deps`. They configure
`scripts/ci_apt_method.py` before installation. The method preserves apt's package
resolver, Ubuntu signing keys, signature and date checks, and final package hashes.
It removes the runner's Azure mirror entry and the exact redundant entry
`http://us-east-2.ec2.archive.ubuntu.com/ubuntu/` followed by one tab and `priority:1`.
Other regional entries remain unsupported. Canonical HTTPS remains primary.
The text reader normalizes CRLF and lone CR line endings to LF before entry validation.

Apt-authenticated SHA256 objects use a second HTTPS source at
`mirrors.edge.kernel.org/ubuntu` after a two-second hedge. Only complete bytes
matching apt's expected size and SHA256 can win. Each object has a 90-second
acquisition budget. Initial unsigned-by-hash metadata is fetched in order,
with 15 seconds for Canonical and then 15 seconds for Kernel. Apt authenticates
the returned metadata. A healthy primary therefore determines metadata freshness;
a fallback can still carry an older valid signed release that apt accepts.
A corrupt first metadata response fails apt authentication rather than starting
a race between signed releases.

Connections have a five-second bound. Transfers below 16 KiB/s for five seconds
are stopped. Apt update errors fail setup even when cached indexes exist.
Diagnostics report the source, bytes, elapsed time, budget, HTTP status and remote
address without dumping apt configuration or credentials. An address can identify
a proxy rather than the serving backend. For an unsupported mirror entry, setup
fails with one bounded JSON diagnostic containing the one-based line number,
character length excluding LF or CRLF, and entry. The entry appears exactly only
when it matches a bounded ASCII HTTP or HTTPS DNS hostname with `/ubuntu` or
`/ubuntu/`, optional numeric `priority:` metadata of up to six digits, and bounded
spaces or tabs. Every other rejected entry is fully replaced with `<redacted>`.
This diagnostic does not admit additional mirrors or fix an unsupported layout.
The method supports the current Ubuntu resolute runner archive layout. For an
unrecognised apt sources layout the step prints a warning annotation naming the
public URIs, redacting any other token, writes nothing and leaves stock apt in
place. A mirror, suite, component, ownership or prerequisite problem still fails
setup.

This provides bounded origin fallback for the remaining apt acquisition failure
class in [#2117](https://github.com/calebn/sharecut-studio/issues/2117).
It does not identify the historical slow backend or establish independent network
routes. Mirror lag, shared network failures and older signed fallback metadata
remain availability risks. Browser and npm downloads retain their own transports.
The installation step keeps its ten-minute bound and the job its 60-minute bound.
There is no browser cache or install retry.

### Storybook browser geometry

`npm run test:e2e:storybook` in `gui/web` builds the static Storybook catalog,
serves it on port 6010, and runs Chromium against the production edit-corner
and inspector-sheet stories. Testing the build avoids dev-server compilation and reloads while
Docs iframe previews initialize.
The restored-word fixtures make ghost preview geometry observable without a
live episode or backend. Real mouse trajectories check stable text and row
layout, handle displacement, preview bounds, and Escape cleanup at 1440px
and 360px in light and dark themes. `.github/workflows/storybook.yml` installs
Chromium and runs this suite against the catalog build on pushes and on
manual dispatch, which the nightly promotion uses. A pull request runs only the render smoke
(`coverage.spec.ts` and `docs-theme.spec.ts`) and skips the story sweep. This
supplements the jsdom story interaction and axe checks.

`e2e-storybook/story-layout.spec.ts` checks floating panels in both standalone
Canvas and Docs at desktop and phone widths in both themes. Menus must fit
their inline host. Fixed popovers and body-portaled dialogs must fit their
own Docs iframe. Shell examples must keep document attributes inside their
frame. These checks preserve intentional scrolling inside production panes.
`e2e-storybook/docs-theme.spec.ts` changes the manager theme toolbar while
Docs frames are mounted, including an OS preference opposite to the explicit
toolbar choice. The Docs page and its stories must follow the chosen theme.

Storybook's accessibility addon and `e2e/axe.ts` apply the WCAG 2.0 and 2.1
A and AA tags, including contrast and label-content-name-mismatch.
`src/storybook/storySweep.sweep.browser.test.tsx` (`npm run test:stories`,
Vitest browser mode, sharded 4 ways in `storybook.yml`) checks each story in both
themes and its supported phone and desktop widths. The few stories that need the
Storybook runtime (`src/storybook/storybookOnlyStories.ts`) stay in
`e2e-storybook/coverage.spec.ts`. These checks do not certify the live
palette, which also needs browser verification against the current catalog.

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

`e2e/transcript-inline-edit.spec.ts` includes one 320×568 touch correction case.
It measures the inline word-edit controls before either receives focus or
scrolling, checks the 44px floor and inline validation, then saves and undoes a
word correction against the copied live project. Browser geometry is necessary
for this regression; component tests cannot detect a control below the sheet.
The case adds one Chromium run, alongside the existing desktop inline-edit tests.

Specs share one live project with `workers: 1`, so rows from earlier specs (for
example `guest:suggest` pending edits) are still present. A spec that acts on a
row it just created must wait for its own mutation's response and select the row by the id it returns
(`e2e/pendingEdit.ts` `openSuggestedPendingEdit`, the first Review queue row is selected, then Open in Edit)
rather than trusting `.last()`.

Specs that set up state through the API post it with `e2e/documentCommand.ts`
(`postDocumentCommand`, `waiveRefineGate`) and undo each command they applied
in `finally`, so later specs see the fixture unchanged
(`e2e/applied-edit-seams.spec.ts`, `e2e/edit-boundary-archive.spec.ts`).

### Record-room Playwright scenarios

The room-tone Accept browser scenario opts into a deterministic PCM harness in
addition to the existing `e2e=1` and Playwright init flags. Headless Chromium's
fake microphone may remain live while its `AudioContext` clock advances too
slowly to feed the worklet. The harness is limited to that explicitly flagged
test, then follows the normal PCM-to-WAV, OPFS, and Accept code paths; it must
not change the production capture timeout or be enabled by general E2E setup.
The test pre-arms a response matcher immediately before Accept and waits for a
successful acknowledged room-tone upload (`file_ack: true`) after consent; it
does not assert the transient `Saving room tone…` copy, which can be missed
under full-suite scheduling. Upload is consent-gated, so Accept is the earliest
point at which the request can occur.

The US-1 scenario (`records a remote interview end to end`) waits for at least
1 s of guest keeper PCM before Stop, then polls the host upload API until the
guest's and the host's keeper segments are all file-ACKed. It lands through
the server's ACK auto-land (`waitForTakeLanded` polls the host upload API until
every segment reads landed), polls the saved project JSON until the three live comments appear in `review.comments[]`
(each within ±0.25 s of the host recording clock around its press), checks that
both Ava's and the host keeper's landed clips point at files under `raw/`, and
checks server-side that the producer has no upload rows and that the host
upload list has no producer row.

The US-2 host-disconnect scenario (`gui/web/e2e/record-host-reconnect.spec.ts`)
models a host drop with `installNetworkOutage` (`gui/web/e2e/networkOutage.ts`).
It uses `page.routeWebSocket` to proxy the host's `/api/host/ws` (the host
record plane) and the guest's `/api/rec/<token>/ws`, and it aborts the guest's
`/api/rec/` HTTP. A drop closes both sides of the proxied sockets, so the
server sees the host leave. Until restore, it refuses new sockets before they
open. A 2 s blip must reconnect in under 9 s and stay REC with one keeper
segment per side. A 14 s outage must show the guest "Host offline" copy
while its keeper grows, refuse a remint (409; a remint after Stop also kills the old links), then force PAUSED with
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

The `pytest-quality` and `pytest-shard` jobs each use one locked Python 3.14
environment; the shards run all four planner scopes. The shard job environment
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

### Object-store fixture allocation

`tests/conftest.py` allocates one private object-store parent per pytest worker
session, then an atomic random child directory with fresh `relay.yaml` for each
test. This avoids a second numbered scan of pytest's growing base directory for
every test. The YAML stays outside `tmp_path`, retains real parsing and explicit
config-path support, and never shares mutable state between tests. The existing
six object-store environment keys are still cleared for every test.

The parent and children have private POSIX directory modes. On Windows the
parent receives the same restricted inheritable DACL as `tmp_path`, before any
child is created. Children and YAML inherit grants for the current user, SYSTEM
and administrators. A failed ACL operation or allocation fails setup. Pytest
owns the parent and its diagnostic retention; there is no per-test cleanup
manager. `tests/test_object_store_fixture.py` checks real loaders, fresh mutable
files, explicit paths, live overrides, restoration, failure paths and privacy.
The existing native Windows registry job also runs these contracts on NTFS.

### Temporary storage

The `pytest-quality`, `pytest-shard` and `frontend-e2e-suites` jobs in `test.yml` and the `extras` job in
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
cell is backed by the required `frontend-e2e` job on dispatch, which promotion
runs every night, and the guard below enforces that. Pull requests run no
compat column. The matrix was first assembled from #703 (Chromium,
PR #739) and #704 (WebKit, PR #747); those numbers are provenance only.
The Chromium column is Playwright's bundled Chromium,
standing in for Chrome (branded Chrome runs only locally, with
`E2E_BRANDED_CHROME=1`). The WebKit column is Playwright WebKit, standing in
for Safari; it is not Apple's Safari. No compat project runs Firefox, so no
Firefox result is claimed.
For newly added checks, Pass declares required engine coverage; it does not
attest a result before that source head has run in CI.

"Pass" means the required `frontend-e2e` gate on `main` includes the check on
that engine with at most one retry and no skip, so a promoted `main` is a measured
pass. "Not run" means the CI compat project for that column does not run it. Core-flow rows are the `test.step`s of its one
test; other rows are whole tests. The seven direct compat axe owners and the
shared touch-affordance and Mix helpers assign compat scans to WebKit.
Main Chromium Studio scans and all reading-surface scans remain enabled.
Chromium retains every non-axe assertion in the compat specs it runs.
Branded Chrome keeps its full local inventory. Its `browserName` is `chromium`,
so those conditional scans do not run there. Comment-undo and wordbar retain
their existing unconditional helper scans in branded Chrome.

The touch-drawer theme and motion row describes
assertions both engines run. WebKit also scans every collected sheet state
with axe before the collected results are asserted.

| Check | Spec | Area | Chromium (Chrome) | WebKit (Safari) | Firefox |
| --- | --- | --- | --- | --- | --- |
| Bounce remains reachable through running-row insertion and late Transcript hydration | `gui/web/e2e-compat/bounce-deliver-hydration.spec.ts` | CSS / layout | Pass | Pass | Not run |
| Deliver restores normal reading after departure from a starting Bounce | `gui/web/e2e-compat/bounce-deliver-hydration.spec.ts` | CSS / layout | Pass | Pass | Not run |
| Fix text fallback fits wide text and stays within its row | `gui/web/e2e-compat/fix-text-width.spec.ts` | CSS / layout | Pass | Pass | Not run |
| a Fix text draft survives tablet-phone-tablet layout changes | `gui/web/e2e-compat/fix-text-draft-layout.spec.ts` | CSS / layout | Pass | Pass | Not run |
| Project menu keeps focus after a blurred Fix text save and Undo restores the word | `gui/web/e2e-compat/project-menu-after-fix.spec.ts` | Core flow | Pass | Pass | Not run |
| record: keeper capture, upload and landing | `gui/web/e2e-compat/core-flow.spec.ts` | getUserMedia | Pass | Pass | Not run |
| transcribe: the episode transcript hydrates | `gui/web/e2e-compat/core-flow.spec.ts` | Core flow | Pass | Pass | Not run |
| review: the queue opens with no suggestions to decide | `gui/web/e2e-compat/core-flow.spec.ts` | Core flow | Pass | Pass | Not run |
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
| Wordbar handle release and exact Undo work across browsers | `gui/web/e2e-compat/transcript-wordbar.spec.ts` | Core flow | Not run | Pass | Not run |
| keeps Next, its selection and the following Script line reachable | `gui/web/e2e-compat/words-actionbar-header.spec.ts` | CSS / layout | Pass | Pass | Not run |
| phone Mix native edits and touch geometry across engines | `gui/web/e2e-compat/phone-mix.spec.ts` | Core flow | Pass | Pass | Not run |
| comment recovery keeps native disabled-button focus and sticky controls | `gui/web/e2e-compat/comment-undo.spec.ts` | Core flow | Not run | Pass | Not run |
| returns invalidated Undo focus to the visible current Inspector Close | `gui/web/e2e-compat/feedback-inspector-focus.spec.ts` | Core flow | Pass | Pass | Not run |
| outside focus stays on header Undo when a peer invalidates toast Undo | `gui/web/e2e-compat/feedback-inspector-focus.spec.ts` | Core flow | Pass | Pass | Not run |
| native envelope owner cancels locally and ignores synthetic foreign events | `gui/web/e2e-compat/envelope-recovery.spec.ts` | Core flow | Pass | Pass | Not run |
| 568x320 phone envelope controls scroll into reach and preserve saved points | `gui/web/e2e-compat/envelope-short-phone.spec.ts` | CSS / layout | Pass | Pass | Not run |
| Invite touch affordances work in the compatibility browser | `gui/web/e2e-compat/touch-affordances.spec.ts` | CSS / layout | Pass | Pass | Not run |
| clip Inspector touch affordances work in the compatibility browser | `gui/web/e2e-compat/touch-affordances.spec.ts` | CSS / layout | Pass | Pass | Not run |
| a phone held sideways keeps two whole compact lanes and Undo in reach | `gui/web/e2e-compat/phone-chrome.spec.ts` | CSS / layout | Pass | Pass | Not run |
| a phone in portrait keeps Undo and Redo in the header, the corner controls on one row and four whole lanes | `gui/web/e2e-compat/phone-chrome.spec.ts` | CSS / layout | Pass | Pass | Not run |
| a 360px phone keeps the range toggle, Zoom, Undo and Redo whole and in reach, and Zoom runs | `gui/web/e2e-compat/phone-chrome.spec.ts` | CSS / layout | Pass | Pass | Not run |
| an iPad Air 1180 wide in landscape keeps Select range in the corner and the add-track button | `gui/web/e2e-compat/phone-chrome.spec.ts` | CSS / layout | Pass | Pass | Not run |
| an iPad Pro 11 1194 wide in landscape keeps Select range in the corner and the add-track button (#1674) | `gui/web/e2e-compat/phone-chrome.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 932x430: the edited lane stays beside the card and Time and Remove are in reach | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 932x430: Time, Level and Remove are visible with the lane, and with the keyboard up | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 932x430: Level and Remove run from inside the sheet | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 914x331: the edited lane stays beside the card and Time and Remove are in reach | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 914x331: Time, Level and Remove are visible with the lane, and with the keyboard up | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 914x331: Level and Remove run from inside the sheet | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| an open envelope point survives rotating from portrait to landscape | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| the Edit corner covers no lane at 844x390, and every guest M and S is hit-testable | `gui/web/e2e-compat/edit-corner-lanes.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 1194x834 iPad landscape keeps Time and Level stacked with their visible help | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 932x430 phone landscape keeps Time and Level stacked with their help, in the Inspector card | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 914x331 idle: a touch tap on the guest track header opens its details and reaches Show volume envelope | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 667x375 phone shell idle: the marker rows scroll with the lanes | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 667x500 phone shell idle: the marker rows stay pinned under the ruler | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 914x331 idle: the marker rows scroll with the lanes | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 932x430 idle: the marker rows stay pinned under the ruler | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 1194x834 idle: the marker rows stay pinned under the ruler | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| 1024x768 idle: the marker rows stay pinned under the ruler | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| a soloed track keeps Clear solo tappable at the top of the timeline at 914x331 while the envelope sheet is open | `gui/web/e2e-compat/landscape-envelope-sheet.spec.ts` | CSS / layout | Pass | Pass | Not run |
| fresh short landscape exposes both tracks and keeps their Mute and Solo reachable | `gui/web/e2e-compat/adaptive-panels.spec.ts` | CSS / layout | Pass | Pass | Not run |
| the corner controls leave their targets clear | `gui/web/e2e-compat/adaptive-panels.spec.ts` | CSS / layout | Pass | Pass | Not run |
| a native guest Mute center tap stays at scrollTop zero while acknowledgment is pending | `gui/web/e2e-compat/adaptive-panels.spec.ts` | CSS / layout | Pass | Pass | Not run |
| phone shells keep every control a finger can use at 360, 390 and 767 wide | `gui/web/e2e-compat/reachability-sweep.spec.ts` | CSS / layout | Pass | Pass | Not run |
| tablet and desktop shells keep every control a finger can use across 768 to 1195 wide | `gui/web/e2e-compat/reachability-sweep.spec.ts` | CSS / layout | Pass | Pass | Not run |
| loaded tablet Player stays reachable at 200% text | `gui/web/e2e-compat/reachability-sweep.spec.ts` | CSS / layout | Pass | Pass | Not run |
| a phone held sideways and an iPad keep every control a finger can use | `gui/web/e2e-compat/reachability-sweep.spec.ts` | CSS / layout | Pass | Pass | Not run |
| a track with an envelope and an effect chain keeps every control a finger can use | `gui/web/e2e-compat/reachability-sweep.spec.ts` | CSS / layout | Pass | Pass | Not run |
| pending-edit and transcript-word Inspector bodies keep every control reachable | `gui/web/e2e-compat/reachability-sweep.spec.ts` | CSS / layout | Pass | Pass | Not run |
| the tablet clip sheet shows its rows and leaves its commands to the Action bar | `gui/web/e2e-compat/selection-sheet-zones.spec.ts` | CSS / layout | Pass | Pass | Not run |
| the phone sheet shows its rows and leaves its commands to the dock | `gui/web/e2e-compat/selection-sheet-zones.spec.ts` | CSS / layout | Pass | Pass | Not run |
| agent range controls stay reachable from a tablet clip sheet | `gui/web/e2e-compat/selection-agent-range-reachability.spec.ts` | CSS / layout | Pass | Pass | Not run |
| a zero-start agent range arriving at the short-tablet column stays reachable | `gui/web/e2e-compat/selection-agent-range-reachability.spec.ts` | CSS / layout | Pass | Pass | Not run |
| a tablet track sheet owns the agent range controls | `gui/web/e2e-compat/selection-agent-range-reachability.spec.ts` | CSS / layout | Pass | Pass | Not run |
| agent range arrival and removal keep the short-tablet column reachable | `gui/web/e2e-compat/selection-agent-range-reachability.spec.ts` | CSS / layout | Pass | Pass | Not run |
| Keep decides one queue item at a thumb-sized target, then one Undo brings it back | `gui/web/e2e-compat/phone-chrome.spec.ts` | CSS / layout | Pass | Pass | Not run |
| a long press then a drag selects a word range, and the sheet clears it with no step buttons | `gui/web/e2e-compat/transcript-touch-range.spec.ts` | CSS / layout | Pass | Pass | Not run |
| a finger that moves before the hold scrolls and selects nothing | `gui/web/e2e-compat/transcript-touch-range.spec.ts` | CSS / layout | Pass | Pass | Not run |
| the phone timeline shows Undo and Redo | `gui/web/e2e-compat/phone-chrome.spec.ts` | CSS / layout | Pass | Pass | Not run |
| native Tab keeps every Stage bar indicator inside its clip | `gui/web/e2e-compat/phone-navigation-focus.spec.ts` | CSS / layout | Pass | Pass | Not run |
| Smooth all joins in the track sheet stays inside a 390 and a 393 wide phone viewport in both detents and works | `gui/web/e2e-compat/menu-viewport.spec.ts` | CSS / layout | Pass | Pass | Not run |
| an app toast stays topmost and tappable over the Project menu opened after it | `gui/web/e2e-compat/menu-viewport.spec.ts` | CSS / layout | Pass | Pass | Not run |
| an app toast stays topmost and tappable over the Project menu that was open before it | `gui/web/e2e-compat/menu-viewport.spec.ts` | CSS / layout | Pass | Pass | Not run |
| every native compact Tab target paints its focus indicator inside actual clips | `gui/web/e2e-compat/compact-painted-focus.spec.ts` | CSS / layout | Pass | Pass | Not run |
| one finger moving never edits; a long-press arms, and the armed point drags in time and level | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| at 390x844 by default, one finger dragging a selected clip's trim end saves nothing and opens the drawer at half height | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| a long-press arms a clip, which moves in time only, holds at its neighbour's edge and saves there | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| an armed drag holds at a soft boundary, and saves there | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| a second finger cancels an armed clip move | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| a long-press on empty space opens the create menu; Add volume point adds one there | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| a long-press past the last clip opens the create menu and selects no text | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| in a short viewport the create menu stays in view off the finger, and lifting without moving saves nothing | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| tablet landscape at 200% text still lets Zoom hit the ruler | `gui/web/e2e-compat/touch-grammar.spec.ts` | CSS / layout | Pass | Pass | Not run |
| the create menu reaches every item and stays off the finger at every text size and screen height | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| a create menu taller than 90% of the screen, with room beside the finger, is not cut to 90% | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| a second finger cancels an armed drag and the create menu | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| #1135: a long-press at a join offers the ripple trim, which shows where later clips go | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| #1154: a touch ripple trim over the guest's speech applies as one manual trim | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| #1135: a plain mouse grab at a join rolls it, as on main | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| the sheet follows the finger on its grip; a flick opens or closes it, the arrow keys step it | `gui/web/e2e-compat/touch-grammar.spec.ts` | Core flow | Pass | Pass | Not run |
| iPhone envelope Time field is at least 16px | `gui/web/e2e-compat/touch-field-size.spec.ts` | CSS / layout | Pass | Pass | Not run |
| iPhone comment field is at least 16px | `gui/web/e2e-compat/touch-field-size.spec.ts` | CSS / layout | Pass | Pass | Not run |
| chip: slid on, settled, slid along the axis | `gui/web/e2e-compat/touch-drawer.spec.ts` | Core flow | Pass | Pass | Not run |
| chip: lifted at the origin, chip pressed again, slid along the axis | `gui/web/e2e-compat/touch-drawer.spec.ts` | Core flow | Pass | Pass | Not run |
| chip: slid on and lifted without moving | `gui/web/e2e-compat/touch-drawer.spec.ts` | Core flow | Pass | Pass | Not run |
| chip: rested a long press, then dragged off the axis (no grab) | `gui/web/e2e-compat/touch-drawer.spec.ts` | Core flow | Pass | Pass | Not run |
| no grab while passing over chips or moving off the axis | `gui/web/e2e-compat/touch-drawer.spec.ts` | Core flow | Pass | Pass | Not run |
| the half sheet leaves the selection in view; the dock detent keeps its verbs; the grip toggles them | `gui/web/e2e-compat/touch-drawer.spec.ts` | Core flow | Pass | Pass | Not run |
| dragging the grip down past the dock clears the selection: portrait-390 | `gui/web/e2e-compat/touch-drawer.spec.ts` | Core flow | Pass | Pass | Not run |
| a pending edit's review card tops the sheet and its Approve and Reject stay reachable at enlarged text sizes | `gui/web/e2e-compat/touch-drawer.spec.ts` | Core flow | Pass | Pass | Not run |
| both themes and reduced motion with the sheet open | `gui/web/e2e-compat/touch-drawer.spec.ts` | Core flow | Pass | Pass | Not run |
| a timeline tap while a track's sheet is open selects, and Inspect opens the sheet at half: portrait-390 | `gui/web/e2e-compat/touch-drawer.spec.ts` | Core flow | Pass | Pass | Not run |
| a point added from a track's sheet shows its fields in the sheet: portrait-390 | `gui/web/e2e-compat/touch-drawer.spec.ts` | Core flow | Pass | Pass | Not run |
| a second finger cancels the drag and pinches (portrait-360) | `gui/web/e2e-compat/touch-pinch.spec.ts` | Core flow | Pass | Pass | Not run |
| a second finger cancels the drag and pinches (landscape-844) | `gui/web/e2e-compat/touch-pinch.spec.ts` | Core flow | Pass | Pass | Not run |
| timeline text takes no selection or callout | `gui/web/e2e-compat/touch-selection.spec.ts` | CSS / layout | Pass | Pass | Not run |
| no shell row draws over the strip, nor the strip over it: portrait-360 | `gui/web/e2e-compat/touch-strip-stacking.spec.ts` | CSS / layout | Pass | Pass | Not run |
| no shell row draws over the strip, nor the strip over it: landscape-636 | `gui/web/e2e-compat/touch-strip-stacking.spec.ts` | CSS / layout | Pass | Pass | Not run |
| live waiver draft survives a short to tall tablet resize | `gui/web/e2e-compat/pending-actionbar-lifecycle.spec.ts` | Core flow | Pass | Pass | Not run |
| docks in the inspector sheet | `gui/web/e2e-compat/pending-actionbar-ruler.spec.ts` | CSS / layout | Pass | Pass | Not run |
| floats between the ruler and the bottom panel | `gui/web/e2e-compat/pending-actionbar-ruler.spec.ts` | CSS / layout | Pass | Pass | Not run |
| leaves Approve and Reject to the inspector | `gui/web/e2e-compat/pending-actionbar-ruler.spec.ts` | CSS / layout | Pass | Pass | Not run |
| pending card: a marker added while it floats leaves the one-row lane where it was and the card clear of it | `gui/web/e2e-compat/pending-actionbar-reflow.spec.ts` | CSS / layout | Pass | Pass | Not run |
| pending review: inline Approve and Reject stay reachable after 720 to 360 to 260 | `gui/web/e2e-compat/pending-actionbar-reflow.spec.ts` | CSS / layout | Pass | Pass | Not run |
| Auto drags directly when a step is 4 px wide at a deep zoom | `gui/web/e2e-compat/precision-drag.spec.ts` | Core flow | Pass | Pass | Not run |
| jog: a ripple over the guest's speech applies as one manual trim | `gui/web/e2e-compat/precision-drag.spec.ts` | Core flow | Pass | Pass | Not run |
| jog: a second finger cancels the drag and saves nothing | `gui/web/e2e-compat/precision-drag.spec.ts` | Core flow | Pass | Pass | Not run |
| jog: moves a trim end exactly one 10 ms step and saves it | `gui/web/e2e-compat/precision-drag.spec.ts` | Core flow | Pass | Pass | Not run |
| jog: a tap outside the pad finishes and saves | `gui/web/e2e-compat/precision-drag.spec.ts` | Core flow | Pass | Pass | Not run |
| a document state load the server never answers shows the project failure cover whose Try again recovers | `gui/web/e2e-compat/initial-load-recovery.spec.ts` | Core flow | Pass | Pass | Not run |
| the failure cover sits in view, not under the fixed shell, and its Try again recovers | `gui/web/e2e-compat/initial-load-recovery.spec.ts` | Core flow | Pass | Pass | Not run |
| saved feedback stays clear of the sheet's dock and grip at half and full | `gui/web/e2e-compat/compact-feedback-detents.spec.ts` | CSS / layout | Pass | Pass | Not run |
| automatic Full returns to Half after a short phone returns to portrait | `gui/web/e2e-compat/inspector-auto-fit.spec.ts` | CSS / layout | Pass | Pass | Not run |
| manual Full remains Full after a short phone returns to portrait | `gui/web/e2e-compat/inspector-auto-fit.spec.ts` | CSS / layout | Pass | Pass | Not run |
| Undo and Redo stay reachable in the App header with the Inspector sheet open | `gui/web/e2e-compat/compact-history-persistence.spec.ts` | CSS / layout | Pass | Pass | Not run |
| holding A with nothing selected plays the original and restores on keyup | `gui/web/e2e-compat/hold-a-original.spec.ts` | Core flow | Pass | Pass | Not run |
| A restores the original when the window loses focus | `gui/web/e2e-compat/hold-a-original.spec.ts` | Core flow | Pass | Pass | Not run |
| A restores the original when the tab is hidden | `gui/web/e2e-compat/hold-a-original.spec.ts` | Core flow | Pass | Pass | Not run |

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
not `process.env.CI ? 1 : 0`. It also fails if the dispatch plan stops
running the complete main shard set or either complete compat engine, or stops
installing an engine with a Pass cell. It fails if the release PR plan's WebKit shards
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
waveform tiles, ruler ticks, and the envelope window through the same hooks.

The `frontend-e2e-suites` compatibility job runs the focused
`gui/web/e2e-compat/` matrix (`playwright.compat.config.ts`) in bundled Chromium
and Playwright WebKit, concurrently with the sharded main Chromium suite on
separate runners. Pull requests run neither compat engine. The
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
server-side (`make e2e-slow`). The Review queue opens with no suggestions to decide. A
transcript word is corrected and undone with Mod+Z. A viewer review share
plays the per-track MP3 proxies through Web Audio (a 200 `audio/mpeg` chunk on
Play). The Bounce section on Deliver passes full-page axe on WebKit (`expectPageAxeClean`) and
writes one non-silent WAV under `export/bounces/` — its own result copy goes
through `runAnnouncedJob` with pre-POST reservation, exact-ID binding before
Activity seeding, and a verified outcome handoff to `finishJobResult`. The frame's
`useJobStatusAnnouncement` reconciles and speaks it in place of the generic Activity "ok"
headline instead of racing it (a real bug, not WebKit-only; `bounceFlow.tsx`
and `exportFlow.tsx` share the fix, and it covers
the phone shell too). The stages run serially in one test
because export bounces the landed track, so a stage that fails on both attempts
skips the later ones until it is fixed; the report names the failing
`test.step`.

`e2e-compat/deep-zoom.spec.ts` stretches a disposable `aligned_dialogue` copy
to a one-hour session (`e2e/deepZoom.ts` `stretchProjectToSession`) and zooms to
`effectiveMaxZoomPxPerSec(3600)` (about 15 M px of content). At the end it
checks, within 1 px (the envelope window only must start at or before its point): `scrollWidth`, the reachable scroll end, the last ruler
label, tick offsets (`t × zoom`), tile placement on the 512 px grid ending at
the session end, and envelope point offsets and the window's left edge, and that the lane draws exactly one envelope dot. The Vitest helper test
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
`joinAsGuest`, which names the guest only after its socket
has joined (`fillGuestDisplayName`) and returns once the room's roster lists
that name (#764), `joinAsProducer`, whose socket opens only on Join so it
registers the typed name; both type the name through `fillDisplayNameField`),
`gui/web/e2e/keeperContexts.ts` (`RECORDER_CONTEXT`,
`keeperContextSource`) and `gui/web/e2e/keeperOpfs.ts` for keeper OPFS inspection,
`gui/web/e2e/wavPeak.ts` (landed and bounced WAV peaks, via `landedTrackPeak`
(and `landedTrackPeakOrPending` for polling) in `recordRoom.ts` and
`bouncedWavs` in `gui/web/e2e/exportFiles.ts`),
`gui/web/e2e/playback.ts` (`expectPlaybackAdvancesThenHolds`) and
`gui/web/e2e/transcriptEdit.ts` (`openScript`,
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
CI uploads timing reports on every run and native `trace.zip` and
`error-context.md` files when they exist. A separate touch-peek artifact retains
only these screenshot basename patterns under `gui/web/test-results/**/`:

- `stow-portrait-360-2-mid-drag-*.png`
- `restored-focus-portrait-360-*.png`
- `stow-landscape-636-2-mid-drag-*.png`
- `restored-focus-landscape-636-*.png`
- `pending-card-portrait-390-32-*.png`
- `pending-card-landscape-636-32-*.png`

Keep the seven-day retention and treat these artifacts as sensitive. Do not
widen the upload to all of `gui/web/test-results/`, all PNGs, audio, project files,
storage state, raw media, or private files. Other capture files require a
sanitization plan.

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
registry workflows run fully on dispatch, which promotion uses each night; `desktop.yml`
does not trigger on push. Cargo checks
use the checked-in desktop splash and run independently of the web artifact.
The Windows cargo check stages its sidecar stub without downloading web output.
Linux and Windows CI must qualify that dependency removal on the changed head.

Local mirrors:

```bash
make lint-py format-py-check typecheck  # Python static gates
./scripts/check_deploy_config.sh  # caddy validate + docker compose config for deploy/ (Docker required)
make test         # Python coverage gate
make test-web     # ShareCut Studio lint + format:check + typecheck + vitest + build
make test-web-e2e # Playwright smoke + full-page axe + Chromium/WebKit compat matrix (requires `[gui]` extra / uv)
make test-desktop # Tauri scaffold + sidecar launcher fmt/clippy/rustc --test + rustfmt + clippy --lib + lib tests (optional Rust)
make desktop-build # Freeze sidecar + installer (local only; not part of make ci)
make desktop-linux-appimage-docker # Ubuntu 22.04 AppImage (iterate before GHA)
make ci           # optional full local CI mirror (GitHub Actions is the required gate)
make golden-ear ARGS='build --project tests/fixtures/aligned_dialogue --out /tmp/golden --limit 8'
make golden-ear ARGS='score --dir /tmp/golden --answers listen/answers.csv'
```

Golden-ear (`scripts/golden_ear_harness.py`) is an owner listening harness, not a `make ci` job. Build-time `audition_context.v2` is timeline metadata; Current and Suggested audio diagnostics are measured on their rendered WAVs, with owner-only waveform PNGs under `diagnostics/` and explicit per-side errors in `key.json`. The listener manifest remains blinded. Scoring reports acceptance rollups by cut class, full reason, and speaker track, including tie and missing-answer counts. See [filler-cut-quality.md](filler-cut-quality.md) § Golden-ear protocol.

Axe policy: do not silence violations with ignore comments. Prefer native `<button>` / correct roles; share helpers (`src/test/a11y.ts`, `e2e/axe.ts`) instead of duplicating axe setup. Dense DAW chrome disables only `color-contrast` and `region` in Playwright (`expectPageAxeClean`) — other rules stay enforced. Loading timeline and track-header containers use named `group` roles so their accessible names and busy state are valid ARIA semantics; `TrackColumn.test.tsx` and `TimelineView.test.tsx` keep those loading states covered. Reading surfaces (HomeScreen without `?project=`, marketing/download/company HTML) use `expectReadingSurfaceAxeClean`, which keeps contrast and region on.

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

Desktop PR events include `**` and exclude the exact paths of known contracts
with no native consumers. `DESKTOP_PR_EXCLUSIONS` derives those paths from empty
`NATIVE_CONTRACTS` entries. The eleven current exclusions under `contracts/` are
`bootstrap-assets.schema.json`, `capabilities.manifest.json`, `caps.json`,
`distribution-profile.schema.json`, `docs-sync.json`, `export-presets.json`,
`pipeline-params.json`, `progress-exemptions.json`, `progress-richness.json`,
`roll-join-limits.json`, and `test-wait-allowlist.json`.
`desktop.yml` lists these literal exclusions. Ordinary CI tests require its
complete PR path list to equal `DESKTOP_PR_PATHS`.

A PR changing only excluded contracts starts no desktop workflow jobs. Ordinary
A PR that changes an excluded contract runs the pytest files that name it. The ten exclusions other
than `test-wait-allowlist.json` also retain frontend and browser validation.
Unknown contracts, nested contract paths, and all seven contracts with native
consumers remain admitted. Any additional admitted path starts the desktop
planner and contributes its native consumers. This changes workflow admission,
while these known empty contracts already selected no native workloads.
Other docs PRs start cheap planners but no expensive native jobs. Registry PR
events remain broad. Every dispatch, including promotion's, runs all
native workloads. Proven release-only PRs skip all native families.

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
shortcut requires the same-repository release-please branch for the base branch
(`release-please--branches--<base>--components--podcast-mcp`) and exactly
ten modified regular files. The classifier compares immutable merge-base and
head blobs. Only the known version literals and changelog can change. Dependency,
hash, code, formatting, file-mode, malformed-data, and ambiguous-identity changes
receive the full plan. The version fields must agree, increase, and remain plain
canonical `0.x` versions. The existing locked installation and 1.0 policy still
run; neither the lockfile nor its consistency check is bypassed.

A proven refresh skips the advisory Python-floor job and the expensive desktop,
extras-import, and registry Windows workloads. Each advisory workflow has a cheap
PR selector. Missing or failed advisory planning requests ordinary work; workflow
cancellation stops it. Scheduled, manual, and reusable wheel validation keep
their existing full work. The reusable wheel workflow stays outside this
shortcut.
The four required checks still report. Frontend aggregates accept only their
existing successful-plan and planned-workload combinations, and the full-history
secret scan runs on every PR.

Lightweight green checks are not permission to cut a release. Before merging a
release PR, the independent Shipping verifier must retain a full validation
receipt for release head H atop the current base branch tip B:

1. Resolve H and B. Update the release branch only if needed so B is an ancestor
   of H, then keep H stable during validation.
2. Dispatch `test.yml` on the release ref with `compatibility-base=B` and
   `compatibility-base-ref=refs/heads/<base>`. The
   `pytest-quality` job checks that its checkout is H, B is the current remote tip
   of that ref, and B is an ancestor of H. It records the checkout and compatibility base. Dispatch
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
`sqlite_errorname`, `sqlite_version`, `attempts`, `reopens` (fresh connections opened after a readonly
answer), `elapsed_sec`, and `terminal_reason`. A failed reopen adds its own note,
"reopen after attempt N ... raised". `not_transient` means the existing classifier rejected that
attempt; `deadline` means a qualifying error reached the retry deadline.
The code and name describe the terminal attempt and are `None` when unavailable.
Elapsed time includes the work in each attempt and the retry sleeps, so a SQLite
busy wait can carry it past the deadline. The note records no database path,
SQL, or secret values. A passing native run proves non-reproduction in that run;
it does not establish the cause of an earlier Windows failure.
