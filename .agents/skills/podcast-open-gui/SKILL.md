---
name: podcast-open-gui
description: >-
  Open the read-only DAW web viewer for an episode via MCP. Use when the user
  wants to see the timeline, spin up the GUI, or watch agent edits in the browser.
---

# Open the DAW viewer

## Harness

**MCP (preferred):**

| Tool | When |
|------|------|
| `open_gui_tool` | Start (or reuse) the viewer and open the browser |
| `get_session_state_tool` | Confirm the DAW is sharing playhead/region after launch |
| `get_session_presence_tool` | Roster after launch — the Agent avatar is followable; rows include `ui` (tab, audition, mute/solo) and anchor cursors |
| `seek_session_tool` / `set_session_region_tool` / `set_session_playing_tool` | Drive the open viewer |

**CLI:**

```bash
podcast gui --project /path/to/episode.project.json --background
# foreground (blocks the terminal):
podcast gui --project /path/to/episode.project.json
```

## Prerequisites

- `uv sync --extra gui` (FastAPI / uvicorn)
- Built UI once: `cd gui/web && npm install && npm run build`
- If `open_gui_tool` returns `static_built: false`, run the build and call again (API may already be up)

## Workflow

1. Call `open_gui_tool(project_path=…)` — idempotent; reuses a healthy server on `:8765`.
2. Tell the user the returned `url` (includes `?project=`).
3. After edits (cut/approve/pipeline), the viewer live-reloads from project mtime; use session tools to seek/highlight what changed.
4. To drive the open episode from Cursor/Claude **without stdio**, connect Streamable HTTP to `http://127.0.0.1:8765/mcp` (home or Menu → **Connect agent…**; loopback bind only). Keep the GUI running. Skill/docs: [gui-integration.md](../../../docs/gui-integration.md) § Local host MCP.
5. Prefer browser transport for “show me” moments; use `podcast-play-audition` for OS speaker audition.

## Rules

- Do not block the agent on a foreground `podcast gui` process — use `open_gui_tool` or `--background`.
- One viewer process can serve a project via `?project=`; on loopback you may omit `--project` for the New/Open home, then navigate into a project.
- Session sync tools need the viewer (or a prior play/seek) for a useful shared state file.

See [docs/gui-integration.md](../../../docs/gui-integration.md) (§ Launch, § Local host MCP, § Project / track / audio ingest).
