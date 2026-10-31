# E2E and browser fixture tests

End-to-end fixture tests, beta user-story coverage, lab verification and browser profiles. [testing.md](testing.md) keeps the test commands, quality tooling and coverage policy.

## E2E fixture tests

`tests/test_ingest_recorder_import_e2e.py` automates US-3: synthetic recorder folder (guest recorder starts 4 s early) → `ingest import` → `episode init` → `ingest consolidate` with default flags → asserts clip placement via the project and `/api/project`, then an `ingest verify` smoke.

### Beta user stories (US-1 … US-9)

The beta user stories come from `ux/pages/brief.md`, `ux/pages/screen-inventory.md`, `ux/pages/guest-journeys.md`, and `ROADMAP.md`. Each story's issue holds its Given/When/Then, steps, and run log; bugs found while working a story get their own issues. "Still manual" lists every step that has no automated check yet, including hardware-only steps (Tauri recording) and listening by ear.

"Automated" means every step except Tauri recording and listening by ear has an automated check. "Partial" means some other step still needs a manual run, and that step is named under "Still manual". Cite each coverage file by its full repo-relative path. Update a story's row in the same change that automates one of its steps. `tests/test_beta_story_matrix.py` guards this table: every cited path must exist, an "Automated" row may list only Tauri recording or listening by ear under "Still manual", and a "Partial" row must list at least one other step.

| Story | Issue | Status | Automated coverage | Still manual |
| --- | --- | --- | --- | --- |
| US-1 | #3 | Automated | `gui/web/e2e/record-lobby.spec.ts`, `gui/web/e2e/record-host-reconnect.spec.ts` | Tauri recording (#193) |
| US-2 | #9 | Automated | `tests/test_record_host_reconnect.py`, `gui/web/src/stage/hosts/RecordStage.test.tsx`, `gui/web/src/record/GuestRoomApp.test.tsx`, `gui/web/e2e/record-host-reconnect.spec.ts` | Tauri recording (#193), listening by ear |
| US-3 | #10 | Automated | `tests/test_ingest_recorder_import_e2e.py` | Tauri recording (#193) |
| US-4 | #4 | Automated | `gui/web/e2e/transcript-inline-edit.spec.ts`, `gui/web/e2e/transcript-ignore.spec.ts`, `gui/web/e2e/transcript-refine-recovery.spec.ts`, `gui/web/e2e/sharecut.mobile.spec.ts`, `gui/web/src/stage/edit/script/ScriptHost.test.tsx`, `gui/web/src/stage/frame/saveState.test.ts`, `tests/test_transcript_correct.py`, `tests/test_transcript_reconcile.py` | Listening by ear |
| US-5 | #5 | Automated | `gui/web/e2e/sharecut.smoke.spec.ts`, `gui/web/src/stage/edit/PendingEditBody.test.tsx`, `gui/web/src/stage/hosts/ReviewHost.test.tsx`, `tests/test_tighten.py`, `tests/test_mute_in_place.py` | Listening by ear |
| US-6 | #6 | Partial | `gui/web/e2e/fade-curves.spec.ts`, `gui/web/e2e/applied-edit-seams.spec.ts`, `gui/web/e2e/transcript-inline-edit.spec.ts`, `gui/web/src/panels/HistoryPanel.test.tsx`, `tests/test_history.py`, `tests/test_pending_preview.py` | Listening by ear, a mid-run Cancel |
| US-7 | #7 | Partial | `gui/web/e2e/review-surface.spec.ts`, `tests/test_review_share.py`, `tests/test_relay_proxy.py` | Host visibility of time-anchored playback feedback and host-offline fallback |
| US-8 | #11 | Partial | `gui/web/src/shareMode.test.ts`, `tests/test_share_pending_preview.py` | Two-browser suggest/approve |
| US-9 | #8 | Partial | `gui/web/src/stages/prepare/usePrepareRun.test.tsx`, `gui/web/e2e/prepare.spec.ts`, `tests/test_pipeline_run_result.py`, `tests/test_gui_export_jobs.py`, `tests/test_bounce.py` | A mid-run Cancel |

The record-lobby touch-target check holds guest room-sync frames to verify the
connecting view has no controls, then waits for **Allow microphone** before
measuring control heights. This makes the assertion deterministic across room
sync timing.

### GUI surface regressions

