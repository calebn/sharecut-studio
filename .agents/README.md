# Agent bundle (tool-agnostic)

Canonical agent configuration for **any** MCP-capable client (Cursor, Claude Code, GitHub Copilot, OpenCode, etc.).

| Path | Purpose |
|------|---------|
| [INSTRUCTIONS.md](INSTRUCTIONS.md) | How to change **this repo’s** Python code |
| [rules/engineering-standards.md](rules/engineering-standards.md) | SOLID/DRY, tests-as-you-go, docs-in-sync |
| [Git policy](skills/sharecut-poteto/references/git-workflow.md) | Feature branch → PR → `main` (no direct pushes to `main`) |
| [rules/gui-styling.md](rules/gui-styling.md) | Theme tokens, rem, `@container`, consent-gated CSS exceptions |
| [Issue claims](skills/sharecut-poteto/references/issue-claims.md) | Claiming GitHub issues (`in-progress`, `pipeline:*` stage labels, claim comment + 6-hour heartbeat) so agents don't collide |
| [skills/](skills/) | Episode workflows and the [native Poteto companion](skills/sharecut-poteto/SKILL.md) |
| [defaults/pipeline.yaml](defaults/pipeline.yaml) | Shared pipeline thresholds |
| [mcp.json](mcp.json) | MCP server (`podcast-mcp` on PATH) |
| [skills/impeccable/](skills/impeccable/) | Upstream UI design skill and version-pinned engine launcher, with Codex hooks in `../.codex/hooks.json` |

## MCP

1. Run `./install.sh` so `podcast-mcp` is on your PATH.
2. Open the repo in a client that loads project agents from `.agents/`. Cursor, Codex and OpenCode read it directly. Claude Code reads `.claude/skills`, a committed symlink to `skills/` here, so every client sees the same skills.
3. Reload MCP servers after install if the IDE was already running.

See [docs/setup.md](../docs/setup.md) for details.

## Feature docs (for agents)

| Doc | Topic |
|-----|--------|
| [INSTRUCTIONS.md](INSTRUCTIONS.md) | **Required:** undoable `mutate` contract when changing code or skills |
| [rules/engineering-standards.md](rules/engineering-standards.md) | Layering, DRY, non-destructive mutations |
| [docs/contributing.md](../docs/contributing.md#history) | Contributor history contract |
| [docs/history.md](../docs/history.md) | Undo/redo snapshots (operators) |
| [docs/inaudible-cuts.md](../docs/inaudible-cuts.md) | Default cut boundary optimization |
| [docs/nl-editing.md](../docs/nl-editing.md) | NL edit MCP/CLI tools |

`build_edit_context` includes `doc_refs` pointing at these paths.

## Skills

The vendored Impeccable skill comes from
[pbakaus/impeccable](https://github.com/pbakaus/impeccable), under its bundled
Apache-2.0 [license](skills/impeccable/LICENSE). Its skill version lives in
`SKILL.md` metadata and its engine version in `scripts/VERSION`. Setup, updates,
and Codex hook trust: [design hooks](../docs/setup.md#impeccable-design-hooks).
Repo engineering rules govern any changes or detector suppressions it suggests.

Repo skills live under `skills/`, the single source for every client; `.claude/skills` only points here. Optional install into a global skills dir:

```bash
podcast setup --global-skills
```

Each `SKILL.md` YAML `description` is the **discovery field** for clients that load this pack (WHAT + WHEN, trigger phrases, sibling contrast). Agents that connect only `podcast-mcp` rely on MCP tool docstrings instead — write WHEN/NOT there for confusable tools. See [rules/engineering-standards.md](rules/engineering-standards.md) § Skill and MCP descriptions.
