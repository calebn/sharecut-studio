# Agent instructions

All changes to this repo must follow **SOLID** and **DRY**, include **tests as you go**, and keep **docs in sync** with the code.

## Architecture (required reading)

- [docs/architecture.md](docs/architecture.md) — layers: domain → `services/` → `cli/` / `mcp/tools/` / `gui/`
- [docs/contributing.md](docs/contributing.md) — where new code goes; no duplicated I/O in adapters
- [docs/ui-philosophy.md](docs/ui-philosophy.md) — binding trust-first beta UI principles; distinguish requirements from shipped behavior
- [docs/communication-philosophy.md](docs/communication-philosophy.md) — voice, terminology, control placement, and mobile checklist for user-facing copy and controls; ui-philosophy wins on conflict
- [docs/interaction-system.md](docs/interaction-system.md) — one path per interaction (selection, targets, menus, sheets, feedback, keyboard and touch twins), the registries, and the checklist a new or changed interaction passes
- [docs/decisions/README.md](docs/decisions/README.md) — the generated index of product and design decisions. Each decision lives in the doc it governs as a decision block that names its evidence and its enforcement (a test, docs-sync rule or make target); a later decision supersedes it in place

## Beta interfaces

The product is in beta and has no users. Breaking changes are allowed; backward compatibility is not a requirement. Migrate all current callers, tests, and docs to the new contract, then delete obsolete implementations. Do not retain compatibility-only overloads, aliases, or fallbacks for old APIs or project formats at runtime. Preserve distinct paths only when they serve a current product workflow.

**Upgrade rule (owner, 2026-10-17).** It takes effect once the first beta tester build ships. Until then, format breaks need no migration and no upgrade tooling. After that build ships, a change to the project file's shape, or anything else that breaks backward compatibility of data a user already has, ships in the same change with tooling that upgrades older project files: a one-shot `podcast` CLI command the user runs, with tests that upgrade a fixture of the old shape. The old shape is then unsupported at runtime, and no runtime compatibility code is kept in either phase. Enforced by #1702. See [docs/beta-plan.md § Compatibility](docs/beta-plan.md#compatibility).

## Beta plan (current scope)

Read [docs/beta-plan.md](docs/beta-plan.md) before you choose work. It defines the nine journeys (J1 to J9), their bars, and what is not in the beta.

- Pick only `beta:blocker` issues, then `beta:quality` issues. Skip `post-beta` unless the owner names the issue or it is D5 CI-cost work.
- Label every new issue when you file it: a beta bucket, a `journey:J#`, and a `cause:` label when one fits.
- Follow the six filing rules in the plan and in [issue claims](.agents/skills/sharecut-poteto/references/issue-claims.md).
- Check your work against the bar of the journey the issue carries.

## Git workflow

