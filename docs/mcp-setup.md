# Connecting your agent to Sharecut Studio (MCP)

Sharecut Studio exposes local Model Context Protocol (MCP) tools. This guide
covers the two local connection modes:

| Mode | Use it when | Episode selection |
| --- | --- | --- |
| **stdio** | The agent works independently on a project | Pass `project_path`, or set a default with `PODCAST_MCP_PROJECT`. |
| **GUI-attached Streamable HTTP** | You are editing with Sharecut Studio open | Tools use the episode currently open in the GUI. |

Both modes are local. They do not require an API key or account. The GUI MCP
endpoint binds to loopback only; do not expose it through a tunnel or a public
network interface.

## Mode 1: stdio

`podcast-mcp` runs the stdio server when launched without arguments. Confirm
that the MCP server is installed with its direct version command:

```bash
podcast-mcp --version
```

`podcast-mcp --help` also prints usage and exits.

### Select a default episode for stdio

Tools that take `project_path` accept a per-call path as usual. To pin one
episode for the entire stdio session, set `PODCAST_MCP_PROJECT` in the MCP
server environment:

```json
{
  "mcpServers": {
    "sharecut": {
      "command": "/path/to/sharecut-studio/.venv/bin/podcast-mcp",
      "env": {
        "PODCAST_MCP_PROJECT": "/absolute/path/to/episode.project.json"
      }
    }
  }
}
```

An explicit, non-empty `project_path` always wins over the environment value.
`null`/`None` and an empty string use `PODCAST_MCP_PROJECT` instead. If neither
is supplied, the tool returns an error explaining how to pass a path or set the
environment variable.

### Use an absolute executable path

Desktop applications often do not inherit your shell `PATH`. Replace the
example path below with your installation's absolute path:

| Platform | Example executable path |
| --- | --- |
| macOS, Linux | `/path/to/sharecut-studio/.venv/bin/podcast-mcp` |
| Windows | `C:\\path\\to\\sharecut-studio\\.venv\\Scripts\\podcast-mcp.exe` |

The JSON examples use escaped Windows backslashes. In a shell command, use the
native Windows path normally (for example,
`C:\path\to\sharecut-studio\.venv\Scripts\podcast-mcp.exe`).

### Claude Code

```bash
claude mcp add sharecut -- /path/to/sharecut-studio/.venv/bin/podcast-mcp
```

To set the default episode from a shell, prefix the client command with the
environment variable (or add the JSON `env` block above to its MCP config):

```bash
PODCAST_MCP_PROJECT=/absolute/path/to/episode.project.json \
  claude mcp add sharecut -- /path/to/sharecut-studio/.venv/bin/podcast-mcp
```

On Windows, replace the command after `--` with the `.venv\Scripts\podcast-mcp.exe`
path above. Use `/mcp` in Claude Code to inspect the connection.

### Claude Desktop

Add the server to the local configuration file, then restart Claude Desktop:

| Platform | Configuration file |
| --- | --- |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

macOS/Linux example:

```json
{
  "mcpServers": {
    "sharecut": {
      "command": "/path/to/sharecut-studio/.venv/bin/podcast-mcp"
    }
  }
}
```

Windows example:

```json
{
  "mcpServers": {
    "sharecut": {
      "command": "C:\\path\\to\\sharecut-studio\\.venv\\Scripts\\podcast-mcp.exe"
    }
  }
}
```

### Cursor

Create `.cursor/mcp.json` in the project (or edit `~/.cursor/mcp.json` for a
personal global setup), then restart Cursor. The repository's
`.agents/mcp.json` is an agent-pack template; Cursor does not load it as its
project MCP configuration.

```json
{
  "mcpServers": {
    "sharecut": {
      "command": "/path/to/sharecut-studio/.venv/bin/podcast-mcp"
    }
  }
}
```

For Windows, use `"command": "C:\\path\\to\\sharecut-studio\\.venv\\Scripts\\podcast-mcp.exe"`.

### Cline

