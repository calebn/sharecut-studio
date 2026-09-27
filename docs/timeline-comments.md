# Timeline comments

Review feedback anchored to the **session/timeline clock** (what listeners hear on premix/review), stored in `review.comments[]` on `episode.project.json`.

Inspired by SoundCloud pins, Frame.io range comments + “mark complete”, and Descript’s hideable markers + comments panel.

Agents treat comments as a **first-class work queue** via MCP (preferred) or CLI. Skill: `.agents/skills/podcast-timeline-comments/`.

## Model

| Field | Meaning |
|-------|---------|
| `timeline_start` / `timeline_end` | Instant when end is null/equal; span when end > start |
| `track_ids` | Empty = session-wide; otherwise one or more track ids |
| `author` | Display identity (string; no auth yet) |
| `action_items[]` | Checkable TODOs with `completed_by` / `completed_at` |
| `replies[]` | Flat thread under the comment (`id`, `body`, `author`, `created_at`) |
| `resolved` / `resolved_by` / `resolved_at` | Whole-comment done state |
| `review_version_id` | Optional stamp when a review mix version is active |
| `edit_decision_id` | Optional link to one pending `EditDecision` — **at most one thread per decision** |

Comment and reply **body** text is capped at **8000** characters (`COMMENT_BODY_MAX` in
`edits/comments.py`). Guest public review also exposes
`POST /api/review/{token}/comments/{id}/actions/{aid}/done` (same as MCP
`guest_set_action_done`).

See [episode-format-v2.md](episode-format-v2.md) § Review comments.

## MCP tools

| Tool | Purpose |
|------|---------|
| `add_comment_tool` | Create instant/span; `track_ids_json` / `action_texts_json` optional JSON arrays; `edit_decision_id` opens the unique Ask thread for a pending cut |
| `list_comments_tool` | Queue filters: `include_resolved=false`, `open_actions_only=true` |
| `get_comment_tool` | Fetch one by id |
| `update_comment_tool` | Body / tracks / timeline anchor |
| `add_comment_action_tool` | Append a TODO |
| `add_comment_reply_tool` | Append a flat reply under a comment |
| `set_comment_action_done_tool` | Check/uncheck; pass `by` |
| `resolve_comment_tool` | Resolve or reopen; pass `by` |
| `delete_comment_tool` | Remove (undoable) |

All mutations go through `CommentService` → `ProjectWorkspace.mutate` (history-safe). Times are **timeline** seconds (`TOOL_TIMEBASE`).

## CLI

```bash
podcast comment add --project episode.project.json \
  --author caleb --start 12.5 --end 20 --body "Trim the intro" \
  --tracks host --action "Cut filler" --action "Check levels"

# Unique Ask thread for a pending edit (later notes use reply, not a second add)
podcast comment add --project episode.project.json \
  --author host --start 10 --end 12 --body "Why this cut?" \
  --edit-decision-id cut1

podcast comment list --project episode.project.json --open-only
podcast comment get --project episode.project.json --id <cid>
podcast comment update --project episode.project.json --id <cid> --body "…"
podcast comment add-action --project episode.project.json --id <cid> --text "Re-check"
podcast comment reply --project episode.project.json --id <cid> --author guest --body "Sounds good"
podcast comment done --project episode.project.json --id <cid> --action-id <aid> --by agent
podcast comment resolve --project episode.project.json --id <cid> --by caleb
podcast comment delete --project episode.project.json --id <cid>
```

## Agent workflow

1. `list_comments_tool(..., include_resolved=false)` or `open_actions_only=true`
2. Play/seek at `timeline_start`–`timeline_end` (`play_audio_tool` / session tools)
3. Edit with NL/tighten/FX skills as needed
4. `set_comment_action_done_tool(..., by="agent")` then `resolve_comment_tool(..., by="agent")`

To leave a note: search transcript → use **`timeline_*`** → `add_comment_tool(..., author="agent")`.

To ask about a **pending cut**: `add_comment_tool(..., edit_decision_id="<id>")` once; then `add_comment_reply_tool` for follow-ups. A second root with the same `edit_decision_id` is rejected. Approve/Reject does not auto-resolve the thread.

## Ask threads (pending edits)

Listen-first review keeps the conversation on the pending inspector (current timeline, not a modal). The first Ask creates `review.comments[]` with `edit_decision_id`; later notes are `replies[]`. Selecting that comment while the decision is still pending opens **PendingEditInspector** (not a generic comment inspector). See [daw-editing.md](daw-editing.md) § Listen-first pending preview.

## DAW viewer

- Hideable orange pins / range bars (Overlay legend → Comments)
- **Comment** mode in the transport: click ruler = instant, drag = span; Esc exits
- **Comments** tab: filter open / open actions / resolved / all; compose; replies; check action items; resolve (an **Undo** toast follows for the most recent resolve only — resolving another comment replaces it, and earlier ones stay reopenable with **Reopen**; hosts on touch can swipe left)
- Playback bubble when the playhead overlaps a comment (capped to one; toggled with Comments layer)
- Inspector when a comment is selected
- Mutations: `POST /api/comments`, `PATCH /api/comments/{id}`, `POST .../replies`, `POST .../actions/{id}/done`