For contributor work, use [sharecut-poteto](.agents/skills/sharecut-poteto/SKILL.md).
Read its [Git policy](.agents/skills/sharecut-poteto/references/git-workflow.md)
and [issue claims](.agents/skills/sharecut-poteto/references/issue-claims.md)
before implementation. Native Poteto owns the procedure. Repository engineering,
product, security, and CSS approval rules still apply.
State the outcome, acceptance proof, affected areas, and non-goals before coding.
Follow [contributor scope and proof guidance](docs/contributing.md#bound-the-outcome-before-coding)
through code-ready review and PR delivery.

## SOLID / DRY (short)

1. **Single responsibility** — Business logic in `edits/`, `clips/`, `pipeline/`, `engines/`. Orchestration in `services/`. CLI/MCP/GUI only parse args and format output.
2. **Don't repeat yourself** — Use `ProjectWorkspace`, `run_mutation`, `util/review`, `project.io`, `export/transcript`. Never copy project load/save or history wiring into a new tool. GUI audio/pipeline must call `PlayService` / `PipelineService` (same as CLI), not reimplement artifact paths.
3. **Extend, don't fork** — New MCP tools: handler in `mcp/tools/`, register in `register_all`, re-export from `mcp/server.py` if tests need it. New CLI: add to `cli/<area>.py`. New GUI routes: thin handlers in `gui/server.py` over services.
4. **Stable MCP names** — Do not rename existing MCP tools without updating `.agents/skills/` and docs.

## Tests as you go

1. Add or update tests in `tests/` **in the same change** as the feature or fix. For ShareCut Studio UI under `gui/web/`, add Vitest tests (and axe checks for shared `ui/` / shells) and run focused tests locally; GitHub Actions runs the full frontend checks. Full-page axe lives in Playwright (`make test-web-e2e`); do not silence a11y or other lint with ignore comments — fix markup/styles or get **explicit user approval** before any `*-disable` / `biome-ignore`. Use native controls and shared helpers (`src/test/a11y.ts`, `e2e/axe.ts`). Theme colors, space, and type belong in `gui/web/src/styles/theme/` (and `deploy/brand/brand-tokens.css`); partials and inline styles use `var(--…)` only. Chrome is rem + named `@container`; canvas `px` / `!important` / `@layer` need `-- user-approved:` Stylelint disables (Stylelint + `tests/test_css_policy.py`). See [.agents/rules/gui-styling.md](.agents/rules/gui-styling.md).
2. Run focused tests for changed behavior locally (`uv run pytest -q --no-cov tests/<relevant_file>.py` or `make test-fast`) and run `make lint-py` / `make format-py-check` / `make typecheck` for Python changes. GitHub Actions runs the full `make test` suite on every PR that changes anything outside `gui/web/` or the docs paths, and on `main` and nightly; its coverage must stay **≥95%** (`pyproject.toml`). A new top-level or `src/podcast_mcp` directory needs a rule in `scripts/ci_plan.py` (see [docs/testing.md § Which jobs a run needs](docs/testing.md#which-jobs-a-run-needs)). Run local `make test` or `make ci` when changes are extensive or a specific failure needs full-suite diagnosis. Python uses Ruff (lint+format), Bandit, Vulture, Deptry, and mypy — do not add `# noqa` / `# nosec` without **explicit user approval**. When changing `gui/web/`, run focused Vitest tests and relevant static checks locally; GitHub Actions runs the equivalent frontend checks (lint + format:check + typecheck + vitest + build). For viewer shell / launch / axe / cross-browser regressions, run `make test-web-e2e` (Chromium suite + Chromium/WebKit compat matrix in `gui/web/e2e-compat/`) when local browser validation is needed. When changing `gui/desktop/`, run focused desktop checks locally; GitHub Actions runs its path-filtered `make test-desktop` job (sidecar launcher fmt/clippy/`rustc --test` + rustfmt + clippy `--lib` + lib tests; optional Rust toolchain).
3. Prefer unit tests on domain/services; use existing patterns (`test_services.py`, `test_project_io.py`, `test_mcp_tools.py`).
4. Undoable mutations must go through `ProjectWorkspace.mutate()` (see `test_history.py`).

## Docs in sync

Update documentation **in the same change** when behavior, layout, or workflows change. Do not leave README/architecture/skills stale.

<!-- docs-sync:generated -->
| When you change… | Update… |
| --- | --- |
| Layers, packages, or service boundaries | `docs/architecture.md` |
| Source/timeline timebase, `SessionTimeline`, or clip time math | `docs/architecture.md` § Timebase (owner; it links the format, contributing and testing docs), affected skills |
| Setup, commands, or repo layout | `README.md`, `docs/setup.md` |
| Python dependencies (add/remove/bump) | `pyproject.toml`, then regenerate `uv.lock` (`uv lock`), `docs/setup.md` |
| Contributor workflow | `docs/contributing.md`, this file |
| MCP tools or NL/social workflows | `docs/nl-editing.md`, `docs/transcript-workflow.md`, `docs/social-clips.md`, `docs/timeline-comments.md`, relevant `.agents/skills/` (incl. `podcast-transcript-workflow`, `podcast-play-audition`, `podcast-timeline-comments`) |
| Prosody profile (`analyze_prosody` step, cache, engine, `audition_context` fields) | `docs/pipeline.md` § Prosody profile, `docs/persistence.md`, `docs/architecture.md`, `docs/setup.md` (extras), `docs/testing.md` (CI extras), `docs/nl-editing.md` (`audition_context_tool` row), `.agents/defaults/pipeline.yaml`, skills `podcast-play-audition`, `podcast-pipeline-run`, `podcast-pipeline-tune`, `podcast-setup` |
| Timeline review comments / action items | `docs/timeline-comments.md`, `docs/episode-format-v2.md` § Review, `schemas/episode.project.schema.json`, `.agents/skills/podcast-timeline-comments/` |
| Public share tokens (coolname, active + cooldown pools) | `docs/share-tokens.md`, `podcast review backup-registry` |
| Recording session (record links, roles incl. producer, lobby/consent, keeper capture, mix-minus monitor, pause/takes, live comments, upload/landing) | `docs/recording-session.md` (owner: decisions, test contract MM1–MM9, and links to the share-token, persistence, session-sync, live-comment and guest-journey docs) |
| Durable stores (project JSON, session sync sqlite, share registry, cache `prefs.yaml`, show files) | `docs/persistence.md` — extend an existing store; do not scatter new sidecars. Episode `artifacts/transcript_context.yaml.lock` only coordinates writers; the vocabulary revision lives in context YAML and each transcript's `vocabulary_revision` in project JSON. Show files (`PODCAST_CONFIG_DIR/shows/<id>.yaml`) change only through the show store, under its lock. |
| DAW viewer launch (`open_gui_tool`) | `docs/gui-viewer.md` § Launch, `docs/setup.md` § Read-only GUI viewer, skill `podcast-open-gui` |
| Undo / non-destructive mutations | `docs/history.md`, `docs/gui-integration.md`, `docs/contributing.md` § History, `.agents/INSTRUCTIONS.md`, `.agents/rules/engineering-standards.md` |
| Cut boundary optimization | `docs/inaudible-cuts.md` (incl. § Narrative handoffs), `docs/filler-cut-quality.md` / `suggest_handoff_cut_tool`, `.agents/skills/podcast-tighten-dialogue/`, `.agents/skills/podcast-edit-natural-language/`, `.agents/skills/podcast-inaudible-cuts/`, `.agents/skills/podcast-audio-cleanup/` |
| Filler lexicon matching, backchannels, or the isolated-filler policy (`tighten.filler_words`, `discourse_markers`, `backchannels`, `isolated_filler_candidates`, `util/text.lexicon_form`) | `docs/filler-cut-quality.md` § Policy and § Intensity presets, `docs/pipeline.md` tighten table, `docs/nl-editing.md` (`propose_edits` skip counts), `.agents/defaults/pipeline.yaml` → `tighten`, `.agents/skills/podcast-tighten-dialogue/` |
| Join continuity / splice QA | `docs/inaudible-cuts.md` § Join continuity, `tighten.join_continuity_gate`, skills above |
| Clip join modes (`join_in_mode`, fade vs crossfade render) | `docs/inaudible-cuts.md`, `docs/filler-cut-quality.md`, `docs/nl-editing.md`, `schemas/episode.project.schema.json`, `.agents/defaults/pipeline.yaml` → `render`, affected skills above |
| Audio diagnostics (spectrogram/astats/hum) or mastering loudness QC | `docs/audio-engineering.md`, `.agents/skills/podcast-audio-cleanup/`, `.agents/skills/podcast-master-export/` |
| Gate fill (`fill_gate_holes` step: source-gate hole detection, fill sources, comfort-noise estimate, render mixing) | `docs/audio-engineering.md` § Gate fill, `docs/pipeline.md` § Gate fill, `docs/persistence.md`, `docs/episode-format-v2.md`, `schemas/episode.project.schema.json`, `.agents/defaults/pipeline.yaml` → `gate_fill`, skills `podcast-audio-cleanup`, `podcast-pipeline-run` |
| Bounce / stem range export (GUI + MCP) | `docs/gui-integration.md`, `docs/daw-editing.md`, `.agents/skills/podcast-bounce-export/` |
| Share section on Deliver (review links, record rooms, online sharing status) | `docs/design/stages/spec-review-deliver.md` (Share), `docs/design/stages/inventory.md`, `docs/host-online-relay.md` when the tunnel states or their copy change |
| Waveform pyramid / renderer / tiles | `docs/waveform.md`, `contracts/timeline-zoom.json`, `docs/gui-viewer.md` § Waveforms, `docs/persistence.md` |
| FFmpeg/model bootstrap, native binary resolution, or new `bootstrap` components | `docs/setup.md` (owner; it links the README, roadmap and `podcast-setup` skill), util/binaries.py and util/model_assets.py docstrings |
| Raw multitrack → per-speaker tracks | `docs/multitrack-ingest.md`, `.agents/skills/podcast-align-audio/`, `.agents/skills/podcast-ingest-align/` |
| Episode project format v2 | `docs/episode-format-v2.md`, `schemas/episode.project.schema.json` (incl. `editorial.edit_log`, `AppliedEditRecord`) |
| GUI / timeline inspector APIs | `docs/gui-integration.md`, `docs/history.md` (`history_diff`) |
| Read-only DAW viewer (`gui/`, `podcast gui`) | `docs/gui-viewer.md`, `docs/setup.md` § Read-only GUI viewer |
| ShareCut Studio CSS units / theme tokens / Stylelint | `docs/design-tokens.md` (naming system), `.agents/rules/gui-styling.md`, `docs/contributing.md` § frontend, `gui/web/README.md`, `ux/pages/brand.md` § Units, `docs/gui-mobile.md` |
| ShareCut Studio mobile / responsive shells | `docs/gui-mobile.md`, `docs/gui-viewer.md` § Responsive shells, `ROADMAP.md` § Follow-up |
| ShareCut Studio user-facing copy, terminology, control placement, menus, dialogs, empty states, or feedback | `docs/communication-philosophy.md` (Terminology table in the same PR that adds or renames a concept; Changelog when a rule changes; UI philosophy wins on conflict), partner terms in `ux/pages/domain-glossary.md` |
| ShareCut Studio interaction grammar (selection kinds and surfaces, command targets, menus, dialogs and sheets, feedback channel, keyboard and touch equivalents) | `docs/interaction-system.md` (the rule, the registry row, the checklist line, and the Shipped gaps table when a gap closes) |
| Native iOS/Android engine / in-app BYOK agent (deferred) | `docs/cross-platform-byok.md` (interim architecture rules + long-horizon path); do not implement now; keep ffmpeg behind `FFmpegEngine`, guest MCP ≠ owner device |
| ShareCut Studio editability (cuts, joins, FX, transcript in GUI) | `docs/daw-editing.md`, `ROADMAP.md` § Follow-up, `docs/session-sync.md` § Document plane |
| ShareCut Studio keyboard / command bus | `gui/web/README.md` (command bus: `execute`); never add a second window `keydown` listener — see `commands/governance.test.ts` |
| Capability registration (GUI / keys / MCP / CLI / skills) | `contracts/capabilities.manifest.json`, `docs/entry-points.md`, live catalog https://docs.sharecut.studio/#/capabilities (regen with `make schema-export`); `make generated-check` / pre-commit `capabilities-manifest` |
| ShareCut Studio shortcut cheatsheet (docs + UX site) | Regenerate with `make cheatsheet` after keymap/catalog changes; `make cheatsheet-check` / pre-commit `keymap-cheatsheet`; live: `ux/pages/shortcuts.md` → https://ux.sharecut.studio/#/shortcuts (links to capabilities catalog) |
| ShareCut Studio desktop (Tauri) / packaging | `docs/desktop-packaging.md`, `gui/desktop/`, `contracts/bootstrap-assets.json`, first-run `/api/bootstrap/*`; distribution operations are private |
| ShareCut Studio Extensions API / freemium split seams | `docs/extensions.md`, `docs/extension-seams.md`, `contracts/caps.json`, `podcast_mcp.extensions`, external provider packages such as `podcast_online`, `podcast_relay`, `PODCAST_EXTENSIONS` |
| Host-online relay / tunnel / share capabilities / remote MCP | `docs/host-online-relay.md` (owner; it links the share-token, review-share and relay deployment docs), skill `podcast-remote-mcp` — **mounted via the FOSS collaboration extension**; deployment remains private |
| Agent ↔ DAW session sync (typed commands, sqlite log, WS) | `docs/session-sync.md` (owner; it links the GUI shared-session section), skill `podcast-play-audition`; public catalog https://docs.sharecut.studio/#/document-commands |
| Document-command schema / developer docs pack | `schemas/document-commands.schema.json`, `docs-site/` (live https://docs.sharecut.studio/); regenerate with `make schema-export` (also capabilities catalog + share/MCP tables + guest OpenAPI); stale → `make generated-check` / pre-commit; deployment is private operations work; alpha — no public changelog yet |
| Pipeline defaults or export paths | `.agents/defaults/pipeline.yaml`, `docs/pipeline.md` and other pipeline docs |
| GUI pipeline config / Analyze → Run | `docs/pipeline.md` § Configurable run, `docs/gui-viewer.md` § Prepare stage (orchestration), skill `podcast-pipeline-tune` |
| Pipeline step parallelism/performance | `docs/pipeline.md` § Performance, `.agents/skills/podcast-pipeline-run/`, `.agents/skills/podcast-tighten-dialogue/` |
| Testing or coverage policy | `docs/testing.md`, `pyproject.toml`; Python: `make lint-py` / Ruff+Bandit+Vulture+Deptry+mypy; ShareCut Studio frontend: `make test-web`, `make test-web-e2e` (axe), `gui/web/README.md`; Tauri host: `make test-desktop` / `docs/desktop-packaging.md` |
| Dependency update automation (Dependabot / npm audit) | `.github/dependabot.yml`, `tests/test_dependabot_config.py`, `docs/testing.md` § Dependency updates and audit, `docs/contributing.md` § Dependency updates |
| Progress framework (long-running UX) | `docs/progress.md`, `contracts/progress-exemptions.json`, `contracts/progress-richness.json`; CLI adapter `docs/cli-progress.md`; `make generated-check` / pre-commit `progress-compliance` (warn → later error) |
| E2E fixture / play CLI | `docs/e2e-fixture-manual.md`, `tests/fixtures/aligned_dialogue/README.md` |
| Roadmap / future work | `ROADMAP.md`; native apps + BYOK agent detail: `docs/cross-platform-byok.md` |
| Beta scope, journeys, bug bar, filing rules, or architecture order | `docs/beta-plan.md`, `ROADMAP.md`, `.agents/skills/sharecut-poteto/references/issue-claims.md` |
| UX onboarding pack (shareable site) | `ux/` (`pages/*.md` incl. styling guidelines `ux/pages/brand.md`, site shell); [ux/README.md](ux/README.md); live https://ux.sharecut.studio/; demo fixture `tests/fixtures/sharecut_ux_demo/`; enforced by the `ux-pack` docs-sync gate (triggers: GUI shells, keymap, command catalog, UX-facing docs, episode schema) |
| Play modes (raw / processed / premix) | `docs/setup.md` — `processed:<id>` for FX+edits, `track:<id>` for raw |
| Decision blocks (a heading plus a decision comment) in a doc | `docs/decisions/README.md`: regenerate it with `make decisions-index` |
| Decision: guest powers, review-link roles, share-link expiry | The decision blocks in `docs/share-tokens.md`; a waiver names the decision it keeps |
| Decision: exact selected range targets | The decision blocks in `docs/daw-editing.md`; a waiver names the decision it keeps |
| Decision: every tab keeps its own selection | The decision blocks in `docs/session-sync.md`; a waiver names the decision it keeps |
| Decision: saved mute and volume, listen-only solo | The decision blocks in `docs/gui-viewer.md`; a waiver names the decision it keeps |
| Decision: configurable master levels | The decision blocks in `docs/audio-engineering.md`; a waiver names the decision it keeps |
| Decision: bleed handling | The decision blocks in `docs/audio-engineering.md`; a waiver names the decision it keeps |
| Decision: filler cut rules and mute mode | The decision blocks in `docs/filler-cut-quality.md`; a waiver names the decision it keeps |
| Decision: alignment from bleed lag | The decision blocks in `docs/multitrack-ingest.md`; a waiver names the decision it keeps |
| Decision: touch input grammar and visible equivalents | The decision blocks in `docs/touch-editor-decisions.md`; a waiver names the decision it keeps |
<!-- /docs-sync:generated -->

If a doc would mislead the next agent or contributor, fix it before finishing the task.

## Agent bundle

Codex UI design feedback uses the upstream `.agents/skills/impeccable/` skill
and `.codex/hooks.json`. Claude Code loads the same repo skills, `/impeccable`
included, through the `.claude/skills` symlink to `.agents/skills`. Setup and trust steps:
[docs/setup.md § Impeccable design hooks](docs/setup.md#impeccable-design-hooks).
Repo engineering and styling rules take precedence over upstream guidance;
detector suppressions require explicit user approval.

Tool-agnostic config under `.agents/` — [rules](.agents/rules/) (`engineering-standards.md`, `gui-styling.md`; not `.cursor/rules/` for engineering rules). The Cursor-native exception is [pstack-models.mdc](.cursor/rules/pstack-models.mdc) (identical copy at [.agents/rules/pstack-models.mdc](.agents/rules/pstack-models.mdc)) so Autopilot cloud checkouts see the operator bake-in. Native poteto still Reads `~/.cursor/rules/pstack-models.mdc`; copy the workspace file there before spawning Task. [skills](.agents/skills/), [defaults](.agents/defaults/pipeline.yaml), [MCP](.agents/mcp.json). See [.agents/README.md](.agents/README.md).

## Skills

Podcast workflows and the native Poteto repository companion: `.agents/skills/`. Defaults: `.agents/defaults/pipeline.yaml`.