`gui/web/e2e-compat/phone-chrome.spec.ts` holds the real transcript-status
response until the phone queue shows three suggestions, then releases it unchanged.
The Keep/Undo case waits for **Check the transcript** and **Suggestions, 3** in
the queue sheet before selecting the `0:04` suggestion. It checks one successful
Keep command and one toast Undo. Positions must read `2 of 4`, then `3 of 4`,
then `2 of 4`, with the restored card time and focus. Saved pending-edit records
must match the originals minus that suggestion after Keep and match all originals
after Undo. The Keep target must remain at least 44 px high.

`gui/web/e2e/gui-surfaces.spec.ts` checks five editor panels and chapter inspectors
at desktop, tablet and phone widths with WCAG A/AA contrast checks (the three
widths take their themes from `withAppearance`, so both themes are checked on
each screen across the three). It also covers long comments and vocabulary announcements, phone
Pipeline parameters/model-download focus handoff, and repeated menu-trigger
clicks. `gui/web/e2e/review-surface.spec.ts` checks that a Commenter link opens
ShareCut Studio in both themes: at 1440px the guest posts a
comment and a reply, and at 320px Comments sit one action away under More. Both
widths check overflow and axe. `gui/web/src/App.review.test.tsx` pins that a share
without `view` shows an error instead of a listen page.
`gui/web/e2e/comment-undo.spec.ts` checks host Resolve and Undo persistence,
sticky toast bounds and hit testing after two interior panel scrolls, and Dismiss
focus without changing panel, ancestor, or window scroll offsets. It runs at
desktop and phone widths, one theme each, with axe while the toast is visible.
`gui/web/e2e-compat/comment-undo.spec.ts` runs one phone recovery flow in Chromium
and WebKit, including a real pending reopen request and disabled Undo focus.
These tests use disposable projects. Physical iPhone and iPad Safari checks remain
pending. Run the focused cases with `npm run test:e2e -- e2e/comment-undo.spec.ts`
and `npm run test:e2e:compat -- e2e-compat/comment-undo.spec.ts` after the E2E build.
`gui/web/e2e/envelope-recovery.spec.ts` covers envelope recovery at desktop,
tablet, and phone widths, one theme each, with reduced motion. The first gesture
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
at 360×740, 360×800, 667×360, 820×1180 and 1440×900, with 16px/32px CSS root
text, one theme and motion setting per cell from `withAppearance`. It uses native mouse input at
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
at 360px and 820px, one theme each, so axe checks both themes across the pair.
These browser checks do not validate packaged WebViews
or physical microphone behavior.

Run browser wrappers sequentially with fixture/environment unit tests. Their
workspace-marker lifecycle must not overlap. See the
[GUI surface audit](gui-surface-audit.md) for the complete source/render/live
coverage map and platform limits.

### Stage navigation helpers

