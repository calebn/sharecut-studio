# Connecting your agent to ShareCut Studio (MCP)

ShareCut Studio exposes local Model Context Protocol (MCP) tools. This guide
covers the two local connection modes:

| Mode | Use it when | Episode selection |
| --- | --- | --- |
| **stdio** | The agent works independently on a project | Pass `project_path`, or set a default with `PODCAST_MCP_PROJECT`. While ShareCut Studio serves that project, the tool call runs in Studio (one writer, no "Project is busy"); if no Studio serves it, it runs in the stdio process; a Studio found serving the project that has no `/mcp` (a non-loopback bind), that is bound to `127.0.0.2` or a LAN address and so cannot take handoff at all, or that fails before the call is sent stops the call with an error and nothing runs. |
| **GUI-attached Streamable HTTP** | You are editing with ShareCut Studio open | Tools use the episode currently open in the GUI. |

Both modes are local. They do not require an API key or account. The GUI MCP
endpoint binds to loopback only; do not expose it through a tunnel or a public
network interface.

Discovery skips the loopback ping and runs locally when an announced positive
PID is confirmed gone: on POSIX when the signal-0 probe finds no process, on
Windows when `OpenProcess` reports no such process or `GetExitCodeProcess`
shows an exit code other than 259 (a read-only query, never a signal).
Nonpositive PIDs, PIDs beyond 32 bits and uncertain process checks (access
denied, any other error) retain the protective ping. When stdio discovers an announced Studio,
each loopback ping has five seconds to complete its network exchange. Receiving
part of a reply does not restart that time. A timeout is retried once. If both
attempts time out,
the tool stops with an error instead of running locally, since Studio may still
be serving the project. A refused connection before the deadline is treated as
a stale announcement and allows local execution. Once response headers arrive,
a connection reset while reading the ping body is an incomplete reply. The tool
stops with an error and does not run locally. Body-read timeouts still follow
the retry rule above. The CLI uses the same discovery rules.

After discovery succeeds, stdio gives MCP initialization ten seconds total,
including transport setup. Incoming bytes do not restart this deadline. If
initialization times out, the tool is not sent and the call stops with an error
saying nothing was run. It does not run locally behind Studio. This deadline
ends when initialization succeeds and does not limit tool execution, including
long calls with or without progress notifications.

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
3. Keep ShareCut Studio running while the agent is connected.

The endpoint is loopback-only and applies tools to the currently open episode.
It is not OAuth, not a share token, and is unsuitable for remote or
collaborator agents; use a review share's remote MCP endpoint for those cases
([host-online-relay.md](host-online-relay.md) § Remote MCP).

The GUI host transport is stateless: each request is handled independently and
the server does not issue or require a sticky `Mcp-Session-Id` header. The
currently open episode is selected by ShareCut Studio for every request. This
does not change stdio MCP sessions or guest/share-token MCP, which keep their
existing transport behavior.

Use POST for host MCP requests. GET and HEAD return `405 Allow: POST` rather
than opening a standalone SSE stream that cannot receive events from another
stateless request. Legacy clients that send `notifications/cancelled` as a
separate POST cannot stop an in-flight host call; the SDK acknowledges that
notification on its independent request. Modern 2026 clients cancel by closing
the original POST. [Issue #151](https://github.com/calebn/sharecut-studio/issues/151)
tracks legacy cancellation support without sticky sessions.

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

## Downloading a missing model

When an action needs a model that is not installed, its tool refuses with
`error_code: "model_needed"`. The `structuredContent.model` object names the model
(`id`, `label`, `size`, `command`, `state`), and the text ends with the next step.
Ask the user before downloading: models are large (Whisper up to about 3 GB), and the
download is never started for you. For Whisper the refusal also carries `whisper_model`, the size that
was picked; pass it to `model_download` so that size is the one downloaded.

- `model_download(component, whisper_model=None, upgrade=False)` downloads one model, only
  after the user agrees. Inside the ShareCut Studio process (your client connected to Studio's
  own MCP endpoint) it starts a download job and returns `job_id`. In a stdio server it
  downloads inside the call, even when Studio is running next to it (the tool takes no
  `project_path`, so it is not handed to Studio): that can take minutes for Whisper, reports
  progress while it runs, starts no job and is not visible to Studio. A download already running for another model
  is refused as `bootstrap_job_running`.
- `model_download_status(job_id=None)` reads a Studio download job: `status`, the current
  `download` (`component`, `bytes`, `total`) and any `failure`. Only the Studio process has
  download jobs; from a stdio server it always returns `{"running": false}`, including right
  after an inline `model_download`.

Both tools are for the owner's agent only; a share guest's remote MCP does not list them.

## Troubleshooting

- **Command not found / `spawn ENOENT`:** use an absolute venv executable path,
  not a bare `podcast-mcp` command.
- **Tools are missing after configuration changes:** restart the client or
  reload its MCP servers.
- **GUI tools say no episode is open:** open an episode in ShareCut Studio;
  GUI-attached tools act on the pinned GUI episode.
- **The GUI URL will not connect from another machine:** this is expected. Host
  MCP is loopback-only by design.
