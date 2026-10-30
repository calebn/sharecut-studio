# Edit history and undo/redo

### Decision: History intents belong to a project opening

<!-- decision
id: D-studio-history-intent-lifetime
status: accepted
date: 2026-10-12
decided-by: issue #1263 implementation
evidence:
- Issue #1263 acceptance requires same-path reopen and project navigation to retire unsent history intents across durable replay.
- gui/web/src/services/commandQueue.historyLifetime.integration.test.ts covers scope retirement, offline refusal, older queued edits, and failed history-row cleanup.
- gui/web/src/services/offlineQueue/drainOfflineQueue.test.ts and gui/web/src/services/commandQueue.integration.test.ts cover replay policy and ordinary command ordering.
manual-review: verify production IndexedDB history never replays after cleanup failure and ordinary edits retain FIFO.
-->

An Undo or Redo belongs to the project opening where it was pressed. Studio
sends it only while that opening is still current. Closing and reopening the
same project or switching projects retires an unsent move before it can reach
the server. A history command waiting behind older queued edits is refused
until those edits are sent. Undo and Redo are unavailable offline.

The browser may retain a history command briefly in its IndexedDB queue to
reserve its place relative to other edits. History commands are never replayed.
Browser ownership keeps later live sends and replay behind an active history
move until its response and cleanup settle, including sends from another tab.
If the originating tab closes, the browser releases that ownership. The
abandoned row remains ineligible for replay. If removing an inactive row fails,
later drains still skip it and continue with ordinary edits. Browsers without
this ownership support refuse Undo and Redo while ordinary edit recovery stays
available. If the server may have received a move but its response
does not arrive, Studio reports that the outcome may be unknown. Check History
before trying again.
Podcast MCP uses **non-destructive editing** at two levels:

1. **Source media** — Files in `raw/` are never overwritten. Approved cuts change clip placement or mute envelopes; FFmpeg renders that saved structure. Pending decision labels never remove audio.
2. **Editable state history** — Tracks, transcripts, edit decisions, envelopes, and processing chains are snapshotted so you can move backward and forward through changes.

Cut application completes and assesses an unpublished project copy before adopting it
once inside the existing workspace mutation. A refusal publishes no provisional
archives, history snapshots, or render outputs. Stored proposal bounds are consumed
exactly, including unsnapped bounds; preparation owns optimization. See
[inaudible cuts](inaudible-cuts.md#behavior).

Editor panel height is a browser preference, not an episode mutation. A canceled
splitter preview restores its prior explicit value or absence; resize and reset
create no project History entry. Finite out-of-bounds saved heights are clamped
and normalized when the editor initializes.

CLI undo and redo use the shared command progress scope. Progress stays on stderr, and their results stay on stdout.

## Storage layout

Local retained-bleed alignment decisions are part of `editorial`, so undo/redo
restores phrase clip placement and `auto` / `manual` / `declined` choices together.
Preview is read-only. Saving a declined preview is an ordinary history mutation
without a clip move; resetting it to auto permits fresh evidence-based planning.
Domain application rejects a stale plan before making any edits.
Conflicting local correction footprints abstain before application. Manual
per-clip recorder choices are inherited by surviving same-source subclips in
`meta.ingest_alignment`; editable snapshots restore those locks with the geometry,
including after an explicit scoped override or ordinary split/punch.
Saved local choices use an opaque recording digest so pinning the same media
while moving a clip between lanes cannot release a manual/declined phrase hold.
Choices and their digest are restored together from editorial snapshots.

```
episode/
├── raw/                          # untouched recordings
├── episode.sharecut          # current state + history index
└── history/
    ├── index.json                # cursor + entry list
    └── snapshots/
        ├── abc123.json           # editable-state snapshot
        └── def456.json
```

Each snapshot stores a **full copy** of editable v2 sections (not diffs), so undo/redo and arbitrary cursor jumps are O(1):

- `sources`, `timeline` (tracks + clips), `editorial`, `transcripts` (per_track + combined)
- `mix`, `social`, `feed` (podcast listing pins, guid and first export time; see [podcast-feed.md](podcast-feed.md)), `review` (timeline comments), `render_last_completed_step`

Undo/redo restores the snapshot and **`ProjectStore.commit()`** writes `episode.sharecut`.

History normally retains up to 400 recent snapshots. Pruning removes only the oldest
undo entries, keeps adjacent `before …` / `after …` edit pairs together, and never
drops redo entries. If the cursor is old and its redo tail exceeds 400 entries, history
temporarily exceeds the limit. Explicitly pruned snapshots are removed only after the
canonical project file is replaced, so a failed save cannot delete a referenced snapshot.
Prune cleanup accepts only the 12-character lowercase hexadecimal IDs generated by the
history writer and checks that each resolved snapshot path stays in `history/snapshots/`;
malformed IDs and symlinks outside that directory or the workspace are left in place
with a warning.
If another writer advances the cursor and prunes a long job's checkpoint entry, that
job's next merged save reports a history lineage conflict before reading the deleted
snapshot; it must rerun from the saved project.
The separate history index and transcript caches are rewritten only when their desired
contents differ; a missing or damaged mirror is repaired on the next commit. A project
whose saved history is empty (never recorded, or a legacy `"history": null`) adopts
`history/index.json` on load and commit only when the index's current entry snapshots the
project's editable state (`project.store.match_history_to_project`). An index whose current
entry holds other state was left by a commit that never landed, for example a process
killed between `record(after)` and `save_project` (#576,
`test_document_submit_crash_recovery.py::test_a_crash_before_the_first_commit_adopts_no_phantom_history`).
It is ignored with a warning, the
next commit rewrites it from the project's history, and its snapshots stay behind as
harmless orphans. The warning names the reason: a current entry that holds other state (a
commit that never landed), a current snapshot that is missing or unreadable (damage or an
out-of-band delete), or no current entry. Snapshots are compared in their saved JSON form
(`project.store.snapshots_equal`), excluding `render_last_completed_step`.
The pipeline cursor is saved and restored with each snapshot, but advancing it
alone does not create an undo action or invalidate an otherwise matching index.

Pipeline run logs stay on the project file and are not reverted by undo.

`--expected-head` (Undo toast, `undo --expected-head`) treats `render_preview` entries recorded after the named entry as render-only: a preview render that lands behind an edit does not make the toast stale. Any other entry after it still does (`history.manager._behind_render_only`). When the caller names the current head and it is a `render_preview` entry (toolbar Mod+Z after auto refresh-mix, at the tip or mid-history after an earlier Undo), undo rewinds over those previews first so one step reverts the edit that triggered them (`ProjectHistory.undo_origin`). The undo origin also sets `can_undo`, so a history with only `render_preview` entries above the baseline reports nothing to undo, and an `--expected-head` that names a preview rewinds past it the same way.

`ProjectHistory.edit_head_id` names the latest entry at or below the cursor that is not a `render_preview`, so something that depends on the edits, such as the Deliver page deciding whether a finished export is out of date, is not moved by a mix rebuild landing after an edit or an Undo. An export job reports it as `result.edit_head_id`, read at the export's checkpoint, after any wait for a mix rebuild; the page derives the same entry from `history.groups` (`editHeadOf`), counting the `before` entry of a `render_preview` mutation pair as the edit state.

`edit apply-suggested --revise` (`HistoryManager.tip_entry_index`) finds the latest `apply_suggested_actions` entry while the cursor is at the tip and only `render_preview` entries follow it, goes back to just before it and re-applies the same batch with the overrides. The batch entry's `params.sounds` (each sound's id, label, track, timeline start and action) lets an agent see the batch it can still revise. Nothing else is undone, and the cursor returns to the tip if the re-apply fails.
A run records its starting editable state if it differs from the current snapshot,
then one snapshot per changed editable state. Disabled focus and tighten steps,
and a music-free mix step, still commit their progress but add no snapshot.
The final run save also reuses the current snapshot when editable state is unchanged.

