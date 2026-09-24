# Entry points (capability registration)

Product capabilities are registered in [`contracts/capabilities.manifest.json`](../contracts/capabilities.manifest.json).
That file is the contract for **which host surfaces** exist (Sharecut Studio command / GUI / keyboard / **host** MCP / CLI / skill). Adapters stay thin; business logic stays in `services/`.

It is **not** the share ACL. Token bits live in [`share_capabilities.py`](../src/podcast_mcp/edits/share_capabilities.py); guest MCP tools in [`remote_mcp/allowlist.py`](../src/podcast_mcp/services/remote_mcp/allowlist.py); share HTTP in the guest OpenAPI export. The capabilities catalog MCP column lists **host stdio / local GUI Streamable HTTP** names (`split_clip_tool`, `play_audio_tool`) — the same `MCPServer` on `podcast-mcp` stdio and on `http://127.0.0.1:8765/mcp`. Share agents call guest HTTP / `guest_submit_document_command`, never those host names. `omit.guest` is a documentation Host-only annotation — not `has_capability`. Do not add `guest_*` to `surfaces.mcp`.

## Architecture

```text
Capability Manifest  →  make capabilities-check (CI / pre-commit)
        │
        ├─ Sharecut Studio: COMMANDS + keymap → execute(id) → services / document sync
        ├─ MCP / CLI: thin wrappers → same services
        └─ Skills: instruct agents which MCP/CLI to call (no FFmpeg forks)
```

Rules:

1. **Service first** — never put mix/encode/edit logic in GUI, skill markdown, or MCP adapters.
2. **Command bus for Sharecut Studio** — if the capability has GUI chrome, it must have a `surfaces.command` and call `execute(id)`.
3. **Keyboard** — required when `industry_standard_key: true`; otherwise set `omit.keyboard_reason`.
4. **Agent** — host workflows need `mcp` and/or `cli`; add `skill` only for multi-step procedures.
5. **Guest** — share/remote MCP stays on the guest allowlist (`allowlist.py`). Host capabilities with `omit.guest: true` are documented as host-only; runtime share gates use `has_capability` + document-command allowlists.
6. **Presence** — every GUI surface declares `presence` (Look / Hear / Do rubric in [`docs/session-sync.md`](session-sync.md) § Follow scope); `cursor: anchor` surfaces must render `data-presence-anchor` via `presenceAnchorProps`.

## Adding a new capability

1. Implement / extend the **service** (with tests).
2. Add or update a row in `contracts/capabilities.manifest.json`.
   - For a command surface, include its default `COMMANDS[id].when` predicate in `gates`. The command catalog controls keyboard execution; the manifest describes that gate in the published capability catalog. Keep the governance test free of per-command exceptions.
   - GUI chrome must set `surfaces.gui` **and** a non-empty `tooltip` (toggles also need `tooltip_pressed` + `"toggle": true`).
   - Copy is generated to `gui/web/src/capabilities/copy.ts` (`capabilityTooltip`) — do not hardcode toolbar/handle strings in React.
3. Add only the declared adapters:
   - Sharecut Studio: `gui/web/src/commands/catalog.ts` + `register.ts` + chrome → `execute`
   - Keyboard: `gui/web/src/keymap/registry.ts` (if industry / product wants it)
   - MCP: `mcp/tools/` + `register_all`
   - CLI: `cli/` twin
   - Skill: `.agents/skills/` only if agents need a workflow
4. Run `make capabilities-check` and `make schema-export` (and `make cheatsheet` when keys change). New MCP/CLI/pipeline ids also appear on `make progress-check` automatically ([progress.md](progress.md)).

## Governance

| Gate | Command |
|------|---------|
| Local | pre-commit hook `capabilities-manifest` (adapters + docs catalog) |
| CI / `make ci` | `make capabilities-check` |
| Frontend | `gui/web/src/commands/governance.test.ts` (single keydown listener) |
| Unit | `tests/test_capabilities_manifest.py` |

Hard fail when a `COMMANDS` / keymap / registered MCP tool / skill is missing from the manifest (hubs/deprecated skills live under `hub_skills`), or when the published docs catalog is stale.

Repo automation skills such as `codex-issue-pipeline` also live under `hub_skills`: they guide contributors but do not add a Sharecut Studio product command or MCP tool.

## Matrix

Live browsable matrix: [docs.sharecut.studio/#/capabilities](https://docs.sharecut.studio/#/capabilities)
(auto-generated from the manifest via `make schema-export`). High-level product view:

| Area | Typical GUI | Keyboard | Agent |
|------|-------------|----------|-------|
| Transport / tools / edit / history | Sharecut Studio chrome | See `make cheatsheet` | session / edit / history MCP |
| Presence / follow | Avatar stack, ghosts, follow banner | Escape unfollows | `get_session_presence_tool` / `guest_get_session_presence` |
| Bounce / export | Menu + dialog | Mod+Shift+B / E | `podcast-bounce-export` / `podcast-master-export` |
| Pipeline / transcript / NL / clips | Pipeline tab / inspectors | — | matching skills + MCP |
| Guest review | Share SPA | — | guest remote MCP allowlist |

Shortcut cheatsheet: [daw-shortcuts.md](daw-shortcuts.md) / [ux shortcuts](https://ux.sharecut.studio/#/shortcuts).
Contributor recipe stays in this file; the JSON contract is [`contracts/capabilities.manifest.json`](../contracts/capabilities.manifest.json).
