# Contributing

See also [AGENTS.md](../AGENTS.md) and [.agents/rules/engineering-standards.md](../.agents/rules/engineering-standards.md) for agent-facing summaries.

## Layering

New behavior belongs in the right layer:

| Layer | Package | Responsibility |
|-------|---------|------------------|
| Domain | `edits/`, `clips/`, `pipeline/`, `engines/`, `ingest/` | Pure logic, Pydantic models, no adapter-specific I/O |
| Application | `services/` | Orchestration, history labels, `load_defaults()` |
| Adapters | `cli/`, `mcp/tools/`, `gui/` | Parse arguments / HTTP, call services, format output |

Guest / share-token remote MCP: `services/remote_mcp/` (context, allowlist, protocol) + thin `mcp/tools/guest/` re-exports and `gui/routes/remote_mcp.py`. Tools wrap `ShareService` / `DocumentSyncService` — do not fork domain logic or accept arbitrary `project_path` from clients. Local host MCP (full tool surface, pinned episode) is the official SDK Streamable HTTP app mounted at `/mcp` on loopback binds — do not copy the guest JSON-RPC bridge.

Do not duplicate project load/save or history snapshot logic in CLI, MCP, or GUI. Use [`ProjectWorkspace`](../src/podcast_mcp/services/workspace.py) and [`run_mutation`](../src/podcast_mcp/history/session.py). GUI audio/pipeline must call `PlayService` / `PipelineService` (same as CLI), not reimplement artifact paths. Agent ↔ DAW transport uses [`SessionSyncService`](../src/podcast_mcp/services/session_sync/service.py) (typed commands + log); see [session-sync.md](session-sync.md). Facades: [`session_state`](../src/podcast_mcp/services/session_state.py) / [`SessionControlService`](../src/podcast_mcp/services/session_control.py). Keep `ffmpeg` subprocesses inside [`FFmpegEngine`](../src/podcast_mcp/engines/ffmpeg.py) so a later in-process mobile backend can swap in ([cross-platform-byok.md](cross-platform-byok.md) § Interim).

## Adding a feature

