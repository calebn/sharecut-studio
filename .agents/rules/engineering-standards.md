# Engineering standards

Read [AGENTS.md](../../AGENTS.md) and [docs/contributing.md](../../docs/contributing.md) before changing code.

## Layering (SOLID)

- **Domain** (`edits/`, `clips/`, `pipeline/`, `engines/`, `models/`) — pure logic, no CLI/MCP-specific I/O.
- **Application** (`services/`) — orchestration, history labels, `load_defaults()`.
- **Adapters** (`cli/`, `mcp/tools/`) — thin: open `ProjectWorkspace`, call one service method, return JSON/text.

Do not add business logic to `mcp/server.py` or `cli/main.py`.

## DRY

- Project paths: `project_io.open_project` / `ProjectStore.commit` (or `save_project`).
- Undoable edits: `ProjectWorkspace.mutate()` or `history.session.run_mutation`.
- Approve/reject lists: `util/review`.
- Transcript markdown export: `export/transcript`.
- Durable storage: extend an existing store from [docs/persistence.md](../../docs/persistence.md) (project JSON + history, session sync sqlite, share registry). Do not add parallel sidecars or one-off DBs.

Reuse existing functions; extract shared helpers before copying blocks.

Guest remote MCP tools (`services/remote_mcp/`, `mcp/tools/guest/`) wrap `ShareService` / document commands — no parallel domain logic and no client-supplied `project_path`.

## Progress

Long-running work uses the shared progress framework ([docs/progress.md](../../docs/progress.md)). Adapters wrap automatically; domain uses `progress_task` / `resolve_progress`. Do not hardcode `NullProgress()` at MCP/CLI edges or invent per-tool progress UIs. Exemptions in `contracts/progress-exemptions.json` require **explicit user approval** (same bar as `# noqa`). `make progress-check` warns by default.

## Non-destructive, undoable mutations

Episode workspaces have two protection layers:

1. **Source media** — `raw/` is read-only at render time; never write processed audio back into `raw/`.
2. **Editable state** — tracks, transcripts, `edit_decisions`, effects, clips, etc. live in `episode.project.json` and are snapshotted under `history/snapshots/` for undo/redo.

**When adding or changing tools, services, or skills:**

- Domain code in `edits/` / `engines/` mutates an in-memory `EpisodeProject` only — no file I/O.
- Application code in `services/` wraps undoable work in `ws.mutate(label_before, label_after, fn)`.
- Adapters in `cli/` and `mcp/tools/` call **one** service method; they do not call `save()` or domain mutators directly.
- Skills compose MCP/CLI primitives and must point users to `history_undo` when a workflow batches mutations.

**Anti-patterns:** `ws.save()` after changing transcripts or edit decisions; one-off Python scripts that call `correct_word` / `cut_time_range` on a loaded project without `mutate`; hand-editing mirrored `transcripts/{track}.json` (canonical data is `episode.project.json`).

See [docs/contributing.md](../../docs/contributing.md#history), [docs/history.md](../../docs/history.md), [.agents/INSTRUCTIONS.md](../INSTRUCTIONS.md).

## Tests as you go

- Ship tests with every behavior change (`tests/test_*.py`).
- Run `make test`; keep coverage ≥95% (`pyproject.toml`). `make test` runs in parallel (`pytest -n auto`); use `make test-fast` for a quick no-coverage inner loop.
- E2e tests that mutate project state use `e2e_workspace` / `*_workspace` (copy + relocated `workspace_dir`); never write into `tests/fixtures/` directly.
- New service methods → extend `tests/test_services.py` or a focused `test_<module>.py`.
- New MCP handler → `tests/test_mcp_tools.py` or `tests/test_mcp_nl.py`.

Do not defer tests to a follow-up commit.

## Tools vs skills (natural language)

- **MCP/CLI tools** are primitives: technical params (`track_id`, `start`/`end` times, effect name, preset). Optional `speaker` aliases to `track_id` via `resolve_track()`.
- **Skills** (`.agents/skills/`) document composition: search transcript → read timestamps → call the primitive. Do not embed transcript search or multi-step orchestration inside tools.
- Example: “remove where they talk about X” → skill runs `search_transcript_tool` then `ripple_delete_tool(start, end)`.

### Skill and MCP descriptions (selection hints)

Client-agnostic — any MCP-capable agent. Do not add IDE-specific skill frontmatter.

- **Skill YAML `description`:** third person; WHAT + WHEN; user trigger phrases; nearest-sibling contrast (“not X, use Y”). Keep under ~1024 chars. The markdown body is progressive disclosure — do not duplicate the whole workflow in YAML. Wrong skill → wrong whole workflow; sibling contrast pays off across the ~30 skills.
- **MCP tool docstring:** Python docstring → MCP `description` (what agents see with only the server connected). Required when adding/changing a tool, or when tools are confusable / user language ≠ tool name. First line = catalog blurb; include WHEN / NOT vs siblings. Skip restating the obvious for unique CRUD-ish tools (`history_undo`, `list_chapters_tool`) — catalog tokens every turn, weak average benefit. Prefer selective WHEN/NOT on confusable clusters over a blanket docstring backfill.

## GUI styling

Sharecut Studio chrome uses theme tokens, rem, and named `@container` queries — not magic padding/color/type or viewport-width `@media`. Exceptions (`!important`, `@layer`, canvas `px`) need a `stylelint-disable` with `-- user-approved:`. Detail: [gui-styling.md](gui-styling.md).

## Docs in sync

- Land work on a **feature branch** and open a PR to **`main`**; do not commit or push directly to `main` by default (see [git-workflow.md](git-workflow.md), [docs/contributing.md § Git workflow](../../docs/contributing.md#git-workflow)).
- Update `README.md`, `docs/architecture.md`, and feature docs (`docs/nl-editing.md`, `docs/inaudible-cuts.md`, `docs/social-clips.md`, `docs/timeline-comments.md`, etc.) in the **same PR/change** as code that makes them wrong.
- **Sharecut Studio shell / mobile IA / episode schema / share-or-session docs** → also update the [UX Pages pack](../../ux/README.md) (`ux/pages/`, demo fixture / screens when the visible UI changed). Triggers include `docs/host-online-relay.md`, `docs/session-sync.md`, and `docs/recording-session.md`. Pre-commit hook `ux-pack-sync` enforces this; agents must not skip it without `[skip ux-pack]` + a reason.
- New MCP tools or CLI commands → document in README or the relevant `docs/*.md` and `.agents/skills/` if agents use them. Timeline comments must stay available via MCP + skill **podcast-timeline-comments**, not GUI-only.
- **Sharecut Studio keyboard shortcuts** → add a `KEYMAP_COMMANDS` row + `commands/` handler and call `execute(id)` from buttons. Do not add another `window`/`document` `keydown` listener (governance: `gui/web/src/commands/governance.test.ts`). Run `make cheatsheet` so `docs/daw-shortcuts.md` and `ux/pages/shortcuts.md` stay generated.
- **New host capability** → update `contracts/capabilities.manifest.json` in the same change (service first, then thin adapters). See [docs/entry-points.md](../../docs/entry-points.md). Run `make schema-export` so https://docs.sharecut.studio/#/capabilities stays current. `make capabilities-check` / pre-commit enforce coverage + docs catalog.
- Do not ship behavior changes with outdated architecture or setup instructions.
