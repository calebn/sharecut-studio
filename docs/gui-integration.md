# GUI integration

Guide for building a desktop or web editor on top of Podcast MCP services and MCP tools.

## Architecture

- **State:** `episode.sharecut` is the source of truth for clips, pending edits, FX chains, and `editorial.edit_log`.
- **Mutations:** Route all timeline changes through `EditService` / MCP tools or typed document commands (`POST /api/document/command` — never bare domain calls). Each mutation creates history snapshots. On the web client, `api.ts` exposes `submitDocumentCommand`; `services/commandQueue.ts` persists and orders host/guest edits, handles replay and conflicts, and applies successful results only for the active project. `api/documentTransport.ts` posts the command to the host or guest endpoint.
- **ShareCut Studio today:** comments (incl. Ask threads on pending edits), pipeline, History Undo/Redo, pending Approve/Reject (incl. Review Queue Cut all + tighten hits (grouped by the server `kind`; reasons `filler:`/`pause:`/`repetition:`/`restart:`) with Find more at the saved intensity (pipeline `analyze_fillers_pauses` only)), pending nudge, Current/Suggested/A/B audition, applied source MUTE Restore and Open History for cuts, clip fades / join mode, Track FX bypass, Transcript Edit-mode correct/suppress/ignore, chapter/social marker CRUD, blade/delete, project/track/audio ingest via document commands, host **Menu → Share…** (live links, mint, revoke), the host **Record** stage (lobby/consent/Start + full-quality recording + mix-minus), and host **Menu → Connect agent…** (local Streamable HTTP MCP URL) — [daw-editing.md](daw-editing.md), [share-tokens.md](share-tokens.md), [recording-session.md](recording-session.md).
- **Host MCP (local Streamable HTTP):** `gui/host_mcp.py` mounts the same `MCPServer` as stdio at `http://127.0.0.1:8765/mcp` (official `mcp` SDK). Tools apply to the open episode (`app.state.served_project`). See § Local host MCP.
- **Remote MCP (share tokens):** `gui/routes/remote_mcp.py` + `services/remote_mcp/` — capability-scoped guest tools over JSON-RPC; mutations still go through `ShareService` / `DocumentSyncService` (no forked domain logic). See [host-online-relay.md](host-online-relay.md) § Remote MCP.
- **Audio:** Rendered stems and premix live under `artifacts/`; undo restores project JSON only — call `render_preview` or `history_undo(rerender=true)` after undo.

## Clocks

| Clock | Use for | Tools |
|-------|---------|-------|
| **Source** | Cut decisions, transcript words | `cut_*`, `search_transcript` `start`/`end` |
| **Timeline** | Play, chapters, ripple by time | `play_audio_tool`, `play_compose_tool`, `ripple_delete_tool`, `list_applied_edits_tool` |

`search_transcript_tool` returns both clocks on each match.

### Ripple trim previews

`gui/web/src/edit/ripplePreview.ts` mirrors `edits/ripple.py` for trim drafts
and drag arrows. An edge-moving lane identifies one anchor and classifies each
whole follower against that anchor's original bounds. The edited lane and a lane
with a moving peer use the same rule. A lane without a moving edge uses the
existing time-splice preview. The shared cases in
`contracts/ripple-scope.json` check saved geometry, clip and recording identity,
source ranges, arrows, cuts, and atomic refusal in Python and Vitest.
The geometry constants both sides share (minimum clip span, time epsilon, join
gap tolerance, ripple edge epsilon) sit in the `constants` block of
`contracts/trim-edge-limits.json`, `join-length-limits.json` and
`ripple-scope.json`. Python reads them through `util/contracts.py`; the GUI reads
`gui/web/src/types/limits.generated.ts`, written by
`scripts/export_limit_contracts.py` (`make schema-export`).
A trim that newly moves a whole follower below timeline zero by more than 1 ns
raises `ripple_before_zero` before any lane changes. This preserves the rendered
source clock without cutting source audio or clamping one follower. Drag,
keyboard, and strip nudge candidates validate through the same client draft
operation before publication. Invalid input shows the existing error feedback
and keeps the last valid draft and arrows. Release saves only that accepted
value. `ripple-overlap-proof.spec.ts` checks the built GUI's large-overlap refusal,
last-valid save, and Undo on edited and moving-peer lanes, alongside the 0.4 ms
preview/save regression.

## Undo / history