1. Implement domain logic (or extend an existing module).
2. Expose via a method on the appropriate service (`EditService`, `ClipService`, `CommentService`, `PlayService`, etc.).
3. Add a thin CLI command in `cli/<area>.py` and an MCP handler in `mcp/tools/<area>.py`. If the DAW viewer needs it, add a thin route under `gui/routes/` (`project.py` / `session.py` / `pipeline.py`) that calls the same service method; keep `gui/server.py` as `create_app` wiring only.
4. Register the MCP tool in `mcp/tools/__init__.py` via `register_all`.
5. Re-export the handler from `mcp/server.py` if tests call it directly.
6. Add tests under `tests/`; keep **≥95%** coverage (`make test`). For `gui/web/` changes, also run `make test-web` (oxlint + Stylelint + Biome `format:check` + strict `typecheck` + Vitest + build). Run `make lint-py` / `make format-py-check` (or `make ci`) so Ruff/Bandit/Vulture/Deptry stay green.
7. Update docs in the same change — see [AGENTS.md § Docs in sync](../AGENTS.md#docs-in-sync) (`README.md`, `docs/architecture.md`, feature docs, skills as needed).

### Python quality

- **Ruff** lint (`E`, `F`, `I`, `UP`, `B`, `SIM`, `RUF`) + format (`make format-py` / `make format-py-check`). Commits format staged `*.py` via lint-staged in `.githooks` (`make hooks`; needs `cd gui/web && npm ci`).
- **Bandit** (medium+ severity on `src/`), **Vulture** (dead code), **Deptry** (dependency hygiene).
- **mypy** (`make typecheck`; strict on timebase-critical modules — see `[tool.mypy]`).
- Do **not** add `# noqa` / `# nosec` / mass suppressions without **explicit user approval**. Prefer real fixes. For Bandit, fix findings or use a **line-level** `# nosec Bxxx` on audited call sites (put any rationale in a **separate** preceding comment — Bandit treats words after `# nosec` as test ids and warns). Do not globally skip security rules to greenwash CI.

### Sharecut Studio frontend quality

- **Strict TypeScript** (`gui/web` `tsconfig` `"strict": true`).
- **oxlint** for JS/TS (incl. `jsx-a11y`, `react/exhaustive-deps`, `react/only-export-components`, plus hygiene: `typescript/no-explicit-any`, `typescript/ban-ts-comment`, type-aware `typescript/no-floating-promises` / `typescript/no-misused-promises` / `typescript/no-redundant-type-constituents` / `typescript/restrict-template-expressions` / `typescript/no-base-to-string` / `typescript/no-meaningless-void-operator` via `options.typeAware` + `oxlint-tsgolint`, `eqeqeq` with `null: ignore`, `prefer-const`, `no-var`, `no-console` — CLI under `scripts/` may log).
- **Stylelint** for CSS: outside `src/styles/theme/`, colors, padding, margin, gap, font-size, and radius must be theme `var(--…)` (`declaration-strict-value`); chrome is rem (`meowtec/no-px`, ignore `1px`/`-1px`); viewport-size `@media` (`width`/`height`) is off — use named `@container` (`app` / `timeline`). `declaration-no-important` and `at-rule-disallowed-list: layer` are on; `font-size: 62.5%` is banned. Exceptions need `/* stylelint-disable-next-line RULE -- user-approved: reason */`. Stylelint ignores `src/styles/theme/`; `tests/test_css_policy.py` (and `tests/test_css_no_important.py`) cover that tree plus `deploy/`, `ux/assets`, `docs-site/assets`, relay `static/`, and the desktop splash **without stripping comments**. Python must not author CSS colors (`color:#…` in `.py`); load `.css` files instead. Agent judgment: [.agents/rules/gui-styling.md](../.agents/rules/gui-styling.md).
- **Biome** formats TS/CSS/JSON (linter off). Commits format staged `gui/web/` files via lint-staged (`.githooks` / `make hooks`) and restage them. Do **not** put `biome check --write` / `ruff format` in `.pre-commit-config.yaml` — pre-commit fails the commit whenever a hook rewrites files. That YAML stays check-only (`ux-pack-sync`, schema, capabilities, cheatsheet).
- Do **not** add `eslint-disable` / `oxlint-disable` / `biome-ignore` / `stylelint-disable` without **explicit user approval**. Stylelint exceptions: `/* stylelint-disable-next-line RULE -- user-approved: reason */`. Fix the code or add a token instead.

## Git workflow

Default delivery path is **feature branch → pull request → `main`**. Agents and contributors should not push commits straight to `main` unless the user explicitly says to.

1. `git checkout main && git pull` (start from latest `main`).
2. `git checkout -b type/short-kebab-description`.
3. Implement code, tests, and docs in the same change.
4. When asked to ship: create one or more focused commits on the branch.
5. Prefer `make ci` before push so `ci-stamp` (under `$(git rev-parse --git-dir)`) matches a clean `HEAD` and pre-push is instant; otherwise `.githooks/pre-push` runs `make ci` and **aborts the push** if red, dirty, or if the pushed tip ≠ checkout `HEAD`. A green `make ci` with leftover tracked dirt still exits 0 and skips `ci-stamp`; the next push re-runs `make ci` once the tree is clean. Escape hatch: `SKIP_CI=1 git push` only when the user explicitly asks (same bar as `--no-verify`). Agents: use a long shell `block_until_ms` for `git push`. Detail: [testing.md § Pre-push local CI gate](testing.md#pre-push-local-ci-gate).
6. `git push -u origin HEAD`.
7. `gh pr create` with base **`main`**. Prefer small, focused PRs; split disparate changes into separate branches/PRs when practical. If the PR should close GitHub issues, put `Fixes #N` (or `Closes` / `Resolves`) on its own line in the PR body — merge into `main` then auto-closes them. A `#N` mention without a keyword does not.
8. Do not merge the PR (and do not force-push `main`) unless the user asks.

### Branch names

Format: `type/short-kebab-description` (lowercase, no spaces).

| Prefix | Use |
|--------|-----|
| `feat/` | New behavior |
| `fix/` | Bug fix |
| `docs/` | Documentation / agent instructions only |
| `chore/` | Tooling, deps, housekeeping |
| `refactor/` | Internal restructure without behavior change |
| `test/` | Tests only |

Examples: `feat/guest-sign-in-ui`, `fix/share-acl-401`, `docs/agent-pr-workflow`.

Still only create commits or PRs when the user asks to ship (or clearly says to open a PR); this section defines *how* shipping happens.

## Docs in sync

Treat documentation like tests: part of the deliverable, not a follow-up.

- **Architecture or package moves** → `docs/architecture.md`
- **User-facing commands or install** → `README.md`, `docs/getting-started.md`
- **MCP/CLI behavior agents rely on** → feature docs under `docs/` and `.agents/skills/`
- **Defaults or export layout** → `.agents/defaults/pipeline.yaml` and any pipeline doc
- **Sharecut Studio CSS / theme tokens / units** → [.agents/rules/gui-styling.md](../.agents/rules/gui-styling.md), [gui/web/README.md](../gui/web/README.md), [ux/pages/brand.md](../ux/pages/brand.md) § Units, [docs/gui-mobile.md](gui-mobile.md)
- **Sharecut Studio UI / mobile shells / episode schema / share or session-sync docs visible to UX** → [ux/](../ux/README.md) Pages pack (`ux/pages/` including [brand.md](../ux/pages/brand.md) for visual guidelines, and `tests/fixtures/sharecut_ux_demo/` / screenshots when the UI changed). Install hooks with `make hooks` (`core.hooksPath=.githooks`). Format-on-commit is lint-staged (needs `cd gui/web && npm ci`). Check-only hooks (`ux-pack-sync`, schema, capabilities, cheatsheet) run only when the `pre-commit` CLI is installed (`uv tool install pre-commit`). Then `ux-pack-sync` blocks commits that touch GUI shells or related docs (`docs/gui-mobile.md`, `docs/host-online-relay.md`, `docs/session-sync.md`, `docs/recording-session.md`, …) without a UX pack update.
- **Sharecut Studio keymap / command catalog** → run `make cheatsheet` (updates `docs/daw-shortcuts.md` + `ux/pages/shortcuts.md`). `make cheatsheet-check` / pre-commit `keymap-cheatsheet` / `make test-web` fail if stale. Pages **Copy Markdown** is the Google Docs path.
- **New host capability (GUI / keys / MCP / CLI / skill)** → update [`contracts/capabilities.manifest.json`](../contracts/capabilities.manifest.json) in the same change. Recipe: [entry-points.md](entry-points.md). Run `make schema-export` so [docs.sharecut.studio/#/capabilities](https://docs.sharecut.studio/#/capabilities) stays current. `make capabilities-check` / pre-commit `capabilities-manifest` / `make ci` fail if COMMANDS, keymap, registered MCP tools, skills, or the published capabilities page drift from the manifest. That JSON is the **host** adapter catalog — not the share ACL (`play` / `view` / `comment` / … in [`share_capabilities.py`](../src/podcast_mcp/edits/share_capabilities.py)). `omit.guest` is docs-only. Do not put `guest_*` in `surfaces.mcp`.
- **New share GUI action** → ship the **share HTTP** route in the same PR (`has_capability` / document-command allowlists). Add a named `guest_*` MCP wrapper only when agents need a tool-shaped job. Do not add powers only on MCP or only in the GUI. See [host-online-relay.md](host-online-relay.md) § Remote MCP.
- **Document-plane command payloads** → Pydantic models in `services/document_sync/payloads.py`; run `make schema-export` after changing them. `make schema-check` / pre-commit / `make ci` fail if `schemas/document-commands.schema.json`, `docs-site/pages/document-commands.md`, capabilities catalog, share/MCP generated tables, or `docs-site/schemas/` are stale. Live catalog: [docs.sharecut.studio/#/document-commands](https://docs.sharecut.studio/#/document-commands). Boundary rejects + OpenAPI/MCP schema equality: `tests/test_document_command_boundary.py`. Narrative docs: [session-sync.md](session-sync.md) § Document plane (point at the schema / docs site; do not duplicate field lists).
- **Developer docs pack (`docs-site/`)** → public site contents are versioned here; deployment is private operations work. Quickstart / errors / threat model are hand pages; command catalog, share routes, MCP tool matrix, and guest OpenAPI are generated. Public API is **alpha** (banner on home) — no dated changelog until first external release.

If you would need to explain the change in a PR comment because the docs are wrong, update the docs instead.

## MCP tool names

Do not rename existing MCP tools without updating `.agents/skills/` and `docs/nl-editing.md`. Skills and external agents depend on stable tool identifiers.

### Skill and MCP descriptions

Portable selection hints (any MCP client). Detail: [`.agents/rules/engineering-standards.md`](../.agents/rules/engineering-standards.md) § Skill and MCP descriptions.

- Every `.agents/skills/*/SKILL.md` needs YAML `name` (matching the directory) and a non-empty `description` (WHAT + WHEN, trigger phrases, nearest-sibling contrast). Enforced by `scripts/check_capabilities_manifest.py`.
- New/changed MCP tools: add a short docstring when the tool is confusable with a sibling or when user language ≠ the tool name. Do not blanket-fill unique CRUD tools.

## Time handling (source vs timeline clock)

Stored times (`TranscriptWord`, `EditDecision`, `CombinedUtterance`) are **source-media seconds**; rendered audio is **timeline seconds**. See [architecture.md § Timebase](architecture.md#timebase-source-vs-timeline-clock).

When writing new code that deals with time:

1. **Never inline clip arithmetic** (`source_start + (t - timeline_start)` and friends). Use [`SessionTimeline`](../src/podcast_mcp/engines/session_timeline.py) for project-level mapping, `clip_timeline_overlap_to_source` / `clip_timeline_point_to_source` for clip-list edit/render code, or the `Clip.timeline_end` property for geometry. `tests/test_timebase_guards.py` fails CI otherwise.
2. **Touching rendered audio** (stems, premix, mastered, export, captions, chapters, social clips)? Map source→timeline through the mapper first.
3. **New MCP tool with a seconds parameter?** Add an entry to `TOOL_TIMEBASE` in [`util/tool_timebase.py`](../src/podcast_mcp/util/tool_timebase.py) declaring `"source"` or `"timeline"`; `tests/test_time_conformance.py` fails until you do.
4. **Search results** carry both clocks via `TranscriptMatch.timeline_start/end` — never re-derive them in a caller.

## History (non-destructive, undoable state)

Podcast MCP treats **all editable project state** as undoable unless explicitly documented otherwise (e.g. pipeline run logs).

### Contract

1. **Never modify `raw/`** — source recordings stay untouched; FFmpeg applies cuts/effects at render.
2. **Undoable mutations** use `ProjectWorkspace.mutate(label_before, label_after, fn)` or [`run_mutation`](../src/podcast_mcp/history/session.py), which:
   - records a snapshot **before** the change,
   - runs the domain mutation on `EpisodeProject`,
   - records a snapshot **after** the change,
   - commits via `ProjectStore` (updates `episode.project.json` and mirrored `transcripts/*.json` caches).
3. **New features** add a service method that delegates to `mutate`; CLI/MCP handlers stay thin.
4. **Batch work** (e.g. transcript cleanup, multi-cut approve) should use **one** `mutate` per user-confirmed step so a single undo reverts the whole batch.
5. **Skills** that orchestrate mutations must mention `history_undo` and prefer batch tools where they exist.

### Transcript sync after audio changes

Operations that change audible output (gain, mute, FX, cuts, clips, envelopes, balance, etc.) must keep per-track transcripts aligned via **reconciliation** — see [architecture.md § Automatic transcript sync](architecture.md#automatic-transcript-sync).

1. **Mutations** — use `ProjectWorkspace.mutate` / `run_mutation`. Staleness is tracked automatically. Most audio edits invalidate rendered stems; run `render_preview` next so reconciliation sees processed audio.
2. **Renders** — use `rerender_preview` / `PipelineService.render_preview`. With default `reconcile_on_render: true`, transcript audibility metadata updates after each preview render (primary automatic sync path).
3. **Suppression** — default `transcript_mode: reconcile` applies bleed/inaudible suppressions and rebuilds combined after render (undo via history). Use `reconcile-transcript --dry-run` or `suppress-bleed --dry-run` to preview without mutating. Prefer `suppress-bleed` for bleed-only scoped cleanup (`--start` / `--end`, `--exclude-words-json` for keep-words). Set `transcript_mode: flag` in pipeline defaults only when tagging without auto-suppress.
4. **New pipeline or edit steps** — if the step changes what is heard, add it to `AUDIO_AFFECTING_STEPS` in `pipeline/runner.py` when run via the pipeline, and ensure the service path uses `mutate` + render as appropriate.
5. **Long-running work** — adapters wrap automatically (MCP/CLI/pipeline/guest/GUI). Domain uses `progress_task` / `resolve_progress`; do not hardcode `NullProgress()` at edges or add parallel timers. Exemptions need explicit user approval in `contracts/progress-exemptions.json`. Spec: [progress.md](progress.md); CLI flags: [cli-progress.md](cli-progress.md). `make progress-check` (warn by default).

### Do not

- Call domain functions in `edits/` directly from adapters or agent scripts on a loaded project.
- Use `ws.save()` / `save_project()` alone when transcript, edit, mix, or timeline fields changed.
- Hand-edit `transcripts/*.json`; always go through the project store.
- Bypass reconciliation by mutating `EpisodeProject` outside `run_mutation` when audio-affecting fields change.

### Tests

Undo behavior: `tests/test_history.py`, `tests/test_history_session.py`, and feature-specific tests (e.g. `tests/test_transcript_cleanup_history.py`).

Operator docs: [history.md](history.md). Agent bundle: [.agents/INSTRUCTIONS.md](../.agents/INSTRUCTIONS.md), [engineering-standards.md](../.agents/rules/engineering-standards.md).
