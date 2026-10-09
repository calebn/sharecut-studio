# Contributing

See also [AGENTS.md](../AGENTS.md) and [.agents/rules/engineering-standards.md](../.agents/rules/engineering-standards.md) for agent-facing summaries.

For Sharecut Studio beta UI work, follow the trust-first
[UI philosophy](ui-philosophy.md). Its principles describe required behavior;
check the relevant surface before claiming a feature is already present.
User-facing copy, terminology, control placement, and mobile ergonomics follow
the [communication philosophy](communication-philosophy.md); the UI philosophy
wins where they overlap.

## Layering

New behavior belongs in the right layer:

| Layer | Package | Responsibility |
|-------|---------|------------------|
| Domain | `edits/`, `clips/`, `pipeline/`, `engines/`, `ingest/` | Pure logic, Pydantic models, no adapter-specific I/O |
| Application | `services/` | Orchestration, history labels, `load_defaults()` |
| Adapters | `cli/`, `mcp/tools/`, `gui/` | Parse arguments / HTTP, call services, format output |

Guest / share-token remote MCP: `services/remote_mcp/` (context, allowlist, protocol) + thin `mcp/tools/guest/` re-exports and `gui/routes/remote_mcp.py`. Tools wrap `ShareService` / `DocumentSyncService` — do not fork domain logic or accept arbitrary `project_path` from clients. Local host MCP (full tool surface, pinned episode) is the official SDK Streamable HTTP app mounted at `/mcp` on loopback binds — do not copy the guest JSON-RPC bridge.

Do not duplicate project load/save or history snapshot logic in CLI, MCP, or GUI. Use [`ProjectWorkspace`](../src/podcast_mcp/services/app/workspace.py) and [`run_mutation`](../src/podcast_mcp/history/session.py). GUI audio/pipeline must call `PlayService` / `PipelineService` (same as CLI), not reimplement artifact paths. Agent ↔ DAW transport uses [`SessionSyncService`](../src/podcast_mcp/services/session_sync/service.py) (typed commands + log); see [session-sync.md](session-sync.md). Facades: [`SessionControlService`](../src/podcast_mcp/services/collaboration/session_control.py). Keep `ffmpeg` subprocesses inside [`FFmpegEngine`](../src/podcast_mcp/engines/ffmpeg.py) so a later in-process mobile backend can swap in ([cross-platform-byok.md](cross-platform-byok.md) § Interim).

For play adapters, translate once into `PlayRequest` and keep playback decisions in `PlayService`. CLI flags and MCP tool names may change with the contract; update their callers, skills, and docs in the same change. Pass transcript-query playback booleans by keyword. `util.process.run` intentionally keeps `subprocess.run` meanings for `check`, `capture_output`, and `text`, while rejecting shell strings.

Use [`util.hashing.sha256_file`](../src/podcast_mcp/util/hashing.py) for streamed full-file SHA-256 digests and `short_digest(text, length)` for UTF-8 text prefixes. Callers still own the text serialization and the required prefix length. Pinned model snapshots declare a `util.model_manifest` `FileManifest` (every downloaded file with its sha256) and verify it with `manifest_mismatch`; do not add a one-file pin.
Use [`util.atomic_file.atomic_write`](../src/podcast_mcp/util/atomic_file.py) for replace-existing files written as bytes through a callback, or `publish_completed_file` when a renderer or downloader has already written a caller-owned temporary file. `atomic_write` defaults to private creation (`0o600`); pass `creation_mode=0o666` when the current file workflow should follow the process umask. An explicit `mode` sets the final mode, and copy metadata stays with its caller. Keep validation and ordering hooks in the caller; the shared publisher handles file sync, replacement, directory sync, and temporary-file cleanup.
Use [`util.workspace_paths.resolve_within`](../src/podcast_mcp/util/workspace_paths.py) for path containment. Keep caller-specific path syntax and error messages at the call site; the utility resolves symlinks and rejects escapes from the allowed root.

### Service context imports

