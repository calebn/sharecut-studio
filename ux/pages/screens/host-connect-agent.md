## Host: Connect agent dialog

| | |
|--|--|
| **Purpose** | Copy the local Streamable HTTP MCP URL so Cursor/Claude talk to the running DAW |
| **Open** | Project menu → **Connect agent…** (`mcp.connect`); Home app menu (the wordmark) → **Connect agent** |
| **Primary actions** | **Copy URL** (`http://127.0.0.1:8765/mcp`, focused when the dialog opens) · **Copy snippet** (Cursor `mcpServers` JSON). Both buttons are 44 px tall with a mouse as well as touch. After a copy the button reads **Copied** and a status line says "Copied MCP URL" or "Copied client snippet"; both clear after 2 seconds, and a second copy restarts the 2 seconds. Focusing or clicking the URL or the snippet selects all of it |
| **Data shown** | Loopback MCP URL; client snippet; reminder to keep ShareCut Studio running |
| **Empty / error** | No episode open: URL still copies, tools error until a project is open. If the browser refuses the copy (or has no clipboard) the dialog says, for every cause, "Couldn't copy. Select the text and copy it by hand."; it replaces any "Copied" label and stays until the next copy or close |
| **Out of scope** | Writing `~/.cursor/mcp.json`; PATH-installing `podcast-mcp`; guest share-token MCP (that stays on Share…) |

Guest share agents use `{base}/mcp/{token}/mcp`.