History publication is ordered: a new snapshot is written completely before
`history/index.json` is updated. The index is published with an atomic replace,
so concurrent readers observe either the previous complete index or the new
complete index, never a truncated JSON file. Code reads the index through `project.store.read_history_index` (absent: `None`; unreadable or invalid: `ValueError`), and each caller chooses its fallback.
`HistoryCheckpoint` in `project/history/rollback.py` owns failure recovery for both mutation
records and merged saves. `HistoryRollbackPolicy.OWNED_WRITES` uses entry IDs and
index payload ownership to preserve another writer's history.
`HistoryRollbackPolicy.LOCKED_CALL` captures snapshot-file IDs while the caller
holds `project_commit_lock` through the entire save, then removes the directory
difference after restoring the index. It covers orphan files from failed index writes.
Merged saves retain the job's history as their memory baseline and use the saved
project's history as the fallback for a corrupt index.

A long job's entries (`before pipeline run`, `after <step>`, `after pipeline run`, the merge entry) are recorded inside `ProjectWorkspace.save_merged(history_label=...)`, in the same locked merge and commit. On a conflict, or a commit that fails before the project file is replaced, the in-memory history and `history/index.json` are restored, and every snapshot file written during that call is removed (`project.store.rollback_history`; a snapshot is deleted only once the index no longer lists it). Cleanup failures are logged and the original error still propagates. If the file was replaced and only the transcript cache write failed, memory adopts the saved state. If the project file cannot be stat'ed after the failure, only the in-memory history is restored; the index and snapshots stay on disk, because an orphaned snapshot is harmless and a deleted referenced one is not. A corrupt `history/index.json` does not stop the job: a failed save restores it from the saved project's history. An undo, redo or goto by another request during a job, including before a pipeline's first step, conflicts at `history.lineage` rather than interleaving entries; the message says an undo or redo changed the project and asks for a re-run. Two undo/redo moves to different entries with no new entries on either side conflict at `history.cursor` with the same message. These checks assume every writer of `episode.sharecut` and `history/` holds `project_commit_lock`, as every in-tree writer does in every process (#213).
`run_mutation` compensates its own failure the same way (`project/history/rollback.py`: `take_history_checkpoint`, then `rolled_back_on_failure` around `record(before)` and, with `on_not_landed`, around `mutate`, the audio bookkeeping, `record(after)` and the commit). If `record(before)`, `mutate`, the audio bookkeeping, `record(after)` or the commit raises (any `BaseException`, including a commit-lock timeout or `KeyboardInterrupt`), it takes `project_commit_lock` once and, in that one hold, checks whether the commit landed (`project.store.commit_landed`) and rolls back: it puts `history/index.json` back to its pre-call payload, deletes the snapshots this call wrote (`project.store.rollback_own_history`) and restores the in-memory `project.history`, so the redo branch comes back and no dangling `before` entry is left. The history is kept when the commit landed (the project file revision changed and only a later write failed). When the project file cannot be stat'ed (outcome `unknown`), the index and snapshots stay on disk and only `project.history` is restored in memory. When another writer recorded on top of this call's entries, or the rollback itself fails, the index on disk is kept and `project.history` adopts it, so the next commit does not overwrite it; a warning is logged. The pre-call history is kept instead when the index is unreadable, or when the pre-call history was empty and the index's current entry does not match the saved project (the load-path rule in § Storage layout, #576). The index counts as this call's when it equals the pre-call payload or one this call wrote; that is sound because every entry id is a fresh uuid, so no other writer can produce an identical payload. Cleanup failures are logged and the original error propagates. `ProjectWorkspace.record_snapshot` and `project.history.manager.record_if_changed` record and commit through `project.history.manager.record_and_commit`, which rolls back the same way. `roll_back_history` returns a `RollbackOutcome` (`landed`, `unknown`, `restored`, `kept`), and `rolled_back_on_failure(..., on_not_landed=...)` runs its callback unless the outcome is `landed`, also when the rollback itself raises; a secondary `BaseException` from recovery, notification, or logging cannot replace the active original error. `run_mutation` passes a callback that restores the in-memory editable state and `project.render` to their pre-`mutate` values, and certifies complete restoration only when that callback returns. A failed editable/render restore downgrades history `restored` to `unknown`; it never upgrades `kept`, `unknown`, or `landed`. A landed commit (only the transcript mirror failed) keeps the saved state. On `kept` only `project.history` adopts the index on disk; the editable layers still go back to their pre-`mutate` values and do not pick up another writer's committed change. An `unknown` outcome also restores memory, although the commit may have landed. If the rollback cannot take the lock, a changed file revision may be another writer's commit, so the outcome is `unknown` (`kept` when the revision is unchanged), never `landed`. After `kept` or `unknown`, a caller that keeps the project object must reload it before its next commit, or that commit can overwrite another writer's change or a save that landed but could not be verified; `ProjectWorkspace.mutate` does this by clearing its loaded-file signature on any failure, so its next `transaction()` re-adopts the saved project. The restore covers the in-memory model only: any file that `mutate` or the audio bookkeeping writes outside `episode.sharecut` and `history/` stays on disk.
`rolled_back_on_failure(..., on_failure=...)` reports the `RollbackOutcome` after
non-landed memory restoration. `ProjectWorkspace.mutate` resolves the request's effective config once (`ProjectWorkspace.effective_config()`) and hands it to `run_mutation` as `defaults`, so the audio bookkeeping around a mutation judges freshness against the same config the mutation ran with.
`run_mutation` and `ProjectWorkspace.mutate` expose
that callback to callers without wrapping the original exception. Raw `roll_back_history` certifies history only. Registered editable/render recovery
must complete before a `restored` callback can support an unchanged-project assurance.
Before `record(before)` succeeds, the mutator has not changed editable or render state.
Secondary recovery, notification and logger `BaseException`s preserve the original
exception object and traceback. Callback errors do not replace that failure.
Review mix publication deletes generated media only for `restored`, after confirming
the version is absent from the canonical project. It keeps media for `landed`,
`unknown`, or `kept`, without taking or comparing its own history-index snapshot.
An unreadable index uses the checkpoint fallback, including during review publication.

History record/undo/redo/goto and `ProjectStore.commit` run under `project_commit_lock` (an in-process lock plus a per-workspace file lock at `artifacts/episode.sharecut.lock`, kept outside `history/`). `ReviewService.publish` stages media (copy + MP3) privately outside the file lock, then holds it across atomic no-replace promotion, mutation checkpoint capture, commit and failure cleanup, so no other process can commit the failed version between the canonical check and media deletion. Staging still holds the in-process `project_state_lock`, so other threads in the same process that need this workspace (mutations, render snapshots, GUI requests) wait for the copy and MP3 encode; this keeps stage + attach atomic against in-process writers. The source premix is resolved and checked when staging, not re-validated under the file lock, so another process can re-render `premix.wav` before the version is attached; the version's `sha256` still matches its own copied `mix.wav`, and the lock does not guarantee premix freshness. A failure before promotion discards the private stage. Promoted media is retained when no rollback outcome is available, including a failure while leaving a committed transaction. Saved state or redo history may still reference it. If the lock cannot be taken, cleanup also requires that lock and may retain the private stage; no public version is created. `ProjectWorkspace.mutate()` runs `run_mutation` inside `ProjectWorkspace.transaction()`, so the stale check/reload, `record(before)`, the mutation, `record(after)` and the commit are one cross-process step; a writer in another process waits (30 s, then `ProjectBusyError`, a fixed-message `filelock.Timeout` subclass, #488). `mutate()` resolves the request's effective config once (`ProjectWorkspace.effective_config()`) and passes it to `run_mutation` as `defaults`, so the audio bookkeeping around a mutation uses the config the mutation ran with.

See [episode-format-v2.md](episode-format-v2.md) for the canonical project layout.

## History CLI

```bash
podcast history list --project episode.sharecut
podcast history record --project episode.sharecut --label "before manual tweak"
podcast history goto --project episode.sharecut --index 2
podcast history goto --project episode.sharecut --index 2 --rerender  # full stems/premix
podcast history diff --project episode.sharecut
podcast undo --project episode.sharecut
podcast undo --project episode.sharecut --expected-head 3f2a9c1d0b4e  # only while that entry is the latest
podcast redo --project episode.sharecut
podcast history-status --project episode.sharecut   # JSON: cursor, head_id, can_undo, can_redo
```

`goto` / `undo` / `redo` mark stale only what the move changed (#424). Stem hash sidecars are content-addressed (`track_render_hash`), so a stem stays fresh when the move left its track unchanged (an undone volume or mute stales only the premix). It goes stale when the restored state differs, and fresh again when a redo returns to the state it was rendered at. Without `--rerender`, `play processed:*` segment-renders a stale track (fast A/B); an unchanged track keeps playing its stem. Pass `--rerender` / `rerender=true` when you need full stems or premix. Reconciliation ("Transcript out of date") is marked only when `audio_state_fingerprint` changed. The render cause journal changes only for dialogue tracks whose render hash changed: a track whose stem WAV exists and whose `.hash` names the restored state drops its causes, and any other changed track gets a whole-track marker. A track the move removed (for example, an undone add-track) or took out of the dialogue role (an undone role change) loses its rows, since only dialogue tracks carry them.

With `rerender=true` the move and its stale marks are committed first, in one step under `project_commit_lock`, so no other writer's commit lands between them. The render then runs between `checkpoint()` and `save_merged()`, so an edit another request saved meanwhile is merged in as an `after merging concurrent edits` entry, and the returned cursor points at that entry (not at the move's target). The move stays saved whatever happens next: a same-value clash raises `ProjectMergeConflict` and a failed render raises `HistoryRerenderError`, and both messages say to re-render the preview, not to repeat the move. `HistoryRerenderError`'s message does not include the render's own error, which may name host paths; the server logs it and keeps it as the exception's cause (#1182). The document plane (`UndoHistory` / `RedoHistory`) returns both as a 409 conflict with that message. A failed render also drops its partial in-memory state from the workspace (`ProjectWorkspace.discard_changes()`), so a caller that keeps the workspace sees the saved move, not a half-rendered project. If another undo or redo moved the cursor during the render (`history.lineage` / `history.cursor`), the message says to check `history_status` before re-rendering instead, since the saved cursor is no longer this move's.

Bleed mute (`apply_transcript_gate_tool`) snapshots `track.transcript_gate` and
`track.transcript_gate_scope`. A scoped apply stores source-media selections so
later moves and ripple cuts retain the selected audio. Segment and full renders
rebuild the same conservative gate from ungated media. Reapplying rebuilds from
sources instead of multiplying the existing stem's fades. Undo restores the flag
and scope together; a rerender recovers the original audio from untouched sources.

While a Studio is serving the project a command names, the same group first hands the command to that Studio, which then runs it as the one writer (see [gui-integration.md § CLI commands while Studio is open](gui-viewer.md#cli-commands-while-studio-is-open-1733)); a busy lock reaches the CLI only when no Studio is serving the project. A busy `project_commit_lock` or `render_lock` (`ProjectBusyError` / `RenderBusyError`, both `filelock.Timeout`) escaping any command is caught by the root `BusyErrorGroup` (`cli/busy.py`), the one choke point for every CLI command: it prints `Error: <message>` to stderr and exits 1, instead of an unhandled-exception traceback. Move-specific commands (`undo`, `redo`, `history goto`) still catch their own narrower errors first for move advice text; a lock timeout reaches the group either way (#488). The same choke point also catches a domain guard error (`ValueError` / `RuntimeError`, e.g. `TranscriptRefineRequiredError`) escaping any command, printing it the same way (#773); set `PODCAST_DEBUG=1` to get the original traceback back for either case instead of the one-line message.

Snapshots are recorded automatically before/after:

- `episode add-track`
- `transcribe`, `propose-edits`
- `pipeline run` (before run, after each step, after run, recorded inside `save_merged(history_label=...)`; plus `after merging concurrent edits` when a save merged in another request's change)
- Timeline mutations via `EditService.mutate()` (paired `before …` / `after …` entries)
- `render_preview` when automation envelopes change

## Structured history metadata

Each `HistoryEntry` may include:

- `operation` — stable tool name (e.g. `ripple_delete`, `approve_edits`, `render_preview`)
- `params` — echoed invocation args (`timeline_start`, `fade_ms`, `track_id`, …)

`HistoryService.status()` returns a typed cursor, count, current label, head ID,
and undo/redo flags. `HistoryService.list_entries()` returns a separate typed
result with flat `entries` and grouped `groups`. The CLI and MCP commands keep
their existing JSON keys. `history-status` reports the status fields;
`history_list` reports the listing fields without the count or current label.
Mutation groups pair before/after snapshots into one user action. Standalone
snapshots form snapshot groups. Each group has a human-readable **`title`**
(operation + time range / tracks when `params` are present). Mutation groups
carry `before_id`/`after_id`, and snapshot groups carry `id`. The History tab
keys rows (selection, focus) on these entry IDs so an
external undo + new edit cannot inherit a discarded step's selection. The
History tab virtualizes long group lists (≥200 steps) so a many-entry history
keeps the DOM bounded.

`history diff` compares two snapshot indices and returns clip/decision/mix deltas (see `project/history/diff.py`) plus a **`summary`** string list (see `project/history/summary.py`) for GUI/CLI/MCP consumers.

## Guarded undo and redo (expected head)

The guard compares two things: the history head the person (or agent) saw, and the
server's head when the move runs. Each entry's `id` is a fresh 12-character hex string,
and `head_id` names the entry at the cursor, the state the project holds now. A history
with no entry yet has the head `root` (`HISTORY_ROOT_ID`), which never names an entry,
so "I saw an empty history" is a value the guard checks, not a missing one. The cursor
index cannot identify a change: at the 400-entry limit, pruning keeps the cursor at 399
while each new edit replaces the entry there, and an undo followed by a new edit lands on
the same index again.

`HistoryManager.undo` / `redo` (`expected_head_id=`) compare the expected head with the
head under `project_commit_lock`, after adopting the index, and raise
`StaleHistoryError` (a `CodedError`, code `history_stale`) before anything moves when
another entry has become the head. Every caller goes through that one check
(`HistoryService.undo` / `redo`):

| Surface | Expected head | Refusal |
| --- | --- | --- |
| Document plane `UndoHistory` / `RedoHistory` over HTTP (host GUI, guest editors) | `payload.expected_head_id`, **required** | Missing, null or empty: refused as invalid (HTTP 422 / 400), nothing moves. Stale: HTTP 409, `X-Sharecut-Error-Code: history_stale`; no journal row and no history move |
| Guest remote MCP `guest_submit_document_command` (`UndoHistory` / `RedoHistory`) | `payload.expected_head_id`, **required** | Missing, null or empty: JSON-RPC `-32602`, nothing moves. Stale: JSON-RPC `-32000` whose message is the refusal text (`Did not undo: …`); nothing moves. No `error_code` yet: `remote_mcp/protocol.py` adds `data.error_code` only for `project_busy` (guest tool-error codes: #1182, #1191) |
| MCP `history_undo` / `history_redo` | `expected_head_id`, optional | `is_error` result, `structured_content.error_code: "history_stale"` |
| CLI `podcast undo` / `podcast redo` | `--expected-head ID`, optional | exit 1, `Did not undo: … (code history_stale)` on stderr |

`head_id` is reported by `history_status_tool`, `podcast history-status`, `history_list`
and every project view's `history`. The document plane always names the head: every
GUI and guest undo or redo is a person acting on what their tab shows, and an edit the
tab has not received must not be the one reverted. MCP and the CLI keep the unguarded
move when the expected head is omitted, because an agent or script that says "undo the
latest" means exactly that; they pass the head when they mean "undo the change I just
looked at".

**Guests get the real head.** Guest views and guest document events strip history
labels and params (they can embed local paths) but keep the opaque `head_id`
(`_guest_history` in `services/collaboration/share.py`): random hex or `root`, no path.
A guest editor's Mod+Z or two-finger tap sends it like the host's, so a guest cannot
revert an agent edit it never received. A guest command reply carries
`history_head_id` too.

**Toast Undo.** A document command's reply carries `history_head_id`: the entry the
command left at the head, read in the same locked step as its apply. It is null when
history did not move and absent on an idempotent retry or a queued command, and then
the toast offers no Undo.
`announceStatus(message, { undo: replyHistoryHead(reply) })` binds the toast to that
entry. The toast shows Undo only while the tab's `history.head_id` is that entry, or is
still the head the tab showed when the toast was announced (`baseHead`): the reply can
reach the toast a few milliseconds before the document update that shows the new head,
and a toast must not drop its Undo in that gap. A different head hides it. A page that
never opened History skips the delta's `history_groups` rows it cannot line up, so the
head still lands without a refetch (`document/projectionDelta.ts`). Its click sends `UndoHistory` with it as `expected_head_id`. If another edit landed
first, the server refuses and the toast says "Can't undo: the project changed since.
Nothing was undone." The reply, not the tab's store after the await, names the entry,
because a peer's edit can reach the store while the command is in flight.
Every mutating command in the catalog (`CommandDef.mutates`) binds its toast this way: delete, cut, paste, trim, fade, nudge saves, chapter add and envelope point add read the head from their API wrapper's return. `commands/undoToast.test.ts` fails on a flagged command with no proof. A change History does not record (a comment resolve) passes `reverse` and the toast's Undo runs it.
Clip moves use this same reply-bound Undo, including a group moved with
**Apply move**. `moveClips` returns `HistoryEntryId | null` through `replyHistoryHead`.
The command captures `documentScope()` before entering the mutation queue and
checks it before starting work and after success or failure. A retired opening
cannot receive its feedback or optimistic rollback, including after the same
project path is closed and reopened.

**Mod+Z: the tab's own moves run one after another.** `history.undo` / `history.redo`
(Mod+Z, Mod+Shift+Z, the History tab buttons, the toast Undo, the phone two-finger tap
and the adjacent Undo controls) share one queue per tab (`commands/history.ts`). A move
with nothing ahead of it sends the head the tab knows, read after flushing its pending
mix saves. A completed own command reply can name that head before the display
catches up. The tab keeps that reply only as head knowledge for the current
document generation, while its server sequence is ahead of the applied document,
recovery has not observed a newer sequence, and the displayed predecessor is
unchanged. An applied peer update or reopening the project ends that knowledge.
Successful own history moves use the same reply observation and expiry rules. A
press made while an earlier history move is in flight waits for that reply and
expects the head the reply returned (`history_head_id`), so pressing Mod+Z twice
quickly undoes two changes: the tab's own undo moved the head, and that is not
someone else's change. A press also waits, before calling the history API, for
edit saves that were in flight when the press was made. The wait has no cutoff of
its own (every save ends by its own transport timeout) and covers this tab's live sends,
host and share guest alike, the offline drain run in progress, and saves still preparing their
send, such as a trim or roll loading its boundary token (`trackEditSave` in
`state/documentSendOrder.ts`). It then expects the head left by the latest of this
tab's own commands in that document generation (`noteSaveLanded`), so Undo
reverts the edit the person just made and is not refused as stale by it. The
handler also checks the document generation after waiting for an earlier
history move, the edit saves, and pending mix saves. If the project was reopened
during one of those waits, the handler refuses the press before calling the
history API. The command service also checks the original generation after
browser ownership, persistence, and queue reads, immediately before the HTTP
POST. Entering the history API does not authorize a later send from another
opening. Once the HTTP POST starts, the browser cannot cancel a server mutation.
A reply from a previous generation cannot supply head knowledge for the current
generation. A boundary token load that the server never answers gives up
after `DOCUMENT_COMMAND_TIMEOUT_MS` (`loadBoundaryContext`), and the save is dropped with
"The server didn't answer. Nothing was saved.", so Undo is not refused for good. A caller
that saves nothing while it waits, the Adjust boundary dialog, passes its own message ("The
server didn't answer. Try again.") and offers Try again in place. Saves
that begin after the press are not waited for. A
peer edit that arrives while a press waits its turn is never adopted; the server
refuses that press instead. If the move ahead was refused or failed, the waiting press keeps the head the
tab knew when it was pressed, so it is refused too rather than guessing. The toast's
Undo keeps its own entry even when it waits behind a Mod+Z.

**Undo says when it waits (#1680).** A press that has to wait for saves is recorded
as a queued move (`commands/undoWait.ts`: the action, the step it meant, and its state
`waiting`, `fired` or `dropped` with the reason). Every surface reads that record and
`documentActivityBusy`, so none keeps its own flag. While a save, send or drain runs, the toast shows
"Undo ready after save" and the header Undo is described by it. A press says "Undo runs
after save" (the toast's note, or the status line for Mod+Z, header and gesture), then runs
when the saves settle with the expected head it would have had without the wait. A toast press
keeps its entry, so if a later save moved the head first the server refuses it
(`history_stale`), the move is `dropped`, and the status says "Can't undo: the project
changed since. Nothing was undone." The server stays the one authority on staleness. A
refusal replaces the toast whose Undo was refused, so that Undo never vanishes without a
reason (#1690), and does not replace a toast that still offers Undo for a newer step: a
logical approval recorded across two commands keeps one Undo on the pass toast.
There is no per-command
"writes history" flag: every document command moves the head, so the client cannot tell
which sends leave a toast's entry current. A refusal is announced once
(the command returns `announced: true`, so the two-finger tap does not repeat it). Undo and Redo are refused offline and never replay. Ordinary refused edits
remain listed in **Needs attention** under their existing recovery policy.
An unconfirmed history response reports an unknown outcome. Check History before
trying again.

A fade drafted before an Undo projection arrives retains its original saved
fade pair. `TimelineService.set_clip_fade` compares that pair in the same project
transaction, before `mutate()` captures history. A mismatch changes neither
fades, history head, redo entries, nor the document journal. A fresh gesture can
save against the restored pair. This target guard leaves the save-before-Undo
wait and unseen-peer history-head refusal unchanged.

## History diff results

`HistoryService.diff()` returns `HistoryDiffResult` through the document service
facade. `EmptyHistoryDiffResult` contains `diff`, `summary`, `from_index`, and
`to_index`, in that order. The collections are empty and both indices are null.
Empty history returns this result before index validation.

`PopulatedHistoryDiffResult` contains `from_index`, `to_index`, `from_label`,
`to_label`, `operation`, `params`, `diff`, and `summary`, in that order.
`operation` and `params` are required nullable fields. An identical snapshot
comparison still has these eight fields. The raw diff and params retain nested
persisted JSON values, and the summary retains its existing order.

CLI, MCP, and HTTP adapters serialize `model_dump()` with their existing JSON
encoders. Without explicit indices, the target is the history cursor and the
source is the preceding entry. Invalid indices, including the default source
for a single entry, raise `history_index_out_of_range`.

## History MCP tools

- `history_list` — entries, cursor, and grouped mutations
- `history_status_tool` — cursor, `head_id` and undo/redo flags (JSON)
- `history_goto_tool` — jump to snapshot index (`rerender=true` optional; stales only the stems the move changed)
- `history_diff_tool` — structured delta between indices (clips and pending edit decisions are reported as added, removed or changed; a re-proposed Tighten hit keeps its id, so moved edges show under `changed`)
- `history_record` — manual snapshot
- `history_undo` / `history_redo` — navigate history (`rerender=true` optional; stales only the stems the move changed; `expected_head_id` optional here and required on the document plane, see [§ Guarded undo and redo](#guarded-undo-and-redo-expected-head))

A busy `project_commit_lock` or `render_lock` raised by a tool is caught once, server-wide, by `mcp.tool_errors.install_tool_errors` (installed on the `MCPServer` in `mcp/server.py`): it returns a structured `is_error` `CallToolResult` (`structured_content {ok: false, error, error_code: "project_busy"}`) instead of the bare `UnexpectedToolError` crash message (#488). A history refusal such as `ProjectMergeConflict` (`merge_conflict`) or `HistoryRerenderError` (`rerender_failed`) is a `CodedError` and takes the same path with its own code and its advice text (#1178).

### GUI (ShareCut Studio)

Desktop transport and History tab **Undo** / **Redo**, Mod+Z / Mod+Shift+Z and the app toast's **Undo** submit document commands `UndoHistory` / `RedoHistory` via `POST /api/document/command` → `HistoryService` (same path as MCP/CLI), each with the expected head described in [§ Guarded undo and redo](#guarded-undo-and-redo-expected-head). Applied snapshots include lean `history.groups` (not cursor flags only), and the client marks history hydrated when those groups arrive, so the step list updates after comments, track rename/reorder, and other targeted patches without leaving the tab. See [session-sync.md](session-sync.md) and [daw-editing.md](daw-editing.md).

See [gui-integration.md](gui-integration.md) for GUI-oriented undo and rerender guidance.

## Branching

If you undo and then make a new edit, snapshots after the current cursor are **discarded** (standard undo-stack behavior). Their files can remain on disk; commits delete only snapshots explicitly pruned from the oldest undo history, avoiding interference with an in-flight mutation.

## Rendering after undo

Undo changes edit decisions and mix settings, not exported files. Re-run the pipeline from the appropriate step (e.g. `assemble_timeline`) to refresh `artifacts/` and `export/`.

## For contributors and skill authors

When adding MCP tools, CLI commands, or agent skills that change episode state:

- Route undoable work through `ProjectWorkspace.mutate()` (see [contributing.md § History](contributing.md#history-non-destructive-undoable-state)).
- Domain logic stays in `edits/`; services own `mutate` labels; adapters stay thin.
- Skills should document which tool to use for batch undo (e.g. `apply_transcript_cleanup_tool`) and when to call `history_undo`.

Agent entry points: [.agents/INSTRUCTIONS.md](../.agents/INSTRUCTIONS.md), [.agents/rules/engineering-standards.md](../.agents/rules/engineering-standards.md).

## Removed transcript words

Exact range Cut/Mute and approval use one mutation for the target or reviewed
batch. Undo restores all affected clips and pending proposals, including empty
lanes and retained duration. Applied exact records direct users to History Undo
instead of offering a partial source-span Restore.

A mutation that changes the audio also retires every pending remove or mute proposal whose source span no clip plays any more (`edits/decisions.retire_unplayed_pending`, run once from `project/history/session.py`), so a cut never leaves a proposal that maps to the wrong timeline place (#1487). Undo restores them with the clips.

Cut and boundary-adjustment snapshots include the active word list and its source-scoped archive. Undoing a cut restores its original active words. Undoing a boundary expansion restores the prior archive; redo restores the expanded word metadata. Normal `ProjectWorkspace.mutate()` history owns these changes. Archived previews are not active word correction targets.

The archive and combined transcript are kept consistent by `engines/transcript_sync.py` (moved from `edits/` in #1813 so `engines/` does not import `edits/`); `edits/edit_log.py` calls its `rebuild_combined` when it reverts a mute.

## Transcript replacement pass

Studio find-and-replace validates its reviewed, source-keyed match set before one `ProjectWorkspace.mutate()` call. Every replacement across primary and extra recordings shares that history action, so one Undo restores all affected text, word timing, flags, and source identities. No matches or a stale preview produce no history entry. The adjacent result Undo is available while its project view and document sequence remain current; use History after newer changes.

## Word timing adjustments

`SetTranscriptWordTiming` checks the exact raw transcript, word sequence and recording revision in a `ProjectWorkspace.transaction()` before one `mutate()` call. A pointer gesture saves only on release; numeric and keyboard drafts require Apply. A no-op or stale draft creates no history action. Undo restores the exact timing, automatic evidence, suppression choices, user-edited flag and silence-filter fingerprint. Render freshness follows the restored ignored-word or transcript-gate intervals. The adjacent Wordbar Undo validates the current project snapshot and document sequence again at click time, then closes the editor before invoking the shared history command.

## Selected-range undo

Owner: [daw-editing.md § Exact selected ranges](daw-editing.md#exact-selected-ranges). This section keeps only the selected-range undo facet.

A selected range Cut or Mute is one history mutation across every selected lane and interval. Host approval is also one mutation. Undo restores all clip placements, local mute holes, and the pending decision together. Exact range records require History Undo rather than source-span Restore.

Submitting a reviewed exact MUTE creates pending state; host approval applies an undoable clip-local envelope. History undo restores the previous audio state. See [reviewed bleed ranges](transcript-reconcile.md#reviewed-bleed-ranges).

## Edit modes and confirmed cuts

A ripple or gap trim, delete, cut or paste is one `ProjectWorkspace.mutate()` call
across every track it moves, so one Undo puts every track back in sync. A ripple that
would cut another track's speech and is not confirmed runs no mutation and records no
history. Confirmed, it records one action like any other, and its applied-edit record
keeps the `cut_speech` it confirmed. See [daw-editing.md § Edit modes](daw-editing.md#edit-modes-ripple-and-gap).

## Speaker split

A record-room land (`RecordLandingService.land`, `podcast record land`, the upload ACK auto-land) is one `ProjectWorkspace.mutate()` entry, `record_land`. The first land of a session that registers a keeper is titled "Added Session N" ("Added Session N at the start" for a `start` target, `session_at_start` param; it also moves everything already on the timeline later, in the same step, and discarding the last take or rolling the land back moves it back) and adds the session's `editorial.record_sessions[]` entry with its clips, sources and tracks; a later land of the same session is "Added to Session N". The title comes from the entry's `session_number` and `session_first` params, so the History panel shows it for a paired and for a deduplicated `after` entry alike. Undo restores the project and frees the number; the upload rows in `sync.db` keep their landed marks, so only redo (not a fresh land) re-registers the undone keepers. A land into an insert or replace target is titled "Staged Session N" (`session_staged` param); undo removes the staged takes and, unlike an `end` land, the next land stages the keepers again. Skipping a staged session is one `skip_session_suggestion` step titled "Skipped Session N"; moving a person's staged takes to another track is one `remap_session_track` step titled "Moved <name> to <track>"; accepting an insert or replace session is one `accept_session_suggestion` step titled "Added Session N", and undo restores it as pending (a replace held for confirmation writes no step); a replace's Accept also drops the other takes' staged segments in that step, so undo brings them back. Picking the take a replace places is one `select_session_take` step titled "Chose take N for Session M" (picking the take already picked writes none). See [recording-session.md § Session numbers and the history step](recording-session.md#session-numbers-and-the-history-step).

`podcast speaker split --apply` (`speaker_split_tool`, `SpeakerService.split_speakers`) is one `ProjectWorkspace.mutate()` entry, `split_speakers`. Attribution runs first, outside the project lock; the mutation then adds the speaker lanes, their clip copies and mute regions, the per-lane transcripts and `editorial.speaker_splits`. Undo restores the single original lane, its transcript and clips together. ShareCut Studio's **Split speakers…** job returns the `after split speakers` entry as `history_head_id`, and its toast and result dialog offer Undo scoped to that entry, so an Undo never reverses a later change. No media is written, so nothing outside `episode.sharecut` and `history/` needs cleaning up. See [multitrack-ingest.md § Split one recording by speaker](multitrack-ingest.md#split-one-recording-by-speaker).

`podcast speaker move-lane-span` (`speaker_move_lane_span_tool`, `SpeakerService.move_lane_span`, `POST /api/speaker/move-lane-span`) is one `move_lane_span` mutation: it mutes the span on the source lane, rebuilds leftover target mutes with `_mute_region` / `SPLIT_FADE_MS` so the new hand-overs stay complementary, and moves transcript words in the nominal source span. It does not rewrite `SpeakerSplit.turns`. Undo restores both lanes' mutes and transcripts together.


## Individual Restore and whole-action Undo

Individual Restore supports ordinary source MUTE archives. It subtracts the recorded mute spans without inserting media or shifting timeline time. Removed clip material, including track punches, session ripples, parked recordings, replacement pads, and exact ranges, requires History Undo. `AppliedEditRecord` source and seam clocks remain editorial display data. They cannot identify the removed recordings or clip occurrences.

`EditService.revert_applied` validates the complete Restore plan under the workspace transaction before recording history. Top-level source bounds and every supplied `per_track_source` pair must be finite, nonnegative, and strictly ordered, including pairs for unlisted tracks. A present mapping must contain only two-element lists or tuples with numeric values. Finite numeric strings retain float conversion. An absent or empty mapping uses the top-level span for each listed track. Malformed plans leave the saved project, mute regions, archives, history entries, transcript caches, and render artifacts unchanged. Opening a document session can still initialize its normal journal and lock files before Restore runs. Unsupported archives raise `local_restore_requires_history` through the existing service, HTTP, and MCP error boundaries with this message.

> This edit cannot be restored individually. Use History Undo to restore the whole action. History Undo also undoes the other edits in that action. You may need to undo later actions first.

History Undo restores the stored editable snapshot for the action, including clip recording identity and transcript archives. Fetch `history_status` and pass its current `head_id` as `expected_head_id` to `history_undo`. A later action changes that head. Check History and choose the later actions to undo first. The Applied edit inspector's **Open History** control opens the existing tab and never starts an Undo automatically.

Speech-review confirmation has the same recovery boundary as saved cut-scope holds. `EditService.approve` returns `needs_confirmation` and `unchanged=true` only after the existing failure callback reports `RollbackOutcome.RESTORED`. UNKNOWN recovery propagates the original `UnconfirmedCutSpeech` error and makes no unchanged claim.

Automatic application evaluates the existing domain operation once on a staged copy under the workspace transaction. When every candidate is held, it returns zero without starting history or writing the project. A positive result adopts the staged editable snapshot inside the normal workspace mutation, preserving before/after history and audio bookkeeping. History Undo restores the entire applied action, including MUTE regions and pending rows.

## Occurrence Restore and exact acknowledged Undo

`RestoreClipBleed` saves one recording-bound automatic-reduction choice in the
selected clip occurrence through the existing document command and workspace
mutation. The command retains source media and other authored audio choices.
Ordinary History Undo and Redo restore its saved editable state.

The inspector's **Undo Restore** captures the Restore response's own acknowledged
History head and original project opening. A later peer edit, opening change or
occurrence lifetime change retires it. A nested stored result or the currently
visible peer head cannot create this receipt. Queued, unconfirmed and explicit
no-op replies offer no action-specific Undo.

Proxy manifest generations are derived render metadata outside editable History
snapshots. Their history-free publication preserves entries, cursor and head.
Undo can reuse a retained complete generation, but a directory left on disk does
not authorize an evicted artifact or a different manifest/project pair.
