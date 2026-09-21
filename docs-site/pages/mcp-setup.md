# Set up local Sharecut Studio MCP

Sharecut Studio can run as a local MCP server with no account, API key, or
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

For Claude Code, run:

```bash
claude mcp add sharecut -- /path/to/sharecut-studio/.venv/bin/podcast-mcp
```

The same command path works for Claude Desktop, Cursor, Windsurf, and Cline.
Restart or reload the MCP client after updating its configuration.

## Co-edit with the desktop GUI

When Sharecut Studio is open, **Menu > Connect agent...** provides the local
Streamable HTTP endpoint:

```text
http://127.0.0.1:8765/mcp
```

Use that URL in a Streamable HTTP MCP configuration to work on the episode open
in the GUI. The endpoint is loopback-only.

## Troubleshooting

- If the client reports `command not found` or `spawn ENOENT`, configure the
  absolute virtual-environment path instead of a bare `podcast-mcp` command.
- If a configuration change is not picked up, restart the client or reload its
  MCP servers.
- For the repository's detailed client-specific instructions, see
  [MCP setup on GitHub](https://github.com/calebn/sharecut-studio/blob/main/docs/mcp-setup.md).
