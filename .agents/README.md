# Agent bundle (tool-agnostic)

Canonical agent configuration for **any** MCP-capable client (Cursor, Claude Code, GitHub Copilot, OpenCode, etc.).

| Path | Purpose |
|------|---------|
| [INSTRUCTIONS.md](INSTRUCTIONS.md) | How to change **this repo’s** Python code |
| [rules/engineering-standards.md](rules/engineering-standards.md) | SOLID/DRY, tests-as-you-go, docs-in-sync |
| [rules/git-workflow.md](rules/git-workflow.md) | Feature branch → PR → `main` (no direct pushes to `main`) |
| [rules/gui-styling.md](rules/gui-styling.md) | Theme tokens, rem, `@container`, consent-gated CSS exceptions |
| [rules/issue-claims.md](rules/issue-claims.md) | Claiming GitHub issues (`in-progress`, `pipeline:*` stage labels, claim comment + 6-hour heartbeat) so agents don't collide |
| [skills/](skills/) | Episode workflows and the Codex GitHub issue pipeline |
| [defaults/pipeline.yaml](defaults/pipeline.yaml) | Shared pipeline thresholds |
| [mcp.json](mcp.json) | MCP server (`podcast-mcp` on PATH) |

## MCP

1. Run `./install.sh` so `podcast-mcp` is on your PATH.
2. Open the repo in a client that loads project agents from `.agents/` (Cursor does this by default).
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

Repo skills live under `skills/`. Optional install into a global skills dir:

```bash
podcast setup --global-skills
```

Each `SKILL.md` YAML `description` is the **discovery field** for clients that load this pack (WHAT + WHEN, trigger phrases, sibling contrast). Agents that connect only `podcast-mcp` rely on MCP tool docstrings instead — write WHEN/NOT there for confusable tools. See [rules/engineering-standards.md](rules/engineering-standards.md) § Skill and MCP descriptions.
