---
name: podcast-timeline-comments
description: >-
  Add, list, update, resolve, and check off timeline review comments and action
  items via MCP or CLI. Use when leaving feedback notes, edit TODOs from
  reviewers, or working open comments as a work queue. For notes about
  transitions, leave-a-beat, or clean handoffs, follow podcast-inaudible-cuts
  Narrative handoffs (suggest_handoff_cut_tool) — not raw word→word ripple.
---

# Timeline comments

Comments live in `review.comments[]` on the episode project. Times are **timeline seconds** (session/deliverable clock), like chapters — not source-media time.

Prefer **MCP tools** when operating as an agent. CLI mirrors the same `CommentService` mutations (all undoable via `history_undo`).

## MCP tools (first-class)

| Tool | Purpose |
|------|---------|
| `add_comment_tool` | Create instant or span; optional `track_ids_json`, `action_texts_json` (JSON string arrays); `edit_decision_id` for the unique Ask thread on a pending cut |
| `list_comments_tool` | Sorted by `timeline_start`; `include_resolved=false` or `open_actions_only=true` for queues |
| `get_comment_tool` | One comment by id |
| `update_comment_tool` | Body / tracks / timeline anchor |
| `add_comment_action_tool` | Append an action-item TODO |
| `add_comment_reply_tool` | Append a flat reply under a comment |
| `set_comment_action_done_tool` | Check/uncheck; pass `by` (use `"agent"` when the agent finishes work) |
| `resolve_comment_tool` | Resolve or reopen (`resolved=false`); pass `by` |
| `delete_comment_tool` | Remove (undoable) |

Identity: always set `author` / `by` to a stable string (`"agent"`, human name, or email). No auth yet — these fields are the audit trail.

One **Ask thread per pending decision**: pass `edit_decision_id` on the first `add_comment_tool`. Later notes use `add_comment_reply_tool` — a second root with the same id is rejected. Approve/Reject does not auto-resolve. In Sharecut Studio the pending inspector shows that thread (selecting the comment while the cut is still pending opens Pending, not the generic comment inspector).

## CLI

```bash
podcast comment add --project episode.project.json \
  --author agent --start 12.5 --end 20 --body "Trim the intro" \
  --tracks host --action "Cut filler"

podcast comment list --project episode.project.json --open-only
podcast comment list --project episode.project.json --open-actions
podcast comment get --project episode.project.json --id <cid>
podcast comment update --project episode.project.json --id <cid> --body "…"
podcast comment add-action --project episode.project.json --id <cid> --text "Re-check levels"
podcast comment reply --project episode.project.json --id <cid> --author agent --body "Fixed in history #N"
podcast comment done --project episode.project.json --id <cid> --action-id <aid> --by agent
podcast comment resolve --project episode.project.json --id <cid> --by agent
podcast comment delete --project episode.project.json --id <cid>
```

## Agent work-queue workflow

When the user asks to “work the comments”, “clear review feedback”, or similar:

1. `list_comments_tool(project_path, include_resolved=false)`  
   and/or `open_actions_only=true`
2. For each open comment:
   - Seek/play: `play_audio_tool` or session tools at `timeline_start`–`timeline_end` (timeline clock)
   - Optional: `get_session_state_tool` if the user said “here” / playhead
3. Act with the right edit skill (cut, tighten, FX, transcript fix, …)
   - Host notes about **transitions / “clean up the handoff” / “need a beat”** → follow **podcast-inaudible-cuts** § Narrative handoffs (`suggest_handoff_cut_tool` → mid-silence ripple with `use_inaudible_opt=false`). Do **not** word→word ripple with default absorb.
4. `set_comment_action_done_tool(..., by="agent")` for each finished TODO
5. `resolve_comment_tool(..., by="agent")` when the whole note is addressed
6. If something was wrong: `history_undo` (comment mutations are history-safe)

### Leave feedback as an agent

When the user asks you to note something for later (or for a human):

1. Prefer anchoring with `search_transcript_tool` → use match **`timeline_start` / `timeline_end`**
2. `add_comment_tool(project_path, body=…, author="agent", timeline_start=…, timeline_end=…, track_ids_json='["host"]', action_texts_json='["Cut this"]')`
3. Confirm in the DAW Comments tab / markers after project reload

## Anchors

- Empty `track_ids` = session-wide (whole mix)
- One or more track ids = scoped to those tracks
- Instant: omit `timeline_end` (or equal to start)
- Span: `timeline_end` > `timeline_start`

`ripple_delete` / `batch_ripple_delete` automatically remaps comment (and chapter) anchors — no separate remap call.

## Review mix versions

Before inviting guests, freeze a mix: `publish_review_version_tool` / `podcast review publish-version --label "…"`. New comments stamp `review_version_id` while that version is active. Publishing refuses a stale premix (`render_preview` / Refresh first) and a master not mastered from the current premix (export first, or publish the premix).

Share: `podcast review share --role commenter --version <vid> --base-url https://host:8765` → `/r/fantastic-acoustic-whale` (coolname slug; see [share-tokens.md](../../docs/share-tokens.md)). Prefer relay + `podcast tunnel` ([host-online-relay.md](../../docs/host-online-relay.md)). Bind with `--host 0.0.0.0` only for LAN-only sharing; revoke with `podcast review revoke-share`. Default link shares stay **login-free** for comments. `--kind record` mints studio `/rec/` links; live comments during REC/PAUSED use the record Comment command (not this review share).

To let an **agent** use the same powers as the share recipient, add `--with-mcp` (or `mcp` to `--capabilities`) plus the role/caps needed. Host must run with `PODCAST_REMOTE_MCP=1`. CLI prints `MCP URL` (`{base}/mcp/{token}/mcp`). See skill **podcast-remote-mcp**.

## Related skills

- **podcast-remote-mcp** — connect Cursor/remote MCP to a share token
- **podcast-play-audition** — listen at the comment time
- **podcast-edit-natural-language** — cuts / ripple from feedback
- **podcast-history** — undo a mistaken resolve or delete
- **podcast-open-gui** — show Comments tab / pins to the user

## DAW

Local viewer: Comments tab, hideable pins, comment mode. Same data via `POST /api/comments`. Docs: [docs/timeline-comments.md](../../docs/timeline-comments.md).