Specs reach the app's chrome only through `gui/web/e2e/stageNav.ts`, so a
chrome change touches one file instead of fifty specs (#2292). Each helper says
what the spec wants and none of them names the chrome that gets there. They
drive the stage frame: the Stage bar in the App header (the tab bar on a phone),
the Project menu, the Edit stage's eye sheet and corner, and the Player's
hear menu and expanded form.

| Helper | Does |
|--------|------|
| `goToStage(page, stage)` | Clicks the Stage bar tab for `record`, `prepare`, `edit`, `review` or `deliver`. Browsers keep Mod+1 to Mod+9 for their own tabs, so helpers click rather than press the stage keys |
| `openProject(page, { stage? })` | Opens a project, waits for the save indicator (when the landing stage is picked), then goes to `edit` unless told otherwise |
| `openPanel(page, panel)` | Opens `transcript` (Edit Script), `history` (Edit sheet), `queue`, `comments` (the Review queue) or `pipeline` (Prepare) |
| `phone.show*`, `phone.openMix` | The phone's one-at-a-time Edit surfaces (Timeline, Script), Review in place of the old Listen mode, and the Mix sheet. `phone.openMore` opens the Project menu, the nearest thing to the removed More hub |
| `openProjectMenu`, `openProjectMenuItem`, `openProjectDialog`, `openRecordRoom` | The Project menu and the dialogs specs open (Share, Record, palette, gestures), through the menu, header or palette as each lives |
| `openViewSheet`, `setLayer`, `stepTrackHeight` | The Edit corner's eye sheet (layers, track height) |
| `altClickSplit`, `runPaletteCommand`, `armRange`, `addTrack` | Alt-click on a lane, the command palette, the touch corner's Select range toggle and the "+" menu |
| `setAudition(page, mode)` | The Player hear menu: Full mix, Without mix processing, Original |
| `expandPlayer`, `collapsePlayer` | The phone Player's expanded form with skip buttons |

Rules for specs: use these helpers instead of `.daw-shell`, `.transport-*`, dock
tab or More hub selectors (none of them exist any more); wait on a condition
(`saveStatus`, a dialog role, `aria-pressed`), never a fixed time; and add a
helper here when a new spec needs chrome that has none.

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

Fixture paths and the `PODCAST_E2E_PROJECT` override resolve in the test helper `tests/e2e_fixture.py` (not in the shipped package).

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
  - **Alignment / word boundaries:** see [Lab tape: alignment testing grounds](test-results.md#lab-tape-alignment-testing-grounds).

### Holdout recordings (owner catalogue)

A rule written against the lab tape must also be run on a recording that did not guide it. The owner's back catalogue supplies the holdout set (private, local only, never committed). Which sessions are development and which are holdout is in [fixture-catalog.md](fixture-catalog.md#source-sessions-provenance-and-developmentholdout-status); the first run, its metamorphic checks (gain, offset, track reorder), the bounded threshold sweep and the commands are in [holdout-evaluation.md](holdout-evaluation.md). It is on-demand, never per-PR CI. Do not tune a threshold on a holdout recording: a recording that guides a fix moves to development in the fixture catalog in the same PR.

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
DAW_E2E_PROJECT="$tmp_dir/project/episode.sharecut" \
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
DAW_E2E_PROJECT=/tmp/editor-small-1/episode.sharecut \
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
each scene. `--scene clip|boundary|playback|cold-waveform|seek|trim`
(comma-separated for several; `seek` and `trim` run only when named, see [Seek and trim profile](#seek-and-trim-profile-opt-in))
selects scenes for validity debugging; a selected scene does not establish
whole-issue coverage. `--trace --scene cold-waveform` retains a separate Chrome
diagnostic trace. It uses diagnostic sample phases excluded from primary timing budgets.
The original `large-project.spec.ts` remains the wheel/zoom/ruler-seek and
extended editor/memory protocol. The ruler uses click/keyboard seeking; these measurements do not claim
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

The Pipeline panel progress bar these scenes measured was removed with the
panel, and the progress scenes, the native progress observer and their frozen
budgets went with it. Their earlier reports remain historical evidence. A
running transcription on the Prepare stage is covered by
`prepare-progress.spec.ts`, which checks that its progress bar stays in view without
horizontal overflow at a short desktop and a phone size, in both motion modes.

Each report has a distinct execution ID and start time. Missing required
coverage, failed validity, or metadata/retention errors preserves the partial
report and fails the supplemental run. Failed fixtures and per-scene Playwright
evidence remain inspectable; successful fixtures are disposable. Output paths
must be new. Reports record dirty source for validity, but budget comparisons
require clean source and a served production build without E2E hooks.

The report declares frame-percentile applicability before measurements. Initial
load, cold decode/detail paint, held clip/boundary preview, playback, scrub endurance, and multi-key history navigation require at least two
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

### Seek and trim profile (opt-in)

A small, repeatable profile of two editing tasks with the tools above (the
`editor-workloads` Playwright spec, `editorProfile.ts` frame/long-task/CDP
sampling, `profile:remaining`). It adds no runner and no budget.

```sh
make profile-seek-trim OUT=/tmp/seek-trim            # REPEAT=2 PRESET=small by default
```

The target builds the GUI, runs the `seek` and `trim` scenes `REPEAT` times
(default 2) against a fresh disposable copy of the generated fixture in
desktop Chromium (1280 x 720, host role, light theme, reduced motion), then
prints `profile:summary` and writes it to `OUT/summary.txt`. `OUT` must not
exist: the target refuses an existing path before it builds or runs anything,
exits non-zero and leaves the directory untouched, so a retained run's
`summary.txt` is never overwritten.
It never opens the user's recordings or working project. Run it twice with the
same inputs to compare invocations; each `OUT` keeps its own raw
`run-N/<scene>/<scene>/report.json` (every frame interval, long task and raw CDP
counter before and after the window), `invocation.json`, the Playwright
output and any `failure.png`. A passing run deletes its fixture; a failed run
keeps it (about 47 MB at the small preset) under `run-N/<scene>/fixture` for
diagnosis, so delete `OUT` when you are done with a failed invocation. Rebuild
a table later with `npm --prefix gui/web run profile:summary -- OUT`.

| Task | Sample | What it does | What must hold or the run is incomplete |
| --- | --- | --- | --- |
| Seek | `ruler-seek` | From 0 s, click the ruler at 25% of the session | slider and transport clock land within 1 px of the target (`targetSeconds`, `toleranceSeconds` in the report) |
| Trim | `trim-cancel` | Drag the selected first clip's in handle 20 px, press Escape, release | no `TrimClipEdge` sent, saved clips and history head unchanged, no ghost left |
| Trim | `trim-save` | Same drag and release; a person's ripple trim applies directly | saved `source_start` equals the sent `source_sec` and moved, `source_end` unchanged; then Undo (outside the window) restores the saved clips exactly and the original history head |

A failed assertion records a `failed` sample, an `incomplete` report and a
non-zero exit. The summary prints `INCOMPLETE` with the reason, and a failed
task is never a performance result.

Sample output. Machine: Apple M2 Pro (12 logical CPUs), darwin 25.6.0 arm64.
Tooling: `main` plus this tooling at revision `c1fc4e141a34`. Browser: Chromium
156.0.8078.4, headless. Two runs per task, small fixture of 120 s, 24 clips;
first invocation. Numbers vary by host and by run. A verifier saw `trim-save` at
928 to 1112 ms on another run of the same Mac, so compare only within one
invocation or on one host, and do not read these values as a target:

```text
scene  run       sample     status  driver ms  frames  frame p50  frame p95  frame max  long tasks  long ms  task ms  script ms  layout ms  style ms
 seek    1   ruler-seek  completed        113       6       16.7       16.7       16.7           0      0.0     47.6       11.6        1.4       0.7
 seek    2   ruler-seek  completed         83       5       16.7       16.7       16.7           0      0.0     43.3       10.9        1.0       0.6
 trim    1  trim-cancel  completed        222      13       16.7       16.7       16.7           0      0.0     32.6       14.0        0.6       1.1
 trim    2  trim-cancel  completed        213      12       16.7       16.8       16.8           0      0.0     28.1       12.1        0.6       1.1
 trim    1    trim-save  completed        630      37       16.7       16.7       16.8           0      0.0     83.6       30.4        2.6       9.6
 trim    2    trim-save  completed        647      38       16.7       16.8       16.8           0      0.0     83.3       30.3        2.3       9.7
```

Reading it:

- **Frames** are page `requestAnimationFrame` intervals inside the sample
  window, which opens before the action and closes two frames after it. They sit
  on the 16.7 ms vsync floor of a 60 Hz headless Chromium, so a p50 or p95 of
  16.7 ms means no frame was late, not that the interaction is 16.7 ms fast. A
  late frame shows as 33.3 ms. On the machine above, both seek runs of the
  second invocation had one; whether a host shows late frames at all is
  machine-dependent and this table does not establish it. The seek window holds
  only 5 or 6 frames, so its p95 equals its max and is one frame of evidence.
- **Long tasks** are main-thread tasks over 50 ms. All zero here: the largest
  main-thread cost, 47.6 ms of CDP `TaskDuration` for the seek window and
  83.6 ms for the trim save, is split across many small tasks.
  `TaskDuration`, `ScriptDuration`, `LayoutDuration` and `RecalcStyleDuration`
  overlap and are deltas of CDP `Performance.getMetrics` counters.
- **Driver ms** is Playwright's wall time for the whole task including its
  assertions, server round trips and the two settle frames. It is not
  input-to-visual latency. Main-thread work is under 15% of `trim-save` driver
  time. The rest is waiting: in a separate one-off timing of the same run the
  host answered the first `TrimClipEdge` in 68 ms and the confirmed one in
  278 ms, plus boundary-context and document-state reads, so backend commands
  alone account for about half of the 630 ms. Treat driver ms as an end-to-end
  task cost with a backend share, not as the editor's responsiveness.
- **Variation** across the four runs of one task with identical inputs was 83 to
  113 ms (seek), 202 to 222 ms (cancel) and 630 to 696 ms (save). Two or four
  runs cannot support a statistical claim or a threshold. Use more `REPEAT`,
  an idle machine, and compare like with like (same host, browser, revision).

Limits. One fixture size on one desktop browser: no touch, no phones, no dark
theme, no WebKit, no real audio, and nothing here says the 60 Hz floor holds on
slower hardware (named-device runs stay in #960). The seek click is a ruler
click, not held-pointer scrubbing. The first trim ripples later clips and the
fixture has speech there, and a person's trim applies without a prompt. Two `waveform-snap` reads
finished around the seek window; the profile does not attribute them to the
seek. Other tasks (range cut, fades, envelopes, track reorder, Mix, comments)
and input-response budgets remain with #1035's deferred scope, #960 and #879.

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
approval, Suggested audio playback, host review in the Review queue, and the guest's
refreshed clip geometry after approval. The Editor scenario remains separate
because an Editor applies instead of proposing.

`useProxyTransport.test.tsx` runs the proxy and HTML audio hooks together to
check preview ownership, a paused proxy, unchanged session playhead and playback
intent, suppressed timeline clock and meters, release back to timeline playback,
and disposal on a project switch. A stopped preview keeps its ownership until
explicit release.

`tests/test_bleed_review.py` generates stereo WAVs and exercises registered MCP proposals, retries, HTTP host approval, pending/approved PCM, stale geometry/media, undo and range starts inside mute envelopes. Discovery regressions cover broad versus narrow requests with missing, partial, gapped or ambiguous peer placement; actual receiving and peer source duration, including alternate source offsets; repeated selected media probe counts; zero probing without eligible intervals; and complete protection after diagnostic truncation.

Generated unequal-audio-stream M4A and video-with-short-audio MOV files exercise receiving and peer selected-stream bounds. M4A multiple-stream extents refuse conservatively, while a known MOV audio interior remains eligible. Unknown and estimated audio extents refuse.

`tests/test_media_probe.py` verifies the first-audio extent and the stream-level duration over shared successful probe metadata, revision invalidation, copied results and failed-probe retries. Discovery separately verifies failed-probe memoization per receiving lane and retry on the next call. Full recording auditions supplement these regressions. Short reviewed excerpts are checked in under `tests/fixtures/lab_bleed/`; neither the excerpts nor the auditions prove automatic ownership detection. See [reviewed bleed ranges](transcript-reconcile.md#reviewed-bleed-ranges).

The focused `registry-backup-windows` CI job acquires and verifies the pinned
prebuilt FFmpeg pair for its audio fixtures and runs real NTFS backup, cancellation,
collision, reparse-point and DACL tests, including read denial under a disposable
second local account. That account is created and removed only on the isolated CI
runner. macOS runs a native extended ACL grant refusal test. HMAC tests pin both
POSIX canonical workspace literals and compare the actual listing API with its
platform's canonical workspace oracle.

### Native registry storage privacy

`registry-backup-windows` runs the source-privacy, portable inheritance policy,
backup, denial, collision, restore, and lifecycle tests on Windows, including the
direct SQLite cases in `tests/test_share_registry.py`; that module's 11 review-share
publication tests (14 parameterized cases) carry `requires_safe_failed_cleanup` and
skip on Windows. The job first
records production admission diagnostics for ordinary runner ancestry. It then
creates a fresh run-owned NTFS VHDX on a free drive letter, installs an exact
protected trusted root DACL with `OI|CI` inheritance, and runs production ancestry
and source admission. Pytest base storage, identity, and cache are on that volume.
The other Windows Python jobs in `desktop.yml` use the same provisioning script.
An `always()` step detaches and removes only the recorded owned image, including
when setup or pytest fails. Shared system-root ACLs are never changed.

The disposable account uses `New-LocalUser` with a strong random credential sent
through stdin and converted to `SecureString`. The credential holder hides its
password from repr, failure diagnostics redact it, and teardown removes only that
run's account. The denial test impersonates that account against the live source
main/WAL/SHM/journal family, snapshot, stage, and published backup. Source ACL
regressions install unsafe grants after fixture setup so the fixture cannot erase their trigger.
Portable policy mocks and macOS ACL tests do not prove NTFS or native Windows
account denial. Retain failed setup and test receipts and require an actual
successful Windows run before claiming those guarantees.
