# Set up local ShareCut Studio MCP

ShareCut Studio can run as a local MCP server with no account, API key, or
network connection. `podcast-mcp` communicates over standard input and output.

## Verify the install

```bash
podcast-mcp --version
podcast-mcp --help
```

The command accepts no server arguments. Your MCP client launches it and sends
the MCP protocol over stdio.

## Configure an MCP client

Use the absolute path to the virtual-environment executable when the client does
not inherit your shell `PATH`:

```text
/path/to/sharecut-studio/.venv/bin/podcast-mcp
```

For a JSON MCP configuration, use:

```json
{
  "mcpServers": {
    "sharecut": {
      "command": "/path/to/sharecut-studio/.venv/bin/podcast-mcp"
    }
  }
}
```

### Select a default episode

Tools that accept `project_path` can use a default set on the stdio server:

```json
{
  "mcpServers": {
    "sharecut": {
      "command": "/path/to/sharecut-studio/.venv/bin/podcast-mcp",
      "env": {
        "PODCAST_MCP_PROJECT": "/absolute/path/to/episode.sharecut"
      }
    }
  }
}
```

An explicit non-empty `project_path` wins. A missing (`null`/`None`) or empty
path falls back to `PODCAST_MCP_PROJECT`. If there is no explicit path and no
default, the tool returns an error explaining how to configure one.

For Claude Code, run:

```bash
claude mcp add sharecut -- /path/to/sharecut-studio/.venv/bin/podcast-mcp
```

For a shell-configured client, set the same environment variable before the
client command:

```bash
PODCAST_MCP_PROJECT=/absolute/path/to/episode.sharecut \
  claude mcp add sharecut -- /path/to/sharecut-studio/.venv/bin/podcast-mcp
```

The same command path works for Claude Desktop, Cursor, Windsurf, and Cline.
Restart or reload the MCP client after updating its configuration.

## Co-edit with the desktop GUI

When ShareCut Studio is open, **Menu > Connect agent...** shows a connection
address for the episode you have open. Studio has to keep running while an AI
app uses it.

1. In Studio, choose **Copy address**.
2. In your AI app, open its MCP or connector settings (the name differs from app
   to app) and add a new server with that address.
3. Ask the app to do something in ShareCut. The line in the dialog updates when
   Studio gets the request.

The address only works on the same computer. The dialog shows the real one;
the port can differ, and 8765 is the default for a command-line start:

```text
http://127.0.0.1:8765/mcp
```

If your app wants a config file instead, the dialog's **Config file format**
shows this block (with the dialog's address, which may use a different port):

```json
{
  "mcpServers": {
    "sharecut": { "url": "http://127.0.0.1:8765/mcp" }
  }
}
```

The dialog says when an app last *used* the address: "An app used this address
2 minutes ago", then "Last used 25 minutes ago". It cannot tell whether an app
is still connected, because Studio keeps no sessions for it, and it remembers
only the time of the latest successful request until Studio restarts. Any local
program that sends a valid request counts, not only an AI app. If this Studio
cannot accept connections from other apps, the dialog says so and shows no
address.

## Troubleshooting

- If the client reports `command not found` or `spawn ENOENT`, configure the
  absolute virtual-environment path instead of a bare `podcast-mcp` command.
- If a configuration change is not picked up, restart the client or reload its
  MCP servers.
- For the repository's detailed client-specific instructions, see
  [MCP setup on GitHub](https://github.com/calebn/sharecut-studio/blob/main/docs/mcp-setup.md).
- If the dialog still says "No app has used this address since Studio started",
  check that the address in the app matches the dialog exactly, that the app has
  been told to use ShareCut, and that Studio is still running. The line resets
  whenever Studio restarts.
- If the app uses a different local port than the dialog shows, copy the address
  again; the port can change between runs.
