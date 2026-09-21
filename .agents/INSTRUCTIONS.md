# Agent bundle instructions

When editing **podcast_mcp** source (not only running MCP tools on episodes):

1. Follow [AGENTS.md](../AGENTS.md) and [rules/engineering-standards.md](rules/engineering-standards.md) — **SOLID/DRY**, **tests as you go**, **docs in sync**. Sharecut Studio CSS: [rules/gui-styling.md](rules/gui-styling.md). Long-running progress: [docs/progress.md](../docs/progress.md).
2. Put new behavior in **services + domain**, not in skills or MCP wrappers.
3. Run focused tests as you work. `make test` and `make ci` are optional local mirrors; GitHub Actions is the required full-CI gate.
4. **Git workflow:** work on a feature branch off latest `main`, not on `main` itself. Branch names: `type/short-kebab-description` (`feat` | `fix` | `docs` | `chore` | `refactor` | `test`). When the user asks to ship, commit on that branch, `git push -u public HEAD`, and open a PR to `main` with `gh pr create`. Do not push commits to `main` or merge the PR unless the user explicitly asks. Detail: [docs/contributing.md § Git workflow](../docs/contributing.md#git-workflow).
5. Update `README.md`, `docs/architecture.md`, and related docs/skills when the change affects them.
6. Before adding durable storage (JSON sidecar, sqlite, host-local index), read [docs/persistence.md](../docs/persistence.md) and extend an existing store — do not invent a parallel registry.

Skills under `skills/` describe **how to operate** the toolkit on episode workspaces via MCP or CLI; they do not replace the repo’s code standards. See [README.md](README.md) for MCP registration on any client.

When the user refers to the DAW playhead, selection, or “here”, call `get_session_state_tool` (see skill **podcast-play-audition**). Session control tools move the viewer without OS audio; `play_*` tools also update the same `session_state.json`. Before playing a multitrack span to diagnose overlap or post-edit desync, call `audition_context_tool` (v2 captions + hypotheses + suggested_listen). Use `play_compose_tool` when you need a subset mix (host+guest without music).

## Timeline comments (first-class)

Review feedback lives in `review.comments[]` and is fully available over **MCP** (`add_comment_tool`, `list_comments_tool`, `get_comment_tool`, `update_comment_tool`, `add_comment_action_tool`, `set_comment_action_done_tool`, `resolve_comment_tool`, `delete_comment_tool`) and CLI (`podcast comment …`). Times are **timeline** seconds. When the user asks to act on review notes, open action items, or leave feedback for later, use skill **podcast-timeline-comments** — do not invent a sidecar or hand-edit JSON. Pass `by="agent"` / `author="agent"` (or a stable label) when the agent creates or completes work.

## Non-destructive, undoable edits (required)

All episode state changes must be **undoable** and must **never overwrite `raw/` audio**.

| Do | Don't |
|----|--------|
| Add a `*Service` method that calls `ProjectWorkspace.mutate("before …", "after …", fn)` | Call domain `edits/*` functions on a loaded project from CLI/MCP/skills without `mutate` |
| Expose that service method via thin MCP/CLI adapters | Call `save_project` / `ws.save()` for state mutations without a history snapshot |
| Batch related fixes into **one** `mutate` per user-approved step | Edit `transcripts/*.json` or `episode.project.json` by hand |
| Document undo labels and `history_undo` in skills that mutate transcripts or edits | Re-implement snapshot logic outside `history/session.py` |

Canonical implementation: [`run_mutation`](../src/podcast_mcp/history/session.py) (snapshot before → change → snapshot after → `ProjectStore.commit`).

Contributor detail: [docs/contributing.md § History](../docs/contributing.md#history). User/operator detail: [docs/history.md](../docs/history.md), skill [podcast-history](skills/podcast-history/SKILL.md).
