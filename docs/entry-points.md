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
4. **Agent (enforced)** — every row declares `effect`. `project` means the action changes the saved episode project, review state, transcripts or artifacts (record take state in `artifacts/session/sync.db` counts, so record start, pause, resume and stop are `project`); `session` means live, unsaved working state (transport, playhead, selection, solo, presence, clipboard); `view` means only how this client shows things (layout, zoom, panels, modes, dialogs). An `effect: project` row must list `surfaces.mcp` or `surfaces.cli`, or carry an owner-approved `omit.agent_reason`; `make capabilities-check` fails otherwise, and also fails a reason left beside an agent surface. Every `surfaces.mcp` name must be a registered tool, and every `surfaces.cli` entry (a string or a list, one command per entry, such as `podcast edit delete-clips --ripple`) must resolve in the real Typer tree, options included. An agent twin calls the same service as the GUI; where the GUI sends a document command, the twin submits that command with `submit_host_document_command` (`services/document_sync`), so open tabs see it and History can undo it. One tool may serve several rows (`approve_edits_tool` covers Apply hit, and with `apply_all_safe=true` Apply eligible, through the same `edits/tighten_hits` rule the Tighten tab reads). Add `skill` only for multi-step procedures.
5. **Guest** — share/remote MCP stays on the guest allowlist (`allowlist.py`). Host capabilities with `omit.guest: true` are documented as host-only; runtime share gates use `has_capability` + document-command allowlists.
6. **Presence** — every GUI surface declares `presence` (Look / Hear / Do rubric in [`docs/session-sync.md`](session-sync.md) § Follow scope); `cursor: anchor` surfaces must render `data-presence-anchor` via `presenceAnchorProps`.

**Focused clip handles:** `edit.setClipFade` and `edit.trimClipEdge` route Left/Right nudges through the sole keymap listener before playhead navigation. Their focused-handle predicates describe focus ownership; handlers separately require `canApplyPass12`, so a denied edit still consumes the focused arrow. Clip-local previews share pointer clamping and save once through the existing document commands on key release or normal blur. Escape cancels locally. The manifest keeps the canonical first key (`ArrowLeft`); generated shortcut notes name both Left/Right directions.

**Long-press exemption:** the mobile Long-press gesture opens different existing selection or correction actions according to its target (clip, comment, track, or transcript word). It has no single command ID. The gesture cheatsheet keeps that behavior as a documented exception; swipe-left comment resolution has the command ID `comment.resolve` and capability `daw.review.resolveComment`.

## Adding a new capability

1. Implement / extend the **service** (with tests).
2. Add or update a row in `contracts/capabilities.manifest.json`, with its `effect`. A `project` row lists the MCP tool or CLI command that makes the same change.
   - For a command surface, include its default `COMMANDS[id].when` predicate in manifest `gates`. The catalog controls command execution; the manifest records its gate and any additional handler prerequisites. Keep the governance test free of per-command exceptions.
   - GUI chrome must set `surfaces.gui` **and** a non-empty `tooltip` (toggles also need `tooltip_pressed` + `"toggle": true`).
   - Copy is generated to `gui/web/src/capabilities/copy.ts` (`capabilityTooltip`) — do not hardcode toolbar/handle strings in React.
3. Add only the declared adapters:
   - Sharecut Studio: `gui/web/src/commands/catalog.ts` + `register.ts` + chrome → `execute`
   - Keyboard: `gui/web/src/keymap/registry.ts` (if industry / product wants it)
   - MCP: `mcp/tools/` + `register_all`
   - CLI: `cli/` twin
   - Skill: `.agents/skills/` only if agents need a workflow
4. Run `make capabilities-check` and `make schema-export` (and `make cheatsheet` when keys change). New MCP/CLI/pipeline ids also appear on `make progress-check` automatically ([progress.md](progress.md)).

`agent.transcript` includes host vocabulary read/write tools. CLI removal flags
and MCP replacement writes use `TranscriptPrecorrectService`; revision checks
and prompt limits stay in the service rather than adapters.

## Governance

| Gate | Command |
|------|---------|
| Local | pre-commit hook `capabilities-manifest` (adapters + docs catalog) |
| CI / `make ci` | `make capabilities-check` |
| Frontend | `gui/web/src/commands/governance.test.ts` (single keydown listener) |
| Unit | `tests/test_capabilities_manifest.py` |