Import `ProjectWorkspace`, `FanoutHub`, and GUI launch symbols from `podcast_mcp.services.app`. Import session host-binding auth from `podcast_mcp.services.session_sync`. The root `podcast_mcp.services` package has no aggregate exports. Import declared names from the owning context facade for all eleven service contexts. Implementation modules are private to their context and focused tests. Service code must not import `gui.routes`; the narrow remaining GUI helper dependencies are listed in [architecture.md](architecture.md#service-contexts).

Runtime diagnostics, configuration checks, diagnostic bundles, and report
submission belong in `services/support/`. Pipeline execution, configuration,
Analyze, and component bootstrap belong in `services/pipeline/`. Import declared
symbols from `podcast_mcp.services.support` or `podcast_mcp.services.pipeline`
in adapters and sibling services. Import implementation modules only within
their owning context or in focused tests. Support reads pipeline component
status through the pipeline facade; pipeline may use the existing workspace
service. These contexts reject adapter dependencies. Media services may use the app
workspace and pipeline ASR options through public facades. Import media operations
from `podcast_mcp.services.media`; implementation modules under `services/media/`
are private to that context and focused tests. Source copying belongs to
`media_store.ensure_audio_in_workspace`, called through the facade by
`EpisodeService`, rather than the domain `edits.track_media` module.

Episode editing, playback, history, comments, and boundary orchestration belong
in `services/document/`. Import declared symbols from
`podcast_mcp.services.document`; implementation modules are private to that
context and focused tests. Document services use the app, media, and pipeline
facades.
Document and session sync own separate command and transport logs. The
collaboration context owns share, review, guest progress, record-share,
session-control, share-page, and tunnel orchestration. Record, share-auth, and
remote-MCP contexts expose their current workflows through lazy facades.

When a service context changes, migrate callers and test patch targets together,
delete old paths, and update the explicit facade exports. Extend
`tests/test_service_boundaries.py` when adding a context. Its registry rejects
unregistered packages and flat service modules. The `service-boundaries`
pre-commit hook runs that test whenever a commit stages files under
`src/podcast_mcp/services/`, so a direct submodule import fails at commit time
rather than in CI.

Patch test dependencies where the consumer imports them. When an adapter imports
a facade export inside a handler, patch that export on the facade.

## Beta interfaces

Sharecut Studio is in beta and has no users. Breaking changes are allowed. Prefer one clear contract over backward compatibility: update every current caller, test, and affected document, then delete the obsolete API or implementation. Do not add compatibility-only overloads, aliases, fallbacks, or migrations for old clients or project formats. Keep separate paths when they serve distinct current workflows, such as immediate editing and draft audition.


## Adding a feature

1. Implement domain logic (or extend an existing module).
2. Expose via a method on the appropriate service (`EditService`, `ClipService`, `CommentService`, `PlayService`, etc.).
3. Add a thin CLI command in `cli/<area>.py` and an MCP handler in `mcp/tools/<area>.py`. If the DAW viewer needs it, add a thin route under `gui/routes/` (`project.py` / `session.py` / `pipeline.py`) that calls the same service method; keep `gui/server.py` as `create_app` wiring only. Gate owner routes with `require_host` from `gui/routes/deps.py` (host role); never copy a per-module `_auth` helper.
4. Register the MCP tool in `mcp/tools/__init__.py` via `register_all`. A new `MCPServer.call_tool` wrapper (progress, busy errors, project injection, …) uses `util.mcp_call_tool.wrap_call_tool` instead of re-declaring the forwarding signature.
5. Re-export the handler from `mcp/server.py` if tests call it directly.
6. Add tests under `tests/`; run the affected tests locally with `--no-cov`, plus `make lint-py` / `make format-py-check` / `make typecheck` for Python changes. GitHub Actions runs the full `make test` suite and enforces **≥95%** coverage on the PR. For `gui/web/` changes, run focused Vitest tests and relevant static checks locally; CI runs the equivalent frontend checks (oxlint + Stylelint + Biome `format:check` + strict `typecheck` + Vitest + build). Use local `make test` / `make ci` for extensive changes or full-suite diagnosis.
7. Update docs in the same change — see [AGENTS.md § Docs in sync](../AGENTS.md#docs-in-sync) (`README.md`, `docs/architecture.md`, feature docs, skills as needed).

### Python quality

- **Ruff** lint (`E`, `F`, `I`, `UP`, `B`, `SIM`, `RUF`) + format (`make format-py` / `make format-py-check`). Commits format staged `*.py` via lint-staged in `.githooks` (`make hooks`; in a new worktree `make worktree-setup`, which the hook also runs automatically when `.venv` / `gui/web/node_modules` are missing).
- **Bandit** (medium+ severity on `src/`), **Vulture** (dead code), **Deptry** (dependency hygiene).
- **mypy** (`make typecheck`; strict on timebase-critical modules — see `[tool.mypy]`).
- Do **not** add `# noqa` / `# nosec` / mass suppressions without **explicit user approval**. Prefer real fixes. For Bandit, fix findings or use a **line-level** `# nosec Bxxx` on audited call sites (put any rationale in a **separate** preceding comment — Bandit treats words after `# nosec` as test ids and warns). Do not globally skip security rules to greenwash CI.

### Sharecut Studio frontend quality

Positive z-index values in timeline and mixer partials use the named roles in
[`docs/design-tokens.md`](design-tokens.md#elevation); the focused Stylelint
and pytest rules cover those partials.

Codex contributors also have [Impeccable design hooks](setup.md#impeccable-design-hooks)
for feedback on web edits. Trust the project definitions in Settings → Hooks.
Keep their upstream launcher and reference files together when updating the
vendored skill. Repo styling and approval rules take precedence over upstream
suggestions, including advice to add detector ignores.

- **Strict TypeScript** (`gui/web` `tsconfig` `"strict": true`).
- **oxlint** for JS/TS (incl. `jsx-a11y`, `react/exhaustive-deps`, `react/only-export-components`, plus hygiene: `typescript/no-explicit-any`, `typescript/ban-ts-comment`, type-aware `typescript/no-floating-promises` / `typescript/no-misused-promises` / `typescript/no-redundant-type-constituents` / `typescript/restrict-template-expressions` / `typescript/no-base-to-string` / `typescript/no-meaningless-void-operator` via `options.typeAware` + `oxlint-tsgolint`, `eqeqeq` with `null: ignore`, `prefer-const`, `no-var`, `no-console` — CLI under `scripts/` may log).
- **Stylelint** for CSS: outside `src/styles/theme/`, colors, padding, margin, gap, font-size, and radius must be theme `var(--…)` (`declaration-strict-value`); chrome is rem (`meowtec/no-px`, ignore `1px`/`-1px`); viewport-size `@media` (`width`/`height`) is off — use named `@container` (`app` / `timeline`). `declaration-no-important` and `at-rule-disallowed-list: layer` are on; `font-size: 62.5%` is banned. Transitions and animations time with `--motion-*` tokens (`declaration-property-unit-disallowed-list` rejects any literal `ms`/`s`; stop motion with `none`), and `tests/test_css_policy.py` also requires those in `partials/` to sit inside `@media (prefers-reduced-motion: no-preference)`, loops included. Exceptions need `/* stylelint-disable-next-line RULE -- user-approved: reason */`. Stylelint ignores `src/styles/theme/`; `tests/test_css_policy.py` (and `tests/test_css_no_important.py`) cover that tree plus `deploy/`, `ux/assets`, `docs-site/assets`, relay `static/`, and the desktop splash **without stripping comments**. Python must not author CSS colors (`color:#…` in `.py`); load `.css` files instead. Agent judgment: [.agents/rules/gui-styling.md](../.agents/rules/gui-styling.md).
- **Biome** formats TS/CSS/JSON (linter off). Commits format staged `gui/web/` files via lint-staged (`.githooks` / `make hooks`) and restage them. Do **not** put `biome check --write` / `ruff format` in `.pre-commit-config.yaml` — pre-commit fails the commit whenever a hook rewrites files. That YAML stays check-only (`docs-sync`, schema, capabilities, cheatsheet).
- **DAW store reads** go through selectors only: `useDaw(selector)` (applies `useShallow`) or `useDawStore(selector)`. Use `pickDaw("projectPath", "isPlaying")` at module scope for plain field selectors. Its literal keys let `gui/web/src/state/storeGovernance.test.ts` check hot-field reads. Use a custom `useDaw` selector for conditional projections of store values. Select exactly the values you read, return primitives or store references, and build derived arrays and objects with `useMemo` outside the selector. The governance test fails CI on whole-store reads (no selector, or an inline arrow identity selector such as `(s) => s`). Hot fields (`playheadSec`, `scrollLeft`, `sessionClients`, `pointerTrackId`, `bladeHoverSec`) may be selected only by a file in that test's `HOT_FIELD_ALLOWLIST`, each entry naming why (a leaf isolating its own re-renders, or non-component code reading live state outside render). The source scan checks inline and hoisted selectors, destructured reads, and literal `pickDaw` keys. The `pickDaw` scan skips calls in comments and strings, rejects nonliteral arguments, and fails on stale allowlist entries. Detail: [gui/web/README.md](../gui/web/README.md).
- Do **not** add `eslint-disable` / `oxlint-disable` / `biome-ignore` / `stylelint-disable` without **explicit user approval**. Stylelint exceptions: `/* stylelint-disable-next-line RULE -- user-approved: reason */`. Fix the code or add a token instead.
- **PR checklist.** User-facing copy and control placement follow [`docs/communication-philosophy.md`](communication-philosophy.md) (terminology table, placement rules, mobile checklist). Deviations from its "never" rules need maintainer sign-off recorded in the PR.

#### Decision: Run an Impeccable design pass on every UI change

<!-- decision
id: D-impeccable-design-pass
status: accepted
date: 2026-10-06
decided-by: calebn
evidence:
- #1026 to #1034, "Design pass (owner directive 2026-10-06)": "critique and refine every UI, UX or GUI change"
- same comment: "before implementing and again before the PR"; "Detector suppressions need explicit owner approval."
- #876 vendored the skill and Codex hooks; #1039 made it load in Claude Code
enforced-by:
- tests/test_impeccable_hooks.py::test_design_hooks_enabled_with_portable_launcher_and_private_state
- tests/test_impeccable_hooks.py::test_claude_code_discovers_the_repo_skills
manual-review: no check can prove a design pass happened; the PR author runs `/impeccable` and the reviewer asks for its result
-->

Run the repo's Impeccable skill on every UI, UX or GUI change, before
implementing and again before the PR, and put the same step in every agent
brief for `gui/web/` work. The tests above check only that the skill and hooks
are wired. Repo rules win over upstream advice, and a detector suppression,
including a lint override in config, needs explicit owner approval.

### Dependency updates (Dependabot)

Dependabot PRs (`.github/dependabot.yml`) are ordinary PRs against `main`. For the `uv` ecosystem, Dependabot updates `pyproject.toml` and
`uv.lock` together in the same PR. A new lockfile directory (a new `gui/*`
package or a new Rust/uv root) needs a new `updates` entry in the same change
that adds the lockfile — `tests/test_dependabot_config.py` enforces this.

The `frontend` CI job also runs `npm audit --omit=dev --audit-level=high` as an
advisory, non-blocking step; ignoring a real finding it surfaces still needs
**explicit user approval**, same as any other suppressed check. See
[docs/testing.md § Dependency updates and audit](testing.md#dependency-updates-and-audit).

## Git workflow

Follow the [Git policy](../.agents/skills/sharecut-poteto/references/git-workflow.md)
for fresh worktrees, branch names, focused commits, draft PRs, issue links,
required checks, and rebase merges. Read the
[issue claims](../.agents/skills/sharecut-poteto/references/issue-claims.md)
before work on a GitHub issue.

Create commits and PRs when the user asks to ship or clearly authorizes that work.
Merge requires the user's current grant. Opening a PR does not grant merge authority.

### Review evidence

Screenshots, receipts and before/after records for one issue belong in the PR description or a PR comment. Do not commit `docs/issue-<n>/` folders: rebase-merge keeps every commit, so evidence added and later removed still stays in `main`'s history. Durable findings go into the doc that owns the behavior. `tests/test_docs_layout.py` fails when a tracked `docs/issue-<n>/` path exists.

### Native Poteto companion

Use [sharecut-poteto](../.agents/skills/sharecut-poteto/SKILL.md) for contributor
work. It discovers the installed native `poteto-mode` skill and reads it in full.
Native Poteto owns request routing, playbooks, delegation, review, and Shipping.
The companion supplies repository policy and keeps the episode and product skills active.
Install native Poteto separately if it is absent. `podcast setup --global-skills`
exports the repository companion, not its upstream dependency.

The [Git policy](../.agents/skills/sharecut-poteto/references/git-workflow.md)
requires exact-head CI, unresolved-review checks, an independent native Shipping
verdict, and applicable owner listening or product approval before an authorized merge.
For an issue-backed PR, `scripts/poteto_issue_gate.py` adds a manual, read-only,
fail-closed repository predicate. Its success does not replace native Shipping or
grant permission to merge. Do not invent an issue for a contributor PR to call it.

## Docs in sync

Treat documentation like tests: part of the deliverable, not a follow-up.

The map of which docs change with which code is [AGENTS.md § Docs in sync](../AGENTS.md#docs-in-sync). It is generated from [`contracts/docs-sync.json`](../contracts/docs-sync.json); edit the contract, then run `make docs-sync-table`. Run `make docs-sync` before opening a PR. It is the same PR-diff check CI runs: a fired **gate** rule with no matching doc change fails the PR, and an **advisory** rule only reports. When a rule really does not apply, waive it on any commit in the branch with `git commit --trailer "Docs-Sync-Waive: <rule-id> <reason>"`. The `docs-sync` pre-commit hook runs the same check on the branch so far and only warns.

Docs-sync proves a doc was touched, not that it is right. Before opening a PR, reread every doc you changed next to the code it describes and cut or correct any claim the code does not support (for example "always", "never", defaults, limits, or a path or symbol that does not exist). Reviewers check changed docs against the code as part of native review.

**Keeping gates honest.** A rule is promoted from `advisory` to `gate` only when it fired at least 6 times in a 100-PR `make docs-sync-replay` and its docs were updated every time. Rerun the replay every 50 or so merged PRs, or when a gate starts to feel noisy. Its summary lists each rule's `kind`, firings, `satisfied` and `trivial` firings (satisfying doc edits of at most 2 changed lines in total), `waived` firings and `waive_rate`, with flagged gates first. A gate appears in `flags` when it is waived on more than 1 in 10 of its firings, or when more than half of the edits that satisfy it are trivial. Demote it by renaming its `gate` key to `advisory` in `contracts/docs-sync.json`. Don't add gates below that bar. The `decision-*` rules start as advisory: a change to code under a recorded decision gets a reminder to revisit it, without blocking unrelated edits such as performance work. Promote one to a gate only when it clears the replay bar above. Where a doc can be generated from code, as `make schema-export` and `make cheatsheet` already do, generate it instead of gating it.

The bullets below add how-to detail for rows that need more than a doc path.

- **Sharecut Studio UI / mobile shells / episode schema / share or session-sync docs visible to UX** → [ux/](../ux/README.md) Pages pack (`ux/pages/` including [brand.md](../ux/pages/brand.md) for visual guidelines, and `tests/fixtures/sharecut_ux_demo/` / screenshots when the UI changed). Follow [UI philosophy](ui-philosophy.md) for beta trust requirements and the [communication philosophy](communication-philosophy.md) for copy, terminology, and placement. Install hooks with `make hooks` (`core.hooksPath=.githooks`). Format-on-commit is lint-staged (the hook provisions `gui/web` node_modules via `make worktree-setup` when missing). Check-only hooks (`docs-sync`, `docs-sync-table`, schema, capabilities, cheatsheet) run via the `pre-commit` CLI, or `uvx pre-commit` when it is not installed. The `ux-pack` gate rule checks the subset of those paths listed in the contract; a fired rule with no UX pack update fails CI unless waived.
- **Sharecut Studio keymap / command catalog** → run `make cheatsheet` (updates `docs/daw-shortcuts.md` + `ux/pages/shortcuts.md`). `make cheatsheet-check` / pre-commit `keymap-cheatsheet` / `make test-web` fail if stale. Pages **Copy Markdown** is the Google Docs path.
- **New host capability (GUI / keys / MCP / CLI / skill)** → update [`contracts/capabilities.manifest.json`](../contracts/capabilities.manifest.json) in the same change. Recipe: [entry-points.md](entry-points.md). Every row declares `effect: project | session | view`; a `project` row needs an MCP tool or CLI command over the same service or document command (or an owner-approved `omit.agent_reason`), and `make capabilities-check` enforces it. Run `make schema-export` so [docs.sharecut.studio/#/capabilities](https://docs.sharecut.studio/#/capabilities) stays current. `make capabilities-check` / pre-commit `capabilities-manifest` / `make ci` fail if COMMANDS, keymap, registered MCP tools, skills, or the published capabilities page drift from the manifest. That JSON is the **host** adapter catalog — not the share ACL (`play` / `view` / `comment` / … in [`share_capabilities.py`](../src/podcast_mcp/edits/share_capabilities.py)). `omit.guest` is docs-only. Do not put `guest_*` in `surfaces.mcp`.
- **New share GUI action** → ship the **share HTTP** route in the same PR (`has_capability` / document-command allowlists). Add a named `guest_*` MCP wrapper only when agents need a tool-shaped job. Do not add powers only on MCP or only in the GUI. See [host-online-relay.md](host-online-relay.md) § Remote MCP.
- **Document-plane command payloads** → Pydantic models in `services/document_sync/payloads.py`; run `make schema-export` after changing them. `make schema-check` / pre-commit / `make ci` fail if `schemas/document-commands.schema.json`, `docs-site/pages/document-commands.md`, capabilities catalog, share/MCP generated tables, or `docs-site/schemas/` are stale. Live catalog: [docs.sharecut.studio/#/document-commands](https://docs.sharecut.studio/#/document-commands). Boundary rejects + OpenAPI/MCP schema equality: `tests/test_document_command_boundary.py`. Narrative docs: [session-sync.md](session-sync.md) § Document plane (point at the schema / docs site; do not duplicate field lists).
- **Developer docs pack (`docs-site/`)** → public site contents are versioned here; deployment is private operations work. Quickstart / errors / threat model are hand pages; command catalog, share routes, MCP tool matrix, and guest OpenAPI are generated. Public API is **alpha** (banner on home) — no dated changelog until first external release.

If you would need to explain the change in a PR comment because the docs are wrong, update the docs instead.

### Decisions

A product or design decision lives in the doc it governs as a decision block:
a `Decision: ` heading followed by a comment that holds its id, status, date,
evidence and enforcement. Write one when the owner settles a question the next
contributor could reopen. An accepted block names a test, docs-sync rule or
make target that fails when the behaviour changes, or says why only a person
can review it. A new decision enters the PR as a proposed block, and the
owner's approval makes it accepted. A later decision supersedes it in place,
next to the old block. Run `make decisions-index` after adding or editing a
block. The format, lifecycle and generated index are in
[decisions/README.md](decisions/README.md).

## MCP tool names

Do not rename existing MCP tools without updating `.agents/skills/` and `docs/nl-editing.md`. Skills and external agents depend on stable tool identifiers.

### Structured MCP arguments

A tool that takes a list or an object declares it as a typed parameter: `list[str]` for ids and names, `JsonObject` / `JsonObjectList` from [`mcp/args.py`](../src/podcast_mcp/mcp/args.py) for free-form objects. Never take JSON text in a `str` parameter (`*_json: str`) and `json.loads` it in the handler. The SDK validates the typed value at the boundary, advertises its shape in the tool schema, and decodes a stringified structure from clients that send one. It decodes any string sent to a parameter not annotated exactly `str`, which broke JSON text in `*_json: str | None` parameters (#1173) and free text (#1175): `body="null"` arrived as `None` and was skipped as omitted, `expected_text="null"` skipped its guard, and `body="[1]"` arrived as a list and was rejected. `install_free_text_args` in `mcp/args.py`, installed on the server before `register_all`, fixes free text once for every tool (a workaround for the open SDK bug modelcontextprotocol/python-sdk#3055; delete it once an mcp release fixes that): a string sent to a `str` or `str | None` parameter reaches the tool verbatim, and only JSON `null` (or omitting the argument) means "not given". Declare free text as plain `str` / `str | None`; no per-tool wiring. `tests/test_mcp_structured_args.py` drives tools through a real `mcp.client.Client` and checks every structured parameter on every registered tool; it fails on any `*_json` parameter. `tests/test_mcp_free_text_args.py` does the same for free text, in memory and over stdio, and checks that every plain-text parameter on every registered tool keeps `"null"`, `"[1]"`, `'{"a": 1}'`, `"123"` and `"true"` as text. The CLI still takes JSON text (`--words-json`, `--corrections-json`), since a shell argument is a string.

### MCP tool errors

The mcp SDK shows the agent an exception's text only for its own `ToolError`; any other exception reaches the agent as a bare `Error executing tool <name>` (its text stays in the server log, by design, so a crash does not leak internals). `install_tool_errors` in [`mcp/tool_errors.py`](../src/podcast_mcp/mcp/tool_errors.py), installed once in `mcp/server.py`, is the one boundary that decides what crosses: a busy lock becomes `error_code: "project_busy"`, and a `CodedError` ([`util/coded_error.py`](../src/podcast_mcp/util/coded_error.py)) becomes a structured `is_error` result with its message and `code`. Everything else stays generic (#1178). The rule itself is [`util/tool_refusal.py`](../src/podcast_mcp/util/tool_refusal.py); guest remote MCP (`services/remote_mcp/protocol.py`) uses it too, replacing each host path in a refusal's message with `[path]` for the share guest (#1182). Do not add a third mapping: a new adapter calls `tool_refusal`.

So raise an anticipated refusal (an unknown id, an out-of-range index, a missing file or project, a stale guard, a step that must run first) as a `CodedError` in the domain or service layer, not a plain `ValueError` / `KeyError` / `FileNotFoundError`, and never catch it in a tool handler or raise `ToolError` there:

- at a call site, use the class matching the builtin it raised before, so existing `except` clauses keep working: `CodedValueError` / `CodedKeyError` / `CodedFileNotFoundError(message, code="comment_not_found")`;
- for a named guard, give the class both bases and a class-level code: `class TranscriptTextChangedError(CodedError, ValueError): code = "transcript_changed"`;
- reuse a factory where one exists: `util/tracks.py::unknown_track` (`track_not_found`), `models/episode.py::project_not_found`.

Codes are stable `snake_case` names an agent may branch on; reuse an existing one (`*_not_found`, `invalid_range`, `missing_argument`, `empty_text`, ...) before adding one. Write the message for the agent: what was refused and what to do next. Never put another exception's text in it (`f"... ({exc})"`): that text is a crash's, and may name host paths; log it and chain it with `from exc` instead. Name a file by its track or file name, never by an absolute path: a share guest can reach most refusals, and `redact_host_paths` is only the backstop for a path that slips through. A refusal that says its target no longer exists uses a `*_not_found` code (or `track_has_no_media`): the document plane turns exactly those into a 409 conflict (`document_sync/errors.py::names_missing_target`), whatever the message says. A refusal about a value or position the caller chose (`no_clip_at_time`, `word_index_out_of_range`, `invalid_range`) must not end in `_not_found`: it is a bad request, not a stale target. The CLI prints the same message with `(code <code>)`. `tests/test_mcp_tool_errors.py` drives the refusals through a real `mcp.client.Client` (in memory and over stdio), checks that a crash stays generic, and checks that every registered tool goes through the boundary. Plain `ValueError` sites that are not yet `CodedError` still reach an MCP agent as the generic line; convert one when you touch it.

### Skill and MCP descriptions

Portable selection hints (any MCP client). Detail: [`.agents/rules/engineering-standards.md`](../.agents/rules/engineering-standards.md) § Skill and MCP descriptions.

- Every `.agents/skills/*/SKILL.md` needs YAML `name` (matching the directory) and a non-empty `description` (WHAT + WHEN, trigger phrases, nearest-sibling contrast). Enforced by `scripts/check_capabilities_manifest.py`.
- New/changed MCP tools: add a short docstring when the tool is confusable with a sibling or when user language ≠ the tool name. Do not blanket-fill unique CRUD tools.

## Time handling (source vs timeline clock)

Transcript words and ordinary remove/mute decisions use **source-media seconds**; rendered audio uses **timeline seconds**. `EditDecision.exact_range` is the explicit timeline-clock variant: its islands, destination lanes, observed clips and media seals must stay together. See [architecture.md § Timebase](architecture.md#timebase-source-vs-timeline-clock).

Build reviewed bleed targets with `build_range_target` in `edits/range_edits.py`. `propose_range_mute_tool` accepts timeline intervals in that sealed target. Rendering maps approved mutes to each selected occurrence's source clock and preserves the original envelope endpoints when intersecting a playback window.

When writing new code that deals with time:

1. **Never inline clip arithmetic** (`source_start + (t - timeline_start)` and friends). Use [`SessionTimeline`](../src/podcast_mcp/engines/session_timeline.py) for project-level mapping, `clip_timeline_overlap_to_source` / `clip_timeline_point_to_source` / `clip_source_to_timeline_shift` for clip-list edit/render code, or the `Clip.timeline_end` property for geometry. `tests/test_timebase_guards.py` fails CI otherwise.
2. **Touching rendered audio** (stems, premix, mastered, export, captions, chapters, social clips)? Map source→timeline through the mapper first.
   Cross-track audibility and bleed-path checks use rendered stems when available; if stems are absent, project decoded raw samples through `SessionTimeline.lane_clip_spans` before measuring so both tracks share one clock. Resolve each clip through `resolve_clip_audio_path`, including extra source recordings. An unavailable selected source invalidates the whole lane cache.
   For a selected recording's transcript, reuse `transcript_for_source` (exact source
   first; track-level words only for primary media and equivalent source aliases),
   or the shared `selected_source_transcripts` lane query, and
   `SessionTimeline.map_selected_source_span(s)` so another recording's same-numbered
   seconds are not mistaken for this source. Local retained-bleed delay evidence uses
   bounded raw windows including lag/null context and passes their origin as `t0`.
   Project-aware clip replacement must use `set_track_clips` to retain manual recorder
   choices on surviving same-source subclips.
   Whole-phrase approval must retain unsupported measured interior evidence.
   Batch corrections must preserve all stationary retained-copy reference regions,
   including secondary peers, as well as nonconflicting direct-phrase footprints.
3. **New MCP tool with a seconds parameter?** Add an entry to `TOOL_TIMEBASE` in [`util/tool_timebase.py`](../src/podcast_mcp/util/tool_timebase.py) declaring `"source"` or `"timeline"`; `tests/test_time_conformance.py` fails until you do.
4. **Search results** carry both clocks via `TranscriptMatch.timeline_start/end` — never re-derive them in a caller.
5. **Reading a media window with ffmpeg?** Build its arguments with `MediaSeek` in [`engines/media_seek.py`](../src/podcast_mcp/engines/media_seek.py): `input_args()` before `-i`, then `output_args()` after it or `offset()` in an `atrim`. A bare input `-ss` starts an AAC (`.m4a`) read up to about one 1024-sample frame late (a whole frame for `-ss 0`), because ffmpeg's decoder trims the file's encoder priming from the first packet it decodes, which after a seek is real audio. `tests/test_timebase_guards.py` fails CI on `-ss` anywhere else.

## History (non-destructive, undoable state)

Podcast MCP treats **all editable project state** as undoable unless explicitly documented otherwise (e.g. pipeline run logs).

### Contract

1. **Never modify `raw/`** — source recordings stay untouched; FFmpeg applies cuts/effects at render.
2. **Undoable mutations** use `ProjectWorkspace.mutate(label_before, label_after, fn)` or [`run_mutation`](../src/podcast_mcp/history/session.py), which:
   - records a snapshot **before** the change,
   - runs the domain mutation on `EpisodeProject`,
   - records a snapshot **after** the change (each `record` and the final record + commit take `project_commit_lock`; the mutation itself runs inside `ProjectWorkspace.transaction()`, which holds the lock from the reload through the commit (#213); `ReviewService.publish` sweeps old media before its state lock, then copies, encodes, and hashes private media before taking the commit lock, and verifies file identity and attaches the promoted version under that lock),
   - commits via `ProjectStore` (updates `episode.project.json` and mirrored `transcripts/*.json` caches).
   - on failure (any `BaseException`, including one in `record(before)`), removes the history entries and snapshots it recorded, unless the commit landed or another writer recorded on top (then memory adopts the index on disk); unless the commit landed it also restores the in-memory editable state and `project.render` to their pre-`mutate` values (after a `kept` or `unknown` rollback a caller that keeps the project must reload it before committing; `ProjectWorkspace.mutate` does); see [history.md § Storage layout](history.md#storage-layout). A new record-then-commit path takes `history.rollback.take_history_checkpoint` and wraps its steps in `rolled_back_on_failure` instead of its own try/except, passing `on_not_landed` to restore other in-memory state unless the commit landed. Use `on_failure` to consume the resulting `RollbackOutcome` after memory restoration; delete external artifacts only on `restored`. Merged saves use `HistoryRollbackPolicy.LOCKED_CALL` under the uninterrupted commit lock, with saved history as the index fallback and job history as the memory baseline.
3. **New features** add a service method that delegates to `mutate`; CLI/MCP handlers stay thin.
4. **Batch work** (e.g. transcript cleanup, multi-cut approve) should use **one** `mutate` per user-confirmed step so a single undo reverts the whole batch.
   Bulk transcript corrections rebuild the combined transcript once after the batch;
   keep per-step canonical commits for pipeline crash resume. The project store skips
   unchanged mirror writes and trims old undo history toward 400 snapshots without
   removing redo entries.
5. **Skills** that orchestrate mutations must mention `history_undo` and prefer batch tools where they exist.

Applying a pending decision with `boundary_mode` already set must consume its
stored optimized bounds. A second snap can reopen a protected breath edge.
Unsnapped decisions retain configured apply-time optimization. Both paths use
the existing applied-edit archive and workspace history mutation.
Coalescing only merges decisions with the same `boundary_mode`, so combining
rows cannot replace a settled edge's optimization policy with another row's.

### Transcript sync after audio changes

Operations that change audible output (gain, mute, FX, cuts, clips, envelopes, balance, etc.) must keep per-track transcripts aligned via **reconciliation** — see [architecture.md § Automatic transcript sync](architecture.md#automatic-transcript-sync).

1. **Mutations** — use `ProjectWorkspace.mutate` / `run_mutation`. Staleness is tracked automatically. Most audio edits invalidate rendered stems; run `render_preview` next so reconciliation sees processed audio.
2. **Renders** — use `rerender_preview` / `PipelineService.render_preview`. With default `reconcile_on_render: true`, transcript audibility metadata updates after each preview render (primary automatic sync path).
3. **Suppression** — default `transcript_mode: reconcile` applies bleed/inaudible suppressions and rebuilds combined after render (undo via history). Use `reconcile-transcript --dry-run` or `suppress-bleed --dry-run` to preview without mutating. Prefer `suppress-bleed` for bleed-only scoped cleanup (`--start` / `--end`, `--exclude-words-json` for keep-words). Set `transcript_mode: flag` in pipeline defaults only when tagging without auto-suppress.
4. **New pipeline or edit steps** — if the step changes what is heard, add it to `AUDIO_AFFECTING_STEPS` in `pipeline/runner.py` when run via the pipeline, and ensure the service path uses `mutate` + render as appropriate.
5. **Long jobs** that keep a workspace across slow work call `ws.checkpoint()` first and `ws.save_merged()` instead of `ws.save()`, so edits other requests commit meanwhile are merged, not overwritten; record a job's undo entry with `ws.save_merged(history_label=...)`, not `HistoryManager.record` followed by `save_merged()`. Covered: `PipelineService.run` / `render_final` / `export_audio`, the play premix re-render (`PlayService._ensure_premix`) and `HistoryService.undo` / `redo` / `goto` with `rerender=True` (the move and its marks are saved first in one locked step, then checkpoint → render → `save_merged(advice=ConflictAdvice(...))`; a conflict or a failed render keeps the move and says to re-render the preview; a failed render also calls `ws.discard_changes()`); Refresh (`PipelineService.render_preview`) renders inside `mutate()`, which re-reads the saved project under the cross-process lock. Read-modify-save outside `mutate` goes in `with ws.transaction():`.
6. **Long-running work** — adapters wrap automatically (MCP/CLI/pipeline/guest/GUI). Domain uses `progress_task` / `resolve_progress`; do not hardcode `NullProgress()` at edges or add parallel timers. Exemptions need explicit user approval in `contracts/progress-exemptions.json`. Spec: [progress.md](progress.md); CLI flags: [cli-progress.md](cli-progress.md). `make progress-check` (warn by default).

### Do not

- Call domain functions in `edits/` directly from adapters or agent scripts on a loaded project.
- Use `ws.save()` / `save_project()` alone when transcript, edit, mix, or timeline fields changed.
- Hand-edit `transcripts/*.json`; always go through the project store.
- Bypass reconciliation by mutating `EpisodeProject` outside `run_mutation` when audio-affecting fields change.

### Tests

Undo behavior: `tests/test_history.py`, `tests/test_history_session.py`, and feature-specific tests (e.g. `tests/test_transcript_cleanup_history.py`).

Operator docs: [history.md](history.md). Agent bundle: [.agents/INSTRUCTIONS.md](../.agents/INSTRUCTIONS.md), [engineering-standards.md](../.agents/rules/engineering-standards.md).

### Word timing controls

Wordbar timing uses the stored `(track_id, source_id, word_index)`, never a displayed clip placement as the mutation identity. Source seconds and current raw media duration are validated server-side; unrelated timeline geometry is not a save dependency. Keep drag drafts local and save once on release (or explicit keyboard/numeric Apply) through the document command and `ProjectWorkspace.mutate()`. Reuse the existing transport's owned source preview and the shared waveform's explicit viewport; do not add another player or renderer.

## Exact selected ranges

Selected range commands carry exact timeline occurrences and destination lanes. Do not convert their intervals through earliest-source mapping. Keep the trusted host application policy at the adapter boundary. Use one workspace mutation for the complete action.

Registry backups use `SqliteShareRegistry.backup_to_new` and the narrow private
publisher in `util/registry_backup.py`; do not add adapter-level SQLite copying or
overwrite backups. The destination directory must already meet the platform trust
policy. Native Windows backup tests run in `registry-backup-windows`; POSIX tests
cannot validate NTFS security descriptors or native rename behavior.
