# Connecting your agent to Sharecut Studio (MCP)

Sharecut Studio is an MCP server. Any MCP-compatible harness —
Claude Code, Claude Desktop, Cursor, Windsurf, Cline, … — can drive it.
No API keys, no accounts, no network: everything runs locally.

There are two modes. Pick one:

| Mode | When to use it | How the agent reaches the episode |
|------|----------------|----------------------------------|
| **stdio** (headless) | The agent works on its own: transcribe, tighten, edit, export | You pass `project_path` to each tool call |
| **GUI-attached** (Streamable HTTP) | You're co-editing with the DAW open | Tools apply to the episode pinned in the GUI |

## Mode 1: stdio (recommended starting point)

The server needs zero configuration: `podcast-mcp` speaks stdio and
takes no arguments. Verify your install first:

```bash
podcast-mcp --version
```

### The PATH gotcha (read this)

Harnesses do **not** inherit your shell `PATH`. If the harness can't
find `podcast-mcp`, point `command` at the absolute venv binary:

```
/path/to/sharecut-studio/.venv/bin/podcast-mcp
```

### Claude Code

```bash
claude mcp add sharecut -- /path/to/sharecut-studio/.venv/bin/podcast-mcp
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sharecut": {
      "command": "/path/to/sharecut-studio/.venv/bin/podcast-mcp"
    }
  }
}
```

Restart Claude Desktop after editing the config.

### Cursor

`.agents/mcp.json` in this repo already ships a working entry, and
Cursor picks it up automatically when you open the project. If the
server fails to start, override the command with the absolute venv path
above in `.muse/mcp.json`.

### Windsurf

Add to your MCP config (`~/.codeium/windsurf/mcp_config.json`):

```json
{
  "mcpServers": {
    "sharecut": {
      "command": "/path/to/sharecut-studio/.venv/bin/podcast-mcp"
    }
  }
}
```

### Cline

MCP Servers → Installed → add:

```json
{
  "sharecut": {
    "command": "/path/to/sharecut-studio/.venv/bin/podcast-mcp",
    "disabled": false,
    "autoApprove": []
  }
}
```

## Mode 2: GUI-attached (Streamable HTTP)

With the DAW open, the GUI itself is an MCP server — same tools, but
they act on the episode you have open, so the agent doesn't need a
`project_path` for every call.

1. Run `podcast gui` and open an episode.
2. **Menu → Connect agent…** to copy the URL (or type it):
   `http://127.0.0.1:8765/mcp`
3. In your harness, add it as a Streamable HTTP server:

```json
{
  "mcpServers": {
    "sharecut": {
      "url": "http://127.0.0.1:8765/mcp"
    }
  }
}
```

Keep the GUI running. This endpoint is loopback-only by design.
Details: [gui-integration.md](gui-integration.md) § Local host MCP.

## Troubleshooting

- **Server won't start / "command not found"**: use the absolute venv
  path (see "The PATH gotcha" above), not a bare `podcast-mcp`.
- **"spawn ENOENT" in the harness**: same cause — absolute path.
- **Changes not picked up after install/upgrade**: most harnesses only
  read MCP config at launch; restart the harness or reload its MCP
  servers.
- **Sanity check outside the harness**: `podcast-mcp --help` prints
  usage; piping an MCP `initialize` request on stdin should return a
  handshake response. If that works, the server is fine and the problem
  is the harness config.
- **Remote/collaborator agents** don't use this page — they connect
  through a share link: [host-online-relay.md](host-online-relay.md)
  § Remote MCP.