Hard fail when a `COMMANDS` / keymap / registered MCP tool / skill is missing from the manifest (hubs/deprecated skills live under `hub_skills`), when an `effect: project` row has no MCP or CLI surface and no `omit.agent_reason`, when a `surfaces.cli` entry names a command or option the `podcast` CLI does not have, or when the published docs catalog is stale. The catalog shows each row's effect; an approved agent reason appears in its CLI column.

Repo automation skills such as `codex-issue-pipeline` and the upstream UI design skill `impeccable` also live under `hub_skills`: they guide contributors but do not add a Sharecut Studio product command or MCP tool.

## Matrix

Live browsable matrix: [docs.sharecut.studio/#/capabilities](https://docs.sharecut.studio/#/capabilities)
(auto-generated from the manifest via `make schema-export`). High-level product view:

| Area | Typical GUI | Keyboard | Agent |
|------|-------------|----------|-------|
| Transport / tools / edit / history | Sharecut Studio chrome | See `make cheatsheet` | session / edit / history MCP |
| Presence / follow | Avatar stack, ghosts, follow banner | Escape unfollows | `get_session_presence_tool` / `guest_get_session_presence` |
| Bounce / export | Menu + dialog | Mod+Shift+B / E | `podcast-bounce-export` / `podcast-master-export` |
| Pipeline / transcript / NL / clips | Pipeline tab / inspectors | F2: inline correction on a focused Navigate word; native Enter seeks | matching skills + MCP |
| Guest review | Share SPA | — | guest remote MCP allowlist |

Shortcut cheatsheet: [daw-shortcuts.md](daw-shortcuts.md) / [ux shortcuts](https://ux.sharecut.studio/#/shortcuts).
Contributor recipe stays in this file; the JSON contract is [`contracts/capabilities.manifest.json`](../contracts/capabilities.manifest.json).

### Local retained-bleed alignment

`align_retained_bleed_tool` and `podcast edit align-retained-bleed` preview or apply supported local phrase corrections. `set_retained_bleed_alignment_mode_tool` and `podcast edit bleed-alignment-choice` save or reset user timing decisions. `apply_transcript_gate_tool` checks retained-bleed alignment by default. Explicit selected lane and finite start/end enable bounded owner-phrase discovery without copy words; other requests remain transcript-seeded. Both paths exclude explicit foreign attribution from owner seeds, including manually retained foreign text, and refuse completed selected-source intervals overlapping foreign attribution. `no_retained_bleed_candidate` reports an eligible window without either permitted candidate origin as unmeasured. See [audio engineering](audio-engineering.md#retained-bleed-during-overlapping-speech) for scope, persistent choices, and abstention behavior.

Studio **Find and replace transcript** is a host-only toolbar and command-palette action (`transcript.findReplace`, capability `daw.transcript.findReplace`). It previews literal source-keyed replacements through `POST /api/transcript/replacement-preview` and applies them through `ReplaceTranscriptMatches`. Both delegate to `EditService`; guests cannot access the private source preview or batch mutation. Host agents use `find_replace_transcript_tool` or `podcast transcript find-replace` (preview, then the same command with its preview token).

The host **Adjust word timing** capability (`daw.transcript.adjustTiming`, command `transcript.adjustTiming`) opens the selected word's inline Wordbar from its inspector or the command palette. It uses native keyboard range controls and exact numeric fields; no global shortcut is registered. Saving uses host-only `SetTranscriptWordTiming` through `EditService.set_word_timing`; host agents submit the same command with `set_word_timing_tool` or `podcast transcript set-word-timing`. See [Wordbar source timing](daw-editing.md#wordbar-source-timing).

`daw.range.mute` exposes registered `propose_range_mute_tool` for agent proposals with a serialized exact target and explicit retry command ID. It submits pending state through the existing document service; interactive host approval remains separate. `daw.range.cut` has the twin `propose_range_cut_tool` (and `podcast edit propose-range-cut`), which seals a timeline interval on chosen lanes and proposes an exact cut the same way. See [reviewed bleed ranges](transcript-reconcile.md#reviewed-bleed-ranges).

Studio **Copy** and **Paste** (`daw.edit.copy`, `daw.edit.paste`) have the twins `copy_segment_tool` / `podcast edit copy-segment`, which return the clipboard (`{duration, extracts}`), and `paste_segment_tool` / `podcast edit paste-segment`, which submit it as `PasteSegment` with the GUI's payload; a clipboard the project cannot take fails with a coded `paste_*` error and writes nothing. Both adapters build that payload only in `submit_paste_segment` (`services/document_sync/host_submit.py`). `move_segment_tool` is not a Paste twin: it closes the source range instead of keeping it and opening a gap.
