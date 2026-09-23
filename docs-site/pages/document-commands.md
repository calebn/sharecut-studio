# Document commands

Typed document-plane commands shared by host GUI, guest share HTTP, document WebSocket, and MCP.

Envelope fields on every command: `client_id`, `client_seq`, optional `role`, `command_id`, `causation_id`, `token`, `structural_mode`.

Which product surfaces expose related workflows: [Capabilities](#/capabilities).

<!-- document-commands:generated -->

> **Auto-generated** from [`schemas/document-commands.schema.json`](https://github.com/calebn/sharecut-studio/blob/main/schemas/document-commands.schema.json) / Pydantic `services/document_sync/payloads.py`. Do not edit by hand — run `make schema-export`.

### Adapters

| Surface | How it validates |
|---------|------------------|
| Host HTTP `POST /api/document/command` | FastAPI body = `DocumentCommandBody` |
| Guest HTTP `POST /api/review/{token}/daw/document/command` | Same models + share caps |
| Document WS `/api/document/ws` | `parse_document_command` on each `Command` frame |
| Host MCP / CLI helpers | `validate_payload` / typed submit |
| Guest MCP `guest_submit_document_command` | `inputSchema` = this schema |

Raw JSON Schema (site copy): [document-commands.schema.json](../schemas/document-commands.schema.json).

### Command catalog

| Type | Required payload | Optional payload |
|------|------------------|------------------|
| `AddAction` | `comment_id` (string), `text` (string) | — |
| `AddChapter` | `time` (number), `title` (string) | — |
| `AddComment` | `author` (string), `body` (string), `timeline_start` (number) | `action_texts` (array \| null), `edit_decision_id` (string \| null), `timeline_end` (number \| null), `track_ids` (array \| null) |
| `AddReply` | `author` (string), `body` (string), `comment_id` (string) | — |
| `AddSocialClip` | `end` (number), `start` (number), `track_id` (string) | `title` (string \| null) |
| `AddTrack` | — | `label` (string \| null), `role` (string \| null), `speaker` (string \| null), `track_id` (string \| null) |
| `ApplyFadeRecommendations` | — | `track_id` (string \| null) |
| `ApproveEdits` | `ids` (array[string]) | — |
| `CorrectTranscriptPhrase` | `end_word_index` (integer), `start_word_index` (integer), `text` (string), `track_id` (string) | — |
| `CorrectTranscriptWord` | `text` (string), `track_id` (string), `word_index` (integer) | — |
| `DeleteChapter` | `time` (number), `title` (string) | — |
| `DeleteClip` | — | `clip_id` (string \| null), `clip_ids` (array \| null), `reason` (string \| null) |
| `DeleteComment` | `comment_id` (string) | — |
| `DeleteSocialClip` | `id` (string) | — |
| `DuplicateSegment` | `insert_at` (number), `source_end` (number), `source_start` (number) | — |
| `MoveClips` | `clips` (array[object]) | — |
| `MoveSegment` | `insert_at` (number), `source_end` (number), `source_start` (number) | — |
| `PasteSegment` | `duration` (number), `insert_at` (number) | `extracts` (array[object]) |
| `RedoHistory` | — | `rerender` (boolean) |
| `RejectEdits` | `ids` (array[string]) | — |
| `RemoveTrack` | `track_id` (string) | — |
| `ReorderTrack` | `index` (integer), `track_id` (string) | — |
| `ResolveComment` | `by` (string), `comment_id` (string) | `resolved` (boolean) |
| `RestoreAppliedEdit` | `id` (string) | — |
| `RippleDeleteClip` | — | `clip_id` (string \| null), `clip_ids` (array \| null), `reason` (string \| null) |
| `RippleDeleteRange` | `end` (number), `start` (number) | — |
| `RollClipJoin` | `delta_sec` (number), `left_clip_id` (string), `right_clip_id` (string) | — |
| `SetActionDone` | `action_id` (string), `by` (string), `comment_id` (string) | `done` (boolean) |
| `SetClipFade` | `clip_id` (string), `fade_in_ms` (integer), `fade_out_ms` (integer) | — |
| `SetEffectBypass` | `bypass` (boolean), `effect_index` (integer), `track_id` (string) | — |
| `SetEnvelope` | `expected_points` (array[object]), `track_id` (string) | `points` (array[object]) |
| `SetJoinMode` | `clip_id` (string), `join_in_mode` (fade \| crossfade \| cut) | — |
| `SetTrackMedia` | `rel_path` (string), `track_id` (string) | — |
| `SetTrackMeta` | `track_id` (string) | `label` (string \| null), `role` (string \| null), `speaker` (string \| null) |
| `SetTranscriptWordSuppressed` | `suppressed` (boolean), `track_id` (string), `word_index` (integer) | — |
| `SplitAtTime` | `at_time` (number) | `reason` (string \| null), `track_ids` (array \| null) |
| `SuggestPendingEdit` | `end` (number), `start` (number), `track_id` (string) | `edit_type` (remove \| mute), `reason` (string \| null) |
| `TrimClipEdge` | `clip_id` (string), `edge` (in \| out), `source_sec` (number) | `mode` (string) |
| `UndoHistory` | — | `rerender` (boolean) |
| `UpdateChapter` | `old_time` (number), `old_title` (string), `time` (number), `title` (string) | — |
| `UpdateComment` | `comment_id` (string) | `body` (string \| null), `timeline_end` (number \| null), `timeline_start` (number \| null), `track_ids` (array \| null) |
| `UpdatePendingEdit` | `end` (number), `id` (string), `start` (number) | `snap` (boolean), `track_ids` (array \| null) |
| `UpdateSocialClip` | `end` (number), `id` (string), `start` (number) | — |

_Generated 43 command types._

- Regenerate: `make schema-export`
- CI / pre-commit: `make schema-check`

<!-- /document-commands:generated -->