## Review mix versions

Freeze the current premix (or mastered) so guest feedback pins to a known mix. Publishing refuses a premix that's stale vs the project (Refresh first) and a master that wasn't mastered from the current premix (export first, or publish the premix). While `artifacts/premix.wav` exists, a master with no `artifacts/mastered.hash` (mastered before #425), or one whose premix was copied or restored without its mtime, is refused once, until the next export re-masters it; an imported or legacy episode with only `mastered.wav` (no premix) publishes that master as-is (export, by contrast, rebuilds it):

```bash
podcast review publish-version --project episode.project.json --label "Guest pass 1"
podcast review list-versions --project episode.project.json
podcast review set-active --project episode.project.json --id <vid>
```

MCP: `publish_review_version_tool`, `list_review_versions_tool`, `set_active_review_version_tool`.

Versions live under `artifacts/review/{id}/mix.wav` plus `mix.mp3` (guest ReviewApp)
with metadata in `review.versions[]` (`mp3_relpath`, optional `object_store_key`).
Publication copies and encodes into a private `.staging-review-*` directory under the
pinned review root. Under the project commit lock it atomically promotes the complete
media directory to `{id}` with a no-replace rename, then records the version. Linux uses
`renameat2(RENAME_NOREPLACE)` and macOS uses `renameatx_np(RENAME_EXCL)`; unsupported
systems fail closed. **Review publishing is unavailable on Windows through CLI, MCP,
and share flows** until a Windows implementation can provide equivalent descriptor-safe
cleanup and atomic no-replace promotion. An existing destination is never overwritten.
The staged WAV is hashed through a pinned descriptor before the commit lock, and its
file identity is checked after promotion before attach. A failed copy or encode leaves
no public version. The review root must be owned and not group/world writable before
any media write; staging directories are mode 0700, output files are created with
no-follow, exclusive descriptor-relative opens, and an active stage holds a directory
lease until promotion or cleanup.
Direct `stage_version` callers must supply `on_media_created(path, identity)` so they
can promote or discard that private stage; `ReviewService.publish` and `publish_version`
provide this callback automatically.

Generation and persistence failure cleanup use the directory identity recorded at
staging creation and quarantine with descriptor-relative
operations. A replacement before the first identity check is retained. If replacement
lands between the check and quarantine rename, cleanup tries an atomic no-replace restore
to the public name. If that name is occupied or restoration fails, the replacement stays
in `.failed-review-*` for inspection. Cleanup never overwrites or deletes it.
Quarantines with a trusted ownership marker and directory identity, and inactive
private staging directories, become eligible for cleanup after 24 hours. Before taking
the in-process state or cross-process commit lock, each publish streams the directory,
keeps only the 32 oldest eligible candidates in memory, and deletes at most 32.
Enumeration and eligibility checks still take O(N) time in the number of review entries;
they do not block edits through either project lock. Active stages are skipped even if
their directory mtime is old. Legacy, mismatched, untrusted, and partially removed
quarantines stay for manual inspection.

The review root is resolved once before staging so symlink retargeting cannot redirect
cleanup. A saved version retains its media even if a later write reports an error.
Cleanup failures are logged without masking the publication error. Publication and
automatic cleanup require the review root to be owned by the process and not writable
by group or other users.
If the staging identity read fails, the private directory is retained because its identity cannot be proven; no public name is created. Identity is `(st_dev, st_ino)`; inode reuse after deletion remains a filesystem limit.

If a published version's MP3 is missing, retry encoding writes a temporary MP3 beside it and
publishes `mix.mp3` only after encoding succeeds. Python-level failures and interruptions remove
the temporary output, so guest audio lookup continues to use the frozen WAV. The retry pins the
resolved review directory so a symlink retarget cannot redirect the output or cleanup.
FFmpeg receives a private snapshot copied from a no-follow, descriptor-pinned WAV read;
it never reopens the workspace source path during a retry.
Before a retry creates its temporary file, it inspects up to 32 matching `.mix-*.mp3` names in
that version's directory and removes regular files older than 24 hours. The age threshold protects
fresh concurrent retries; symlinks, the published `mix.mp3`, and `mix.wav` are excluded. Cleanup is
best effort: missing or undeletable orphans do not block a new encode, and later retries can clear
remaining old files. It opens each directory component without following symlinks and performs
deletion relative to the pinned directory, so a renamed ancestor cannot redirect deletion. On
platforms without descriptor-relative directory operations, cleanup is skipped. A concurrent
same-name replacement between the last identity check and deletion is a narrow remaining race.
While `active_version_id` is set, new comments stamp `review_version_id`. Host play via
`GET /api/audio?kind=review&review_version_id=…` (or `kind=review:<id>`). Guest ReviewApp
uses `GET /api/review/{token}/audio` (MP3; optional object storage 302 — see
[host-online-relay.md](host-online-relay.md)).

**Path containment**: `audio_relpath` and `mp3_relpath` must resolve inside `artifacts/review/`
after symlinks are followed. A path that escapes it (`..`, an absolute path elsewhere, or an
outward-pointing symlink) is refused with `ValueError`: guest `/audio` and
`/daw/audio?kind=review` return 400, and host play with `kind=review` errors the same way.
There is no WAV fallback when `mp3_relpath` is bad. Paths written by `stage_version` (via `ReviewService.publish`) always
pass the check, and `./`-prefixed or absolute in-root spellings are still accepted; the
`artifacts/review/` directory itself may be a symlink. See
`util/workspace_paths.resolve_within`.
Once authorized, host and guest review reads walk the resolved path with no-follow
directory descriptors and stream from the pinned regular file. HTTP ranges and HEAD
use that descriptor, and object-store uploads use a pinned MP3 file object. A later
workspace symlink swap cannot redirect bytes to an outside file; unsupported
descriptor-relative platforms refuse the read.

## Remap after ripple deletes

`ripple_delete` / `batch_ripple_delete` automatically remaps `review.comments[]` and `editorial.chapters[]` via `edits/comment_remap.py`:

- Anchors fully before the cut stay put
- Anchors fully inside the cut are dropped
- Anchors fully after subtract the cut duration
- Overlapping spans are clamped to surviving material (zero-length → dropped)

Agents do not need a separate remap call after tighten/NL ripple cuts.

## Public review share

Requires the FOSS `collaboration` extension (default; disable with `PODCAST_EXTENSIONS=`). Internet guests also need the FOSS relay + `podcast tunnel` — see [host-online-relay.md](host-online-relay.md). A hosted account provider is optional.

1. Publish a frozen mix: `podcast review publish-version --label "Guest pass"`
2. Create a link: `podcast review share --role commenter --project … --version <vid> --base-url https://host:8765` (or raw `--capabilities …`). Default is **Anyone with the link** — login-free comments. Studio links use `--kind record` (not for comments yet).
3. Optional Restricted: `--general-access restricted --invite a@b.com` (sign-in; `podcast review revoke-invite` removes a person without rotating the coolname). Optional `--require-sign-in` on link shares for high sensitivity.
4. **Preferred (internet):** run the FOSS Docker relay + `podcast tunnel` so guests use the relay origin — see [host-online-relay.md](host-online-relay.md). LAN-only: bind GUI with `podcast gui --host 0.0.0.0` and set `PODCAST_REVIEW_CORS_ORIGINS` as needed.
5. Guests open `/r/{token}` only (no filesystem paths) — coolname slug, e.g. `/r/fantastic-acoustic-whale`:
   - **`--role viewer` / `view`** → read-only Sharecut Studio (timeline + premix)
   - **commenter (default)** → ReviewApp (frozen review MP3 + comments; object storage bypass when configured)
   - Document `<title>` and Open Graph / Twitter meta (`og:title`, `og:audio`, …) are injected server-side from the episode name and review mix so Messages / social previews show the episode title and can offer inline audio when `play` is granted (prefer HTTPS object storage URL when uploaded; otherwise `{public}/api/review/{token}/audio`).
6. Host sees comments in the DAW via project poll / document sync.
7. Optional **remote MCP**: `--with-mcp` (plus the role/caps the agent should have). With `PODCAST_REMOTE_MCP=1` and `podcast tunnel`, clients connect to `{base}/mcp/{token}/mcp` with the **same powers as the web guest** — see [host-online-relay.md](host-online-relay.md) § Remote MCP. Restricted shares need `POST /auth/agent-credential` Bearer tokens.

Token algorithm, roles, Restricted identity: **[share-tokens.md](share-tokens.md)**. Revoke: `podcast review revoke-share --token …`. Threat model: on link shares the token is the capability set; on Restricted shares the coolname alone is insufficient. Guest JSON never includes host absolute paths. object storage keys stay on the host only. Remote MCP guests never receive `project_path` and cannot call host-only tools (pipeline, ingest, laptop play).

**Comment resolve is host-only.** The host can resolve or reopen a thread in the Comments tab; that state lives in the project and persists when the host publishes another review version. ReviewApp labels each thread Open or Resolved and offers **Open comments only** to hide resolved threads temporarily; clearing the filter makes them readable again. While the guest page is visible, it refreshes the comment list about every 15 seconds so host changes appear without a reload. Guests (human and agent) may add comments, replies, and toggle action items when those caps are on the token. There is no share HTTP or `guest_*` tool to resolve/reopen a thread. Anonymous link shares have no verified per-guest identity for own-thread resolve; if guest resolve is added later, it must ship HTTP and MCP together.

## Live comments during recording

Host, guests, and producers can add live marker comments during a record
session (`M` → `body` `"Marker"`; typed notes use the same path). Anchors are
the **recording clock**; at landing they become ordinary `review.comments[]`
entries via `add_comment` under
`ProjectWorkspace.mutate()`. Spec:
[recording-session.md § Live comments](recording-session.md#live-comments).