In the Cline panel, open **MCP Servers → Configure → Configure MCP Servers**.
Add the entry under `mcpServers`:

```json
{
  "mcpServers": {
    "sharecut": {
      "command": "/path/to/sharecut-studio/.venv/bin/podcast-mcp",
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

For Windows, use `"command": "C:\\path\\to\\sharecut-studio\\.venv\\Scripts\\podcast-mcp.exe"`.

### Windsurf: current Devin Local

New Windsurf tabs use Devin Local. Add this project-local stdio server with:

```bash
devin mcp add -s project sharecut -- /path/to/sharecut-studio/.venv/bin/podcast-mcp
```

This writes `.devin/mcp_config.json`. Use the native Windows executable path
after `--` on Windows. You may instead add the same `mcpServers`/`command`
entry to `.devin/mcp_config.json`, or to `~/.config/devin/mcp_config.json`
(`%APPDATA%\devin\mcp_config.json` on Windows).

### Windsurf: legacy Cascade

`~/.codeium/windsurf/mcp_config.json` configures the legacy Cascade agent, not
the default Devin Local agent in new tabs. If you intentionally use Cascade,
add:

```json
{
  "mcpServers": {
    "sharecut": {
      "command": "/path/to/sharecut-studio/.venv/bin/podcast-mcp"
    }
  }
}
```

For Windows, use `"command": "C:\\path\\to\\sharecut-studio\\.venv\\Scripts\\podcast-mcp.exe"`.

## Mode 2: GUI-attached Streamable HTTP

1. Run `podcast gui` and open an episode.
2. Choose **Menu → Connect agent…** to copy the URL:
   `http://127.0.0.1:8765/mcp`
3. Keep Sharecut Studio running while the agent is connected.

The endpoint is loopback-only and applies tools to the currently open episode.
It is not OAuth, not a share token, and is unsuitable for remote or
collaborator agents; use a review share's remote MCP endpoint for those cases
([host-online-relay.md](host-online-relay.md) § Remote MCP).

### Claude Code

```bash
claude mcp add --transport http sharecut http://127.0.0.1:8765/mcp
```

### Cursor

In `.cursor/mcp.json`, configure the Streamable HTTP URL:

```json
{
  "mcpServers": {
    "sharecut": {
      "url": "http://127.0.0.1:8765/mcp"
    }
  }
}
```

### Cline

Use **MCP Servers → Configure → Configure MCP Servers**, then set the
Streamable HTTP transport explicitly:

```json
{
  "mcpServers": {
    "sharecut": {
      "type": "streamableHttp",
      "url": "http://127.0.0.1:8765/mcp",
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

### Windsurf: current Devin Local

```bash
devin mcp add -s project sharecut http://127.0.0.1:8765/mcp
```

Devin Local infers Streamable HTTP from the URL. The equivalent
`.devin/mcp_config.json` entry uses `"url": "http://127.0.0.1:8765/mcp"`
and may set `"transport": "http"` explicitly.

### Windsurf: legacy Cascade

Legacy Cascade supports HTTP MCP servers. Add the loopback URL through its MCP
settings or its `mcp_config.json`; this legacy configuration does not configure
Devin Local.

### Claude Desktop

Claude Desktop's local `claude_desktop_config.json` supports the stdio setup
above, but it does not configure a loopback Streamable HTTP server. Its custom
connectors are cloud-connected and cannot reach `127.0.0.1`; use the stdio mode
for this local GUI, or a publicly reachable remote MCP connector when that is
appropriate.

## Troubleshooting

- **Command not found / `spawn ENOENT`:** use an absolute venv executable path,
  not a bare `podcast-mcp` command.
- **Tools are missing after configuration changes:** restart the client or
  reload its MCP servers.
- **GUI tools say no episode is open:** open an episode in Sharecut Studio;
  GUI-attached tools act on the pinned GUI episode.
- **The GUI URL will not connect from another machine:** this is expected. Host
  MCP is loopback-only by design.