- Interactive edits: two snapshots per action (`before …` / `after …`).
- `history_list` returns flat `entries` plus grouped `groups` for mutation pairs.
- `history_diff_tool` / `podcast history diff` — structured clip/decision/mix delta between indices.
- `history_goto_tool` / `podcast history goto` — jump cursor without stepping undo/redo.
- Pipeline steps record one snapshot per changed editable state (`after {step}`). Progress alone adds no History row. The shared comparison ignores `render_last_completed_step`; snapshots still store that cursor for undo and redo.
- Studio Undo and Redo use the [project-opening history policy](history.md#decision-history-intents-belong-to-a-project-opening). They require a connection and supported browser ownership, never replay, and wait behind active history moves across tabs.
- **ShareCut Studio History tab:** Undo / Redo buttons call document commands `UndoHistory` / `RedoHistory` → `HistoryService` (same as MCP/CLI). Applied snapshots carry `history.groups` so the list stays current after targeted TRACKS/COMMENTS patches. With `rerender: true`, a failed render or a merge clash after the move is saved answers **409** (`conflict: true`; a WS `Error`) with the message that says to re-render the preview instead of repeating the move.

After undo, check `render_status_tool` — `needs_rerender` when stems or premix are stale; only stems whose track the undo changed go stale, a mix-only undo stales just the premix.

## Applied-edit provenance

Committed cuts are archived in `editorial.edit_log` (not deleted with `edit_decisions`).

- `list_applied_edits_tool` / `podcast edit list-applied` — filter by track or timeline window.
- Each record includes `reason`, source/timeline ranges, and tool `params`.
- `ripple_delete_clips` / `delete_clips` records carry no clip ranges after the clips are gone, so they store `params.cut_spans` (`{track_id: [[start, end], ...]}`, timeline seconds) for `edit_impact_report`.

## Read APIs for inspectors

| API | Purpose |
|-----|---------|
| `list_clips_tool` | Full clip rows incl. `join_in_mode`, `source_id`, required `source_duration_sec` (`number | null`) and `recording_key` (`string | null`) for the clip's own recording, which the DAW's `trim_edge_limits` mirror stops at (`recording_key` is an opaque identity, `rec_` plus a hash, shared by clips that play the same file; it names no file, so a share guest learns no file name), `origin_track_id` and the effective join render (`join_left_clip_id`, `join_render_mode`, `join_crossfade_ms`, `join_crossfade_blocked`, `join_borrow_sec` while the join blends; computed by the same functions render uses) |
| `list_edit_decisions_tool` / `podcast edit list --pending` | Pending cuts, each with `kind`, `sound_kind`, `label` and `suggested_action` (see [Pending edit `kind`](#pending-edit-kind)) |
| `list_applied_edits_tool` | Committed cut provenance |
| `edit_impact_report_tool` | Seconds cut (once per cut, per track in `by_track_sec`) and applied-edit count, from approved edits in `editorial.edit_log` plus any applied decisions still in `edit_decisions`; mutes count as applied but remove no time |
| `render_status_tool` | Stem freshness, premix, reconciliation stale |
| `reconciliation_status_tool` | Transcript/audio drift flag |

Mutation tools return **JSON** with `operation`, echoed input params, and summary fields (`clip_count`, `affected_tracks`, …).

### Pending edit `kind`

Every `pending_edits[]` row in the ProjectView carries `kind`, the Review queue group, and `sound_kind`, the raw detector kind behind it. Both come from one table in `edits/cut_policy.py`, read through `review_fields(reason)`, which also gives `label` and `suggested_action`, so the web groups on the field and never parses `reason`. `propose_edits`, `list_edit_decisions_tool` and `podcast edit list` rows carry the same four fields.

`ProjectView.session_suggestions[]` lists the staged record sessions (insert or replace targets) still waiting for a decision: only `status == "pending"` rows, each as `{id, kind, session_id, session_number, at_sec, from_sec, to_sec, track_ids, take_count, take_indexes, selected_take}` (`gui/mapper.session_suggestions_for_view`); `take_indexes` is the sorted distinct `take_index` set (the takes Accept and `SelectSessionTake` validate against) and `take_count` is its length, not the number of staged segments. It is the host's view only: `sanitize_guest_project_view` strips it from every share-guest payload and patch. The host decides one with the document commands `AcceptSessionSuggestion {suggestion_id, take_index?, override_audio_checks?}`, `SkipSessionSuggestion {suggestion_id}` and `SelectSessionTake {suggestion_id, take_index}` (host only, one undo step each, `api/documentEdits.ts`); a held replace comes back as `needs_confirmation` in the accept reply instead of an error. The field is optional in `types/project.ts`.

### Unsure words

One server-owned line decides which transcript words are unsure: the config key `analysis.unsure_word_confidence` (default 0.7, `.agents/defaults/pipeline.yaml`; a word below it that is not suppressed). `config.defaults.unsure_word_confidence` reads it and `edits/unsure_words.is_unsure_word` applies it, so the mapped `unsure` flag, `low_confidence_words_tool` / `podcast transcript review`, the refine brief's `low_confidence_open_words`, the refine status route's `low_confidence_words` and the bulk-approve guard below always agree. The Studio client reads the flag (`transcript/lowConfidence.ts`) for Annotate, the walkthrough, the word inspector, Deliver's count and Review, so a suppressed word or a configured threshold follows the server.

Review lists every unsure word as its own item, whether or not the transcript check is open, once per `(track_id, source_id, word_index)`. Looks right on a word is `CorrectTranscriptWord` with the same text, which stores confidence 1.0 and sets `user_edited`; Fix text sends the new text. The decision that closes the last listed word then calls the mark-checked route, so a failed correction never marks the check. A Fix whose text changed re-marks a done check and re-waives a waived one, because the fingerprint is the word text.

- **Per word.** Every mapped `transcript.utterances[].words[]` entry carries `unsure: boolean` next to `confidence`. Guests who receive words (`guest_transcript(words=True)`) get the flag too, and a guest's pending rows keep `unsure_words` only under the same transcript-words grant (`guest_selects_transcript_words`); without it the sanitizer drops the list and keeps `unsure_count`; they see it, and the host-only mark-checked route (above) is the only way to record "checked".
- **Per pending cut.** Every `pending_edits[]` row carries `unsure_words` (`[{track_id, source_id, word_index, text, confidence}]`, in word order) and `unsure_count` (`len`). They list the unsure words whose span overlaps the cut's source range (half-open, a zero-length word padded like the transcript view); `TranscriptService.unsure_words_for` builds them from one index per transcript, so the cost is linear in the words plus a lookup per cut. A cut on the timeline clock (a blade or an exact range) names no transcript words and carries `[]` / `0`. Both fields are optional in `types/project.ts`, like `why`.
- **Bulk guard.** `ApproveEdits` takes `skip_unsure` (default `false`). When true, a pending cut that covers an unsure word is not applied: it stays pending and comes back in `held` as `{id, label, reason: "unsure_word"}` (the same reply shape as an acoustic hold, so `approved_ids`, `held` and the toast need no new path); every other edit applies as one history entry, and when nothing is left to apply nothing is saved and no history step is added. The server reads the saved words at approval time (under the project lock), never a list from the client, so a stale card that showed a clean cut cannot cut an unsure word in bulk. Bulk verbs send it or imply it: `podcast edit approve --all`, `approve_edits_tool` with `all_pending` or several `ids` (even when only one edit is pending), and a guest's multi-edit approve. The Studio client sends it for the Review Queue's Cut all; approving one cut by name does not, so "Cut it anyway" on a single card still cuts. A guest's `ApproveEdits` of more than one edit in one request is always guarded whatever the payload says (`document_sync/policy.must_skip_unsure`); an Editor guest can still cut an unsure word by approving that cut on its own, like the host. `skip_unsure` without `hold_blocked` still reports `held`.

  `ApplySuggestedActions` takes the same `skip_unsure` (default `false`, `ApplySuggestedActionsPayload`). When true, a `cut` or `shorten` over an unsure word is not applied: it stays pending and its id comes back in the reply's existing `held` list and in `held_unsure` (the ids held for this reason, a subset of `held`; `summary` counts them, "2 still pending (1 over an unsure word)"), the other sounds, including lowers and leaves, apply as one history step, and when every cut is held nothing is saved and no history step is added. The reply has no `{id, label, reason}` rows here: that call has always reported held sounds as ids, and the label of a pending cut is in the `pending_edits` row. Same rule as above: the server reads the saved words under the project lock, never a client list. `podcast edit apply-suggested` and `apply_suggested_actions_tool` send it for the all-suggested path and for several ids (not on revise); naming one id applies that cut, and a revise never sets it. Every guest `ApplySuggestedActions` is forced guarded, one id or many, whatever the payload says (`document_sync/policy.must_skip_unsure_suggested`); a guest who wants one such cut approves it on its own with `ApproveEdits` (an Editor may). The Studio client does not send `skip_unsure` for Apply suggested actions (the Review Queue's one-at-a-time Lower sends one id); its Cut all sends it on `ApproveEdits`. `apply_edit_plan` is not guarded: it is the host MCP tool `apply_edit_plan_tool` submitting the `ApplyEditPlan` document command, which only the Editor role holds (Commenters and Viewers get `share_capability_required`), and the guest MCP allowlist (`remote_mcp/allowlist.py`) offers no tool of that name (`tests/test_apply_suggested_unsure.py` pins both).

| `kind` | `sound_kind` values |
|--------|---------------------|
| `filler` | `filler` |
| `pause` | `pause` |
| `repeat` | `repetition` |
| `false-start` | `restart` |
| `sound` | `acoustic`, `laugh`, `possible_word` |
| `other` | `null` (missing or unrecognized reason) |

`types/project.ts` types the union as `PendingKind`. The Review stage keeps its own `DecisionKind` vocabulary and will need a mapping from `PendingKind` when it is wired. The table rows for `backchannel`, `breath`, `mouth_click` and `playful_phrase` in `cut_policy.py` are policy-only today: no reason code produces them, so they never appear as `sound_kind`. Unsure words are not a kind; a later slice sends them as a separate per-edit list.

### A/B audition window (pending preview)

The Review Decision card's A (original) and B (edited) are two files from one service function, `PlayService.play_pending_preview`, behind `GET /api/pending-preview?path&edit_id&mode=current|suggested&pad_sec` (guest twin `GET /api/review/{token}/daw/pending-preview`, MCP `play_pending_preview_tool`, CLI `podcast play pending-preview --padding`, guest MCP `guest_pending_preview`). The route, MCP tool and CLI only parse arguments. `mode=current` is A and `mode=suggested` is B; `mode=ab` (one WAV with a gap) stays for the agent and the inspector footer.

- `pad_sec` is the audio either side of the edit, 0 to 10 seconds (default 0.5, the inspector footer's window; the Review card asks for 3). Out of range is HTTP 422 on the routes and `pending_preview_pad_out_of_range` from the service. The window is clamped to the timeline: it never starts before 0 or ends after the last audio, so an edit near either end, or one shorter than the pad, plays what exists.
- Each cached file is keyed by its window, pad and edit, so two pads never share a file. `POST /api/pending-preview/warm?edit_id&pad_sec` renders the pad the card will play; a warm at another pad does not make the first press cached.
- If a rendering child exits unsuccessfully, the host `GET /api/pending-preview` returns HTTP 500 with `X-Sharecut-Error-Code: pending_preview_render_failed` and `Cache-Control: no-store`. Its JSON detail is `The preview could not be rendered. Try playing it again.` Child commands, stderr, and host paths stay out of the response.
- The response carries `X-Preview-Edit-Id`, `-Mode`, `-Pad-Sec`, `-Start-Sec`, `-End-Sec`, `-Edit-Start-Sec` and `-Edit-End-Sec` (seconds). `Start` / `End` bound the file on its own timeline: the current timeline for A, the timeline after the edit for B (B ends later or earlier than A by what the edit removed or paced in). For `mode=ab` the headers describe the first (Current) side's placement and the file is both sides joined with the gap, so they do not place the second half; ask for `current` and `suggested` separately to place both. `Edit-Start` / `Edit-End` are the edit on the current timeline, so A's edit playhead is `Edit-Start - Start` into the file and B's join is at the same offset. Numbers are fixed to three decimals. The CORS middleware exposes the names (`PENDING_PREVIEW_HEADER_NAMES`), so cross-origin guest and relay pages can read them. `PlayResult.start_sec` / `end_sec` from `play_pending_preview` (MCP and CLI JSON `start_sec` / `end_sec`) mean the same thing: for `suggested` the end is now the real end of the Suggested file, not the Current window end. A cached hit (`pending_preview_cached_wav`) renders nothing, but it re-hashes the edit, the transcripts and the mix state to find the file, so its cost grows with the transcript; it is not a bare file stat. The client is `gui/web/src/api/pendingPreview.ts` (`fetchPendingAuditionSide`, `warmPendingAudition`, `parsePendingAuditionSpan`).
- B applies only the target edit, on a private snapshot, the way Approve does, so a neighbouring pending edit is not in it. B does not exist for a split, an edit off the timeline, or a cut that leaves nothing to play (`pending_preview_unavailable` with the reason); the card shows the reason and disables B.
- A and B are comparable to each other, and B is the edit as Approve ships it (same ripple, paced pad, fades, mute and the premix headroom trim of the mix as it is now), pinned by `test_suggested_remove_preview_matches_the_approved_mix`. One limit: approving re-measures the premix trim, so a cut that removes the mix's loudest peak makes the real premix (and export) sit at a different gain than the preview mixed at; the cut itself is the same. A track whose FX chain has an adaptive effect (`loudnorm`, `afftdn`, `arnndn`, `acompressor`, `agate`, `deesser`) depends on the audio before the window, so its window renders with a 15 s lead-in that is dropped (`PENDING_WARMUP_SEC`); measured on a 4 minute loudnorm track the window then matches the whole-episode stem to about -50 dB (cold: about -16 dB), not sample for sample. A track with `arnndn` (a recurrent network that does not settle in seconds) renders from up to 600 s back (`PENDING_HISTORY_SEC`), exact when the window is within that of the start. An adaptive track also renders 0.5 s past the window (`PENDING_TAIL_SEC`), because noise reduction ends a render differently from the same point mid-stem. While `premix.wav` is fresh, the Current side is that window of the premix itself; with a stale premix, a fresh whole-episode stem of an adaptive track is cut instead of rendered and mixed at the track's staging gain plus fader, as the premix mixes it. Tracks without an adaptive effect match exactly. The window starts and ends on whole milliseconds, so every reader of the timeline maps it to the same first sample. A Suggested render is dominated by approving the edit on a snapshot, not by the segment renders (synthetic split: 2.0 s approve, 0.5 s renders). Neither passes the master stage (the loudness target and limiter that make `mastered.wav`), so their absolute level can differ from the exported file by one global gain. Copy says "what this edit sounds like", never that the audition matches the export's loudness.

### Pending edit `why`

Every `pending_edits[]` row also carries `why`, one plain sentence saying why the edit is suggested, or `null` when the card should show no line. `edits/tighten_hits.py::why_line` first returns `null` for any non-`None` author, including an empty string. For authorless rows, it interprets the reason and uses the track's optional `speaker` for named copy. Reasons it cannot interpret produce `null`. It states only what the reason records. A pause line states the full timeline gap recorded in the reason, not the cut or retained duration. No line says whether another speaker talks over the cut, because the decision does not record a clear result. It is derived from the facts recorded when the edit was proposed, so it can go stale until the next proposal. The mapper builds it per row without touching audio, so the list stays linear in the number of edits. Malformed or nonfinite pause gaps, and gaps of 3600 seconds or longer, produce `null`. The copy table is in [communication-philosophy.md](communication-philosophy.md#why-lines-on-suggestions). `types/project.ts` types it as `why?: string | null`.

A share guest chooses the `reason` of their own suggestion. Share-guest commands stamp `author` as `share:<id>`, so even a forged reason such as `filler:um` or `repetition:word:fake` gets no line. Classification uses only the reason, so an authored row can still have a recognized `kind` and `sound_kind` with `why: null`. Authorless agent and manual edits with readable, recognized tighten-shaped reasons can receive a line. No provenance marker distinguishes them from engine rows, so a line does not prove engine origin. Shared-link guests and the remote MCP's `guest_list_pending_edits` retain `why` on the pending rows they receive. Guest readership does not suppress a line.

## Generated TypeScript types

`gui/web/src/types/project.generated.ts` is emitted from the Pydantic models in `gui/schemas.py`, and `types/documentCommands.generated.ts` from the document-command schema (`DocumentCommandType`, plus the `DocumentCommand` name table that call sites use instead of string literals). `scripts/export_project_types.py` writes both, Biome-formatted, from `make schema-export`; `--check` (run by `make generated-check` and the `frontend` CI job) fails on drift. `types/project.ts` re-exports the generated shapes and narrows the loose `dict[str, Any]` view fields. The generated types are optional for fields with a Pydantic default, so the server's always-sent fields are re-required in `project.ts`.

## Progress

Shared contract: [progress.md](progress.md). CLI adapter flags: [cli-progress.md](cli-progress.md).

The Prepare stage (Getting ready rows and the Advanced steps sheet) replaced the
Pipeline panel. Browser coverage lives in `e2e/prepare.spec.ts`, and
`e2e-compat/reachability-sweep.spec.ts` sweeps the Prepare stage for reachable
controls.

`POST /api/pipeline/run` accepts a run-only `force_transcribe` (Studio **Re-transcribe** sends it) that re-runs ASR over existing transcripts without persisting `transcribe.overwrite`; Re-transcribe also sends `overwrite_edited` (replace hand-edited transcripts even in Batch mode; warned and counted as "N edited overwritten"; the run's "before pipeline run" undo entry restores them) only after the user accepts a prompt naming the tracks in `edited_tracks` from `GET /api/transcript/vocabulary`; declining starts no run, and with no edited tracks it sends `false`; ordinary runs reuse stored transcripts. A run-only `retime_words` (Studio **Re-time words** next to the Pipeline tab's Precise word boundaries field) re-times reused transcripts from their ASR cache without re-running Whisper — it also turns on `transcribe.forced_alignment.enabled` for that run — and sends the same `overwrite_edited` confirmation for any edited tracks before starting. The DAW viewer runs the pipeline in-process via `POST /api/pipeline/run` and streams progress over SSE (`GET /api/pipeline/events`) using the same `ProgressReporter` protocol (step `current/total`, live `message` headline, per-step elapsed, `fail`/`cancel`). A failed job's snapshot carries `error_code` and, for `model_needed`, `error_model` (the 409 `model` fields); their `error`, `message` and failed step `error` read as the plain `{label} is not downloaded.` (`{label} needs an update.`), the install command stays in `error_model.command`; host routes only, guests keep the fixed copy. During quiet steps the SSE stream also emits ~1s `status` snapshots (fresh `elapsed_sec`). Those keepalives **do not** bump `last_progress_at` — only domain events (`start` / `update` / `message` / `heartbeat`) and the job reporter’s `ElapsedProgressMixin` heartbeat (one event on the innermost open task after 5 s of silence) do. The viewer keeps a session-wide subscription (`usePipelineJob`) so the **Pipeline tab**, **StatusBar**, and **phone Listen chip** stay live — there is **no separate progress log panel**. Job SSE is the progress plane only: the project changes a run saved reach the tabs as an `ExternalMutate` document event emitted by `PipelineService.run` when the run ends ([session-sync.md](session-sync.md)), so the Review Queue updates at job done without a refetch. `usePipelineJob` runs no status poll while its attached job's SSE stream is open, falls back to a 1s `GET /api/pipeline/status` poll only while that stream is down (from `onerror`, or 5s without any frame since the server sends a 1s keepalive, until a reconnected stream delivers a frame; a status result (down poll, stream-down re-check, or the refetch after a `done` frame) or pending reconnect that lands after any stream has attached is dropped, so it never replaces the live stream), and separately runs a 5s discover poll that keeps `activityJob` and the running count current for jobs started elsewhere. A frame on the attached stream updates `activityJob` only when no other job is the live primary, so while another job (for example an agent job) is primary, its StatusBar chip, including its move to `ok` / `error`, refreshes at that 5s discover cadence rather than every second. Starting render preview, bounce, export or **Analyze** from Studio seeds `activityJob` with the job's start snapshot, so that new foreground work becomes the primary even over a live agent job; later stream frames follow the rule above. Phone Listen reuses StatusBar `status-pipeline` chrome. Chrome follows the progress rubric:

- **Headline / phase** from `message` (primary when a bar would be dishonest)
- **Determinate bar** only when `total` is set (`role="progressbar"` + `aria-valuenow` / `aria-valuemax`); otherwise a pulse + `role="status"` live summary (no `n/?` fake units)
- **Elapsed** as a companion; Cancel remains on the Prepare stage
- **Failed** vs **cancelled** are distinct status labels
- **Stale:** if `now − last_progress_at > 15s` while running, chip/panel show “last update Ns ago” next to the headline (dim companion, not accent). The pulse stays; elapsed still ticks as a companion; no determinate bar movement. A new domain event or job-reporter heartbeat clears the copy. Pipeline tab live region does not include the ticking stale string (one-shot stall/resume announce only). `last_progress_at` is wall-clock `time.time()` on the Studio host vs client `Date.now()` — same-machine Studio is fine; a remote client clock ahead by more than 15s can show false stale.

Fan-out of in-process **host MCP** onto this job/SSE plane uses `compose_progress`. Studio `create_app` registers a wrap-level **agent job** sink next to the publish-only SSE sink: the first `update` / `message` / heartbeat or elapsed ≥ 1s creates a `kind=agent` job (`tool_id`, headline) so StatusBar / phone chip show it without a prior `POST /api/pipeline/run`. Instant tools never flash a chip. Host MCP `pipeline_run` in the Studio process goes through `JobManager.start()` (same single-flight lock as `POST /api/pipeline/run`; busy is an error). Other agent jobs do not take that lock; the manager may hold one pipeline-slot job (`pipeline` / `render_preview` / `bounce` / `export` / `analyze` / `split_speakers`) plus N agent jobs. StatusBar shows the most recent running job and a count badge (“2 activities”) when more than one is live. Chip copy is **Pipeline** only for `kind=pipeline`; otherwise **Activity**. The Pipeline tab lists pipeline jobs in the summary; while bounce/export/`render_preview` occupy the slot it disables Run, shows Cancel, and a slot-busy notice (no Cancel surface for agent jobs); while **Analyze** (`kind=analyze`) runs it disables Run and shows Cancel plus Analyze's own progress (phase headline, `n/N tracks` bar, elapsed) instead of the notice. `fail` shows a short first-line headline (no stack traces or host paths). Typer `install_cli_progress` is not installed by the GUI — **cross-process CLI adopt remains ROADMAP**; GUI-started pipeline/bootstrap jobs are live today.

Guest-initiated long work (remote MCP / guest tools) does **not** use host `/api/pipeline/events`. `install_guest_tool_progress` composes MCP `notifications/progress` (when `params._meta.progressToken` is set — Streamable HTTP SSE, then the JSON-RPC result) with a live guest-WS sink keyed by **that** share token. ShareCut Studio share mode demuxes `plane: "progress"` on `daw/ws` into the StatusBar activity job (phone Listen shows the chip for guests; the chip is non-interactive because the Pipeline tab is host-only). Payloads are whitelisted (no host paths); updates coalesce ≤4/s; instant tools never flash.

Model downloads (`/api/bootstrap/*`) use the same job plane and one client owner: `ModelsProvider` (`gui/web/src/models/`). The job snapshot's `download` (`component`, `bytes`, `total`) fills the byte bar on that model's row (`total: null` draws an indeterminate bar), the other components of the run show as queued, and the terminal snapshot's `result.results[id]` supplies each failed row's typed `failure`. The server has one download slot: a second run answers 409 `bootstrap_job_running`, and the UI disables every other **Download** with a reason instead of queueing. The wizard, the **Models** dialog and the Pipeline, Whisper and Split speakers download buttons all call the provider's `download`; none starts a bootstrap job of its own.

Deliver's Export and Bounce providers apply a failed Cancel reply only when its
job ID still matches the running job. The current job keeps its pending
cancellation when an older reply fails; its own failure shows the error and
permits another attempt.

## MCP progress

Host MCP installs a choke-point wrap on `add_tool` / `call_tool` so every tool opens `progress_task` and binds a reporter (best-effort `notifications/progress` when MCP Context is available). When Studio is in-process, that wrap also fans into the job manager as above. Guest remote MCP (`/mcp/{token}/mcp`) reads `params._meta.progressToken` and, when set, streams `notifications/progress` over Streamable HTTP SSE before the JSON-RPC result, plus the token-scoped guest WS plane — not host SSE. Domain code uses `resolve_progress()` / `progress_task` — do not hardcode `NullProgress()` at MCP edges. See [progress.md](progress.md).

## Render preview and history

`render_preview` records history snapshots (`operation: render_preview`) so envelope changes from `mix_with_music` are undoable.

## Suggested GUI flows

1. **Load project** → `list_clips` + `render_status` + `history_list`.
2. **Edit** → mutation MCP tool → refresh clips + history groups.
3. **Inspect step** → `history_diff` on selected group indices.
4. **Undo** → `history_undo(rerender=true)` → `render_status`.
5. **Why was this cut?** → `list_applied_edits` at playhead time.

## Read-only DAW viewer

The viewer, its launch, routes, decisions, timeline layers and frontend internals are in [gui-viewer.md](gui-viewer.md).

## Static assets and guest surfaces

- `GET /favicon.svg` is served from the built `gui/web/dist` root (not only `/assets`).
- Hashed files under `/assets/*` use `Cache-Control: public, max-age=31536000, immutable`; HTML (`/`, `/r/{token}`, `/rec/{token}`) stays `no-cache`.
- `GET /r/{token}` and `GET /rec/{token}` for an unknown, revoked, ended or wrong-kind token still return 200 with the app shell (no share hooks; only a fixed title, `noindex` meta and `<base href="/">` are injected, so the body is the same for every dead token). The guest app then shows its invalid-link cover ("Ask the host for a new link."); the `/api/review/{token}/*` and `/api/rec/{token}/*` endpoints keep their coded 4xx JSON.
- JSON responses (project, waveform status, …) are gzip-compressed when the client accepts encoding (`GZipMiddleware`). Document `/api/host/ws` (and guest dual-plane WS) negotiate permessage-deflate.
- Guest ShareCut Studio (`share:{token}`) does **not** poll `/api/pipeline/*` — pipeline status is host-only.
- Guest `daw/project` keeps a zeroed `edit_impact` stub (safe for the Stage bar badges), empties
  `social_clips`, and strips transcript `words[]`; guest waveforms are the host's raw-media pyramid tiles (no stems, no PCM).
- Record lobby (`/rec/{token}`) fetches `GET /api/rec/{token}/bootstrap` then
  connects `WS /api/rec/{token}/ws` (Join / Consent / roster / WebRTC Signal)
  and, with `join`, `GET`/`POST /api/rec/{token}/upload` for full-quality recording resume
  plus `DELETE` to revoke an ACK'd room-tone bed.
  Host DAW subscribes to the record plane on `WS /api/host/ws` and exposes
  `GET /api/record/state` + `POST /api/record/command` plus
  `GET`/`POST`/`DELETE /api/record/upload`. Mix-minus plays remote
  tracks only (`gui/web/src/audio/mixMinus.ts`). It never loads `/api/review/`.
Transcript utterance mapping batches source-to-timeline word spans once per
track and indexes the words for repeated utterance overlap queries. The API
retains original transcript word order and indexes, including suppressed and
zero-duration words; views that omit words skip this work. Word spans map
through `SessionTimeline.map_word_spans`, the same helper export/doctor
timebase QC uses, so a zero-length word at a kept clip's source end is
mappable in both. Edit-boundary `cutaway_word_ids` ask the same helper and
leave out a zero-length word it maps onto the left clip, so they cannot drift
from the word views.

### Transcript check routes

Both routes are host-only; a guest or an unauthorized remote client gets the usual `authz_denied` refusal (403) and nothing is written. Both answer with the same `TranscriptRefineStatusView`: `status` (`pending` for open, `done` or `waived`), `fingerprint` (the current transcript fingerprint, for `expected_fingerprint`), `clear`, `stale` (a record whose transcript text changed since), `mode`, `source`, `notes` (the waiver reason when `waived`), `updated_at`, `low_confidence_words` (words below `low_confidence_threshold`, the project's one unsure-word line, 0.7) and `hint`.

- `GET /api/transcript/refine/status?path=` reads the gate without writing.
- `POST /api/transcript/refine/done {path, notes?, expected_fingerprint?}` records refine-done for the human through `TranscriptRefineService.mark_checked` with source `user` (CLI `refine-done` and MCP `transcript_refine_done_tool` call `mark_done` directly: they write and return the raw record, unless a sent `expected_fingerprint` is stale, in which case they refuse and write nothing). It is idempotent: while the record is `done` and current, a repeat writes nothing and returns the same `updated_at`, and a `notes` value sent with the repeat is ignored (not recorded). `notes` over 2000 characters is refused with a 400 (code `gate_text_too_long`) even on a repeat. When `expected_fingerprint` (the `fingerprint` of the status view) is sent and is not the transcript's current fingerprint, the call is refused with a 409 (code `transcript_changed`, "The transcript changed after you reviewed it. Review it again, then mark it checked.") and nothing is written, even on a repeat; the server compares it inside the transaction that writes the record. Omitted, behaviour is unchanged. Review sends it on the closing mark and on a re-mark after a Fix, and shows the review-again message on a 409. After a waiver or a stale record it writes `done`.
- `POST /api/transcript/refine/waive {path, reason}` takes a `reason` of up to 2000 characters (longer is a 400, code `gate_text_too_long`). "Cut anyway" sends the reason "Approved after listening in Review" and is recorded as `waived`, not `done`.

The web client is `loadTranscriptCheck` / `markTranscriptChecked` in `api/transcriptCheck.ts`.

### Transcript find and replace

The host Transcript toolbar and command palette open a form to review literal replacements across source recordings. `POST /api/transcript/replacement-preview` delegates to `TranscriptService`; the `ReplaceTranscriptMatches` document command revalidates the preview and applies the complete set as one Undo action. See [the find-and-replace guide](daw-editing.md#transcript-find-and-replace) for matching rules, source scope, timing warnings, and queued delivery.

### Exact-source word timing adapters

Host transcript word views include `timing_target` with the stored transcript's
`track_id`, nullable `source_id`, and `word_index`. This target identifies the
transcript that supplied the word, including suppressed-only rows. It does not
infer a recording from clip placement or word time.

`POST /api/transcript/word-timing-context` accepts `{path, target, expected_word}`.
`expected_word` contains the displayed `text`, `start`, and `end`. The host-only
route delegates to `TranscriptService.word_timing_context` and returns authoritative raw
media, neighboring words, a source-clock window, and a stale dependency token.
A changed word returns 409. Missing raw media returns 404. Existing finite import
timings may be negative or reversed so the host can open their repair context.

`SetTranscriptWordTiming` accepts `{target, expected_token, start, end}` and saves
through `TranscriptService.set_word_timing`. Its Applied delta includes changes to transcript words,
tracks, clip rows (an ignored word is a mute on them), and render status through `TRANSCRIPT_AUDIO`. Stale timing dependencies
become document conflicts. Guest shares cannot submit this command.

`GET /api/audio` accepts optional `source_id` only for `kind=raw` or `kind=track`.
`PlayService.resolve_transport_path` resolves that exact recording through
`recording_audio_path`, with workspace containment. Omitting `source_id` selects
the track's primary media. Host authorization and HTTP Range streaming remain
part of the existing route.

### GUI audit refinements

Shared dialogs mount outside inert app chrome. On phones, Pipeline parameters
use the shared modal and suspend while model-download confirmation is open.
Guest status summaries for Pipeline remain readable without offering
unavailable host panels. Editable chapter and reply fields have persistent
accessible names; long comments, vocabulary terms, and inspector metadata wrap
within their panes. The guest review reading column stays within its shell;
native comment fields shrink within that column even when the browser gives
them a larger preferred width. Status pills and muted/resolved metadata use
readable text roles rather than reducing the opacity of the entire surface. See the
[GUI surface audit](gui-surface-audit.md) for tested states and limitations.

Transcript edit-boundary gestures freeze the starting source bounds and button
rectangle. The glyph retains its inline size and follows the raw horizontal
pointer movement. Hold Shift for fine motion of 1 ms per CSS pixel; switching
Shift during a drag keeps the accumulated source offset continuous. Legal source
bounds clamp the proposed offset and show limit feedback without pulling the
glyph away from the pointer.
A gapped pair's mark explains that this gap has no roll seam and that the mark
trims the left clip's end. The host precision dialog repeats this reason;
opening it only reads boundary context and does not change the project.
A bounded body portal displays roll/trim intent, precise delta, restored-word
side, legal limits, and cancellation instructions without changing transcript
flow. Focus departure, ancestor scroll, or resize cancels stale placement.
Dragging past the activation threshold commits on pointer up; a tap or native
keyboard activation opens the host-only precision dialog instead. The window
keymap leaves bare Space/Enter on a focused native button to that button;
Space on the timeline canvas still controls transport. It edits a
signed offset with 10 ms and 1 ms nudges and shows source positions, legal
bounds, and full versus partial archived-word restoration. Its **Listen current**
and **Listen proposed** controls play separately rendered windows of the affected
track through the existing transport. Changing the draft or closing the dialog
stops that local audio. Apply carries the audition revision so an intervening
change conflicts before save; an offline command is labelled queued for sync.
Cancel and an unchanged Apply create no project history. Pointer cancellation,
lost capture, window blur, Escape, and unmount discard a drag preview and
release capture, listeners, and drag locks.
Pending commits block another gesture on that handle and show saving feedback.
Rejected commits show a scrollable alert with Dismiss and focus restoration.
Focused component tests, live-project touch and geometry tests, and word-bearing
Storybook browser tests cover these behaviors at desktop and phone widths.

Pending edit review actions keep one state and command owner. On phones and
sideways compact layouts, the selected action card portals into the compact
inspector's pinned header, so Approve and Reject remain available while the
inspector body scrolls. Timing stays in the peek strip or expanded inspector.
Outside compact mode, the card floats beside the selected timeline region,
between the sticky ruler and marker lane and the bottom panel. It re-places
itself on scroll, window resize, and any size change of the region, the card,
the compact sheet, the marker lane, or the bottom panel, so a comment that
grows the marker lane or a Script divider drag moves it without a scroll. While the
tablet's regular inspector sheet is open, the card stays out of the canvas
(the sheet covers it) and the sheet's own Approve and Reject carry the review.
The card keeps the same portal host across relocation, preserving recovery
drafts and busy/error state. Relocation restores the currently focused control
only if it was inside the card; body and external control focus stay unchanged.
The host falls back to the body when compact chrome is absent and is removed
when the region unmounts.
Long supplementary errors scroll within the pinned card.

### Provisional recording timeline

A dedicated timeline leaf shows an aggregate current-take band and recording
needle while recording/paused, independent of the Record stage and saved
track lanes. It uses the server's Land-compatible take origin and a monotonic
recording clock. Pause freezes it; Stop clears it; Land supplies real clips through
the existing document refresh. Its overflow is visual scroll extent only: the
ruler and seek bounds continue to describe saved media. On fixed-playhead
phones, users can pan to the provisional needle beyond the saved-media end;
that visual-only pan does not seek or recenter playback. See [Recording
session](recording-session.md#live-take-monitoring-on-the-timeline).

## Selected ranges in the GUI

Owner: [daw-editing.md § Exact selected ranges](daw-editing.md#exact-selected-ranges). This section keeps only the selected ranges in the GUI facet.

Exact selected range pending edits expose their canonical disjoint timeline footprint. Source timing controls do not retime them. Pending Suggested audio renders an ephemeral project through the exact range kernel; it preserves timeline gaps and unselected lanes.

`rangeSelection.ts` resolves timeline/transcript selections into sealed targets.
`rangeActions.ts` supplies the same five action descriptors, permission reasons
and live execution guards to the desktop bar and phone sheet. Numeric bounds and
explicit lanes share this path. Failed/stale actions retain selection with a
readable reason; in-flight mutations block duplicates. Play uses the owned
transport preview; Bounce captures a detached target with ordinary configuration.

The idle desktop inspector collapses and restores when an inspector object is
selected. The idle inspector lists **Edits in removed audio** (pending edits with no place on the timeline); every
review-required pending item remains selectable in the Review Queue. The transport holds the single mix freshness
cue (**Mix out of date**, which hosts never have to click); the footer retains transcript,
pending, comment and job status.

Exact pending GUI previews use the same rendered pending preview as every other pending edit, preserving each island and the gaps between them. Target comparison ignores JSON object property order from the server while preserving every sealed value and ordered array. The adapter discards prepared audio, and says so inline, if the edit (exact target, or an ordinary edit's bounds), mix, project, or playback permission changes before it arrives, or the edit is approved or rejected meanwhile. Exact pending titles carry Cut/Mute without a duplicate Type fact, keeping the timeline intervals and selected track value above the phone preview footer. Review reasons for guests without `edit` remain readable beside the disabled controls on desktop and phone; pending labels wrap so their full identity and status stay visible. Exact proposal review controls are enabled for the host and `edit` guests and remain visible with a disabled reason for other guests; source timing and snap controls are absent. Applied exact Cut/Mute ticks retain every recorded timeline edge, including holes and repeated-source occurrences, rather than falling back to the first matching source clock.

While a guest owns a rendered source preview, the loaded proxy transport pauses
and yields playback, clock, and meter ownership to the existing HTML audio
transport. The proxy remains loaded and can resume after preview release. Preview
position stays local and does not move or publish the session playhead.

Exact pending Current/Suggested/A-B supports the full mix (`premix`); isolated
source requests reject before playback. Suggested cache identity includes every
track's current render and mix state. Guest range Play never renders stems and
requires a fresh published mix. Host isolated and guest full-mix extracts use
separate private paths and atomic publication.

Reviewed exact MUTE proposals require interactive host approval. Rendered pending previews and host processed timeline playback honor clip-local mute envelopes; guest source-proxy timeline playback currently omits them. See [reviewed bleed ranges](transcript-reconcile.md#reviewed-bleed-ranges).

### Applied edit recovery

The Applied edit inspector offers **Restore** only for ordinary source MUTE archives with valid source clocks and edit access. Cuts and exact ranges show the whole-action History Undo guidance, including other edits in the action and the need to undo later actions first. **Open History** opens the current History tab without running Undo. Numeric source and timeline seam displays remain unchanged. The backend validates the top-level source bounds and every supplied per-track span before history starts. Malformed mappings or nonfinite, negative, equal, or reversed bounds return `local_restore_requires_history` without changing the saved project, history entries, transcript caches, or render artifacts. Normal document-session setup can initialize journal and lock files before Restore runs. See [History](history.md#individual-restore-and-whole-action-undo).

### Completed cut publication

Studio's trusted interactive adapter supplies manual intent for cut gestures and
explicit approval. This bypasses acoustic vetoes, including peer speech, while
current placement, source identity, pad hulls, bounds and receipts remain mandatory.
There is no confirmation-flag retry. Programmatic document commands, CLI and MCP
retain fresh acoustic assessment. The domain completes cuts privately; the existing
workspace mutation owns their single publication and History entry.

Moving a clip without dragging, and the panel size controls, are described in [daw-editing.md § Move clips without dragging](daw-editing.md#move-clips-without-dragging).

## Current-occurrence automatic reduction

`GET /api/clips/{clip_id}/bleed` is an explicit host inspection with project path
and track identity. The adapter validates its DTO and keeps the exact returned
opaque Restore target. Timeline spans are already editorial seconds; source
bounds are shown separately. Inspection is scoped to one active occurrence,
project opening and dependency snapshot. It is not an all-visible-clip cache.

`clipBleedSession` owns read generations, selected region, action state and exact
acknowledged Undo. The Edit stage Inspector sheet (`stage/edit/bleedSections.tsx`) opens and retires
the session with the selection, on desktop and phone. Local `bleedAttenuation` selections carry occurrence and region keys,
never the target, and are omitted from session wire state. Refresh, reopening or
changed occurrence inputs retire old targets. Restore uses the existing command
bus and track mutation queue, rechecks admission inside that queue, and sends the
unchanged target through `RestoreClipBleed`.

Proxy manifests now pair complete legacy and occurrence artifact descriptors
with the exact displayed project basis. A nonempty occurrence choice always
binds its artifact, including inactive or unity choices. The atomic client
snapshot owns fetch, decode and scheduling identities. A mismatched variant pair
holds timeline audio instead of falling back to stale premix audio. Source
preview retains its existing explicit transport ownership. A compatible snapshot
with unchanged schedule identity avoids restarting sources unnecessarily.

Derived manifest publication changes the project file certificate without
advancing editable History. Existing document recovery admits that certificate;
it must not trigger an endless manifest refresh or proxy save cycle.

Host share preparation publishes the complete manifest after all track upload
attempts, including their metadata mutations. After successful publication, an
unchanged guest manifest read reuses that generation without saving or rendering.
Failed preparation remains best-effort and logs a host warning. A later edit can
require a new generation.
