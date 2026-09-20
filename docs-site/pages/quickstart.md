# Quickstart

> **Alpha:** the public contract is unstable and may change without notice.
> Pin to a git SHA if you experiment. A dated changelog lands when we leave alpha.

Assumes a host is already running `podcast gui` with a share tunnel and you have a
share URL like `https://sharecut.studio/r/{token}` (or a local bridge).

## 1. Cursor / Claude remote MCP

Requires share capability `mcp` (plus whatever tools you need: `view`, `comment`, …).

```json
{
  "mcpServers": {
    "podcast-share": {
      "url": "https://sharecut.studio/mcp/YOUR_TOKEN/mcp"
    }
  }
}
```

Alias also works: `https://sharecut.studio/r/YOUR_TOKEN/mcp`. Leave OAuth blank for
link shares. Then call `tools/list` — the server returns only tools allowed by the
share’s caps.

## 2. Guest HTTP — add a timeline comment

Requires `comment`. Replace `HOST` with the public relay origin (or `http://127.0.0.1:8765`
when talking to the host GUI directly) and `TOKEN` with the share token.

```bash
curl -sS -X POST "$HOST/api/review/$TOKEN/comments" \
  -H 'content-type: application/json' \
  -d '{
    "author": "docs-quickstart",
    "body": "Hello from curl",
    "timeline_start": 12.5
  }'
```

Prefer document commands when you also use MCP/WS (same schema everywhere):

```bash
curl -sS -X POST "$HOST/api/review/$TOKEN/daw/document/command" \
  -H 'content-type: application/json' \
  -d '{
    "type": "AddComment",
    "client_id": "curl-quickstart",
    "client_seq": 1,
    "payload": {
      "author": "docs-quickstart",
      "body": "Hello via document command",
      "timeline_start": 12.5
    }
  }'
```

Invalid payloads → HTTP **422**. Over quota → **429** + `Retry-After` (see [Errors & limits](#/errors)).

## 3. Guest MCP — submit the same command

JSON-RPC over Streamable HTTP (`Accept: application/json`):

```bash
curl -sS -X POST "$HOST/mcp/$TOKEN/mcp" \
  -H 'content-type: application/json' \
  -H 'accept: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "guest_submit_document_command",
      "arguments": {
        "type": "AddComment",
        "client_id": "mcp-quickstart",
        "client_seq": 1,
        "payload": {
          "author": "docs-quickstart",
          "body": "Hello via guest MCP",
          "timeline_start": 12.5
        }
      }
    }
  }'
```

Bad arguments → JSON-RPC **`-32602`**. Catalog: [Document commands](#/document-commands).

## Next

| Page | Use |
|------|-----|
| [Share HTTP](#/share-http) | Caps + route table |
| [Remote MCP](#/remote-mcp) | Cap → tool matrix |
| [Errors & limits](#/errors) | 422 / 429 / MCP codes |
| [Threat model](#/threat-model) | Host vs relay vs guest trust |
