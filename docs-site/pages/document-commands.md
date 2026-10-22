# Document commands

Typed document-plane commands shared by host GUI HTTP, guest share HTTP, and MCP. The document WebSocket only fans out `Applied`.

Envelope fields on every command: `client_id`, `client_seq` (optional, >= 1; omit to let the server assign one), optional `role`, `command_id`, `causation_id`, `token`, `structural_mode`. A retry repeats the `command_id` (or the same type and payload) on the same `client_seq` and returns `idempotent`; a different edit on a used `client_seq` is a 409 conflict.

Which product surfaces expose related workflows: [Capabilities](#/capabilities).

Acoustic holds are checked again when an edit is approved. A caller that may run the
command can override the audio-quality and cut-position checks for one call with
`override_audio_checks: true` (a share needs the Editor capability). Confirmation text
and caller roles alone do not override anything; each override is recorded with its
actor and surface.

<!-- document-commands:generated -->

> **Auto-generated** from [`schemas/document-commands.schema.json`](https://github.com/calebn/sharecut-studio/blob/main/schemas/document-commands.schema.json) / Pydantic `services/document_sync/payloads.py`. Do not edit by hand — run `make schema-export`.

### Adapters

| Surface | How it validates |
|---------|------------------|
| Host HTTP `POST /api/document/command` | FastAPI body = `DocumentCommandBody` |
| Guest HTTP `POST /api/review/{token}/daw/document/command` | Same models + share caps |
| Host MCP / CLI helpers | `validate_payload` / typed submit |
| Guest MCP `guest_submit_document_command` | `inputSchema` = this schema |

Raw JSON Schema (site copy): [document-commands.schema.json](../schemas/document-commands.schema.json).

### Command catalog

| Type | Required payload | Optional payload |
|------|------------------|------------------|
| `AddAction` | `comment_id` (string), `text` (string) | — |
| `AddChapter` | `time` (number), `title` (string) | — |
| `AddComment` | `author` (string), `body` (string), `timeline_start` (number) | `action_texts` (array \| null), `edit_decision_id` (string \| null), `timeline_end` (number \| null), `timeline_spans` (array \| null), `track_ids` (array \| null) |
| `AddEffect` | `track_id` (string) | `effect` (string \| null), `params` (object \| null), `preset` (string \| null) |
| `AddReply` | `author` (string), `body` (string), `comment_id` (string) | — |
| `AddSocialClip` | `end` (number), `start` (number), `track_id` (string) | `title` (string \| null) |
| `AddTrack` | — | `label` (string \| null), `role` (string \| null), `speaker` (string \| null), `track_id` (string \| null) |
| `ApplyFadeRecommendationList` | `recommendations` (array[object]) | — |
| `ApplyFadeRecommendations` | — | `track_id` (string \| null) |
| `ApplySuggestedActions` | — | `ids` (array \| null), `override_audio_checks` (boolean), `overrides` (object), `revise` (boolean) |
| `ApplyTranscriptCleanup` | `track_id` (string) | `phrases` (array \| null), `words` (array \| null) |
| `ApproveEdits` | `ids` (array[string]) | `hold_blocked` (boolean), `override_audio_checks` (boolean) |
| `CorrectTranscriptPhrase` | `end_word_index` (integer), `start_word_index` (integer), `text` (string), `track_id` (string) | `expected_text` (string \| null), `source_id` (string \| null) |
| `CorrectTranscriptWord` | `text` (string), `track_id` (string), `word_index` (integer) | `expected_text` (string \| null), `source_id` (string \| null) |
| `CrossfadeJoins` | — | `dry_run` (boolean \| null), `fade_ms` (integer \| null), `speaker` (string \| null), `track_id` (string \| null) |
| `CutRange` | `end` (number), `mode` (ripple \| gap), `start` (number) | `override_audio_checks` (boolean), `track_ids` (array[string]), `use_inaudible_opt` (boolean \| null) |
| `DeleteChapter` | `time` (number), `title` (string) | — |
| `DeleteClip` | `mode` (ripple \| gap) | `clip_id` (string \| null), `clip_ids` (array \| null), `override_audio_checks` (boolean), `reason` (string \| null) |
| `DeleteComment` | `comment_id` (string) | — |
| `DeleteSocialClip` | `id` (string) | — |
| `DuplicateSegment` | `insert_at` (number), `source_end` (number), `source_start` (number) | — |
| `EditSelectedRange` | `action` (cut \| mute), `target` (object) | `override_audio_checks` (boolean) |
| `FadeJoins` | — | `dry_run` (boolean \| null), `fade_ms` (integer \| null), `speaker` (string \| null), `track_id` (string \| null) |
| `FillRoomTone` | — | `speaker` (string \| null), `track_id` (string \| null) |
| `InsertGap` | `at_time` (number) | `duration_sec` (number) |
| `MoveByText` | `destination_query` (string), `source_query` (string) | `position` (string) |
| `MoveClips` | `clips` (array[object]) | — |
| `MoveSegment` | `insert_at` (number), `source_end` (number), `source_start` (number) | — |
| `PasteSegment` | `duration` (number), `insert_at` (number), `mode` (ripple \| gap) | `extracts` (array[object]) |
| `ReconcileTranscript` | — | `dry_run` (boolean \| null), `end_sec` (number \| null), `speaker` (string \| null), `start_sec` (number \| null), `track_id` (string \| null) |
| `RedoHistory` | `expected_head_id` (string) | `rerender` (boolean) |
| `RejectEdits` | `ids` (array[string]) | — |
| `RemoveEffect` | `track_id` (string) | `effect` (string \| null) |
| `RemoveTrack` | `track_id` (string) | — |
| `ReorderTrack` | `index` (integer), `track_id` (string) | — |
| `ReplaceTranscriptMatches` | `preview_token` (string), `replacement` (string), `search` (string) | `match_case` (boolean) |
| `ResolveComment` | `by` (string), `comment_id` (string) | `resolved` (boolean) |
| `RestoreAppliedEdit` | `id` (string) | — |
| `RestoreClipBleed` | `target` (object) | — |
| `RippleDeleteText` | `query` (string) | `override_audio_checks` (boolean), `use_inaudible_opt` (boolean \| null) |
| `RollClipJoin` | `delta_sec` (number), `expected_token` (string), `left_clip_id` (string), `right_clip_id` (string) | — |
| `SetActionDone` | `action_id` (string), `by` (string), `comment_id` (string) | `done` (boolean) |
| `SetBleedAlignmentMode` | `decision_id` (string), `mode` (auto \| manual \| declined) | `end_sec` (number \| null), `override_placement_lock` (boolean), `start_sec` (number \| null), `track_id` (string \| null) |
| `SetClipFade` | `clip_id` (string), `expected` (object), `fade_in_ms` (integer), `fade_out_ms` (integer) | — |
| `SetClipJoin` | `left_clip_id` (string), `mode` (fade \| crossfade \| cut), `right_clip_id` (string) | `length_ms` (integer \| null) |
| `SetEffectBypass` | `bypass` (boolean), `effect_index` (integer), `track_id` (string) | — |
| `SetEnvelope` | `expected_points` (array[object]), `track_id` (string) | `points` (array[object]) |
| `SetJoinMode` | `clip_id` (string), `join_in_mode` (fade \| crossfade \| cut) | — |
| `SetTrackFader` | `fader_db` (number), `track_id` (string) | — |
| `SetTrackMedia` | `rel_path` (string), `track_id` (string) | — |
| `SetTrackMeta` | `track_id` (string) | `label` (string \| null), `role` (string \| null), `speaker` (string \| null) |
| `SetTrackMute` | `muted` (boolean), `track_id` (string) | — |
| `SetTranscriptWordAutomatic` | `track_id` (string), `word_index` (integer) | `expected_text` (string \| null), `source_id` (string \| null) |
| `SetTranscriptWordSuppressed` | `suppressed` (boolean), `track_id` (string), `word_index` (integer) | `expected_text` (string \| null), `source_id` (string \| null) |
| `SetTranscriptWordTiming` | `end` (number), `expected_token` (string), `start` (number), `target` (object) | — |
| `SetTranscriptWordsIgnored` | `end_word_index` (integer), `ignored` (boolean), `start_word_index` (integer), `track_id` (string) | `expected_text` (string \| null), `source_id` (string \| null) |
| `ShortenWordGaps` | — | `max_gap_sec` (number), `override_audio_checks` (boolean), `use_inaudible_opt` (boolean \| null) |
| `SplitAtTime` | `at_time` (number) | `reason` (string \| null), `track_ids` (array \| null) |
| `StageTextMatchCut` | `query` (string) | `match_all` (boolean), `review_required` (boolean), `speaker` (string \| null), `track_id` (string \| null), `use_inaudible_opt` (boolean \| null) |
| `StageTimeRangeCut` | `end` (number), `start` (number), `track_id` (string) | `reason` (string \| null), `review_required` (boolean), `use_inaudible_opt` (boolean \| null) |
| `StageUtteranceCut` | `utterance_index` (integer) | `review_required` (boolean), `use_inaudible_opt` (boolean \| null) |
| `StageWordsCut` | `end_word_index` (integer), `start_word_index` (integer), `track_id` (string) | `review_required` (boolean), `source_id` (string \| null), `use_inaudible_opt` (boolean \| null) |
| `SuggestPendingEdit` | `end` (number), `start` (number), `track_id` (string) | `edit_type` (remove \| mute), `reason` (string \| null) |
| `SuppressBleed` | — | `end_sec` (number \| null), `exclude_words` (array \| null), `speaker` (string \| null), `start_sec` (number \| null), `track_id` (string \| null), `words` (array \| null) |
| `SuppressLowAudibility` | — | `speaker` (string \| null), `track_id` (string \| null), `words` (array \| null) |
| `TrimClipEdge` | `clip_id` (string), `edge` (in \| out), `expected_token` (string), `mode` (ripple \| gap), `source_sec` (number) | `override_audio_checks` (boolean) |
| `UndoHistory` | `expected_head_id` (string) | `rerender` (boolean) |
| `UpdateChapter` | `old_time` (number), `old_title` (string), `time` (number), `title` (string) | — |
| `UpdateComment` | `comment_id` (string) | `body` (string \| null), `timeline_end` (number \| null), `timeline_start` (number \| null), `track_ids` (array \| null) |
| `UpdatePendingEdit` | `end` (number), `id` (string), `start` (number) | `expected` (object \| null), `override_audio_checks` (boolean), `snap` (boolean), `track_ids` (array \| null) |
| `UpdateSocialClip` | `end` (number), `id` (string), `start` (number) | — |
| `VerifyTranscript` | `corrections` (array[object]), `track_id` (string) | — |

_Generated 72 command types._

- Regenerate: `make schema-export`
- CI / pre-commit: `make generated-check`

<!-- /document-commands:generated -->
