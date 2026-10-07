# Errors & limits

Transport-specific shapes today. A unified HTTP `code` field is planned before 1.0;
until then parse by status / JSON-RPC `error.code`.

## Document-command validation

| Surface | Reject |
|---------|--------|
| Host `POST /api/document/command` | HTTP **422** (FastAPI validation `detail` list) |
| Guest `POST …/daw/document/command` | HTTP **422** |
| Guest MCP `guest_submit_document_command` | JSON-RPC **`-32602`** |

Comment / reply body max: **8000** characters.

## Conflicts & busy

| Case | HTTP | Notes |
|------|------|--------|
| Guest offline / apply conflict | **409** | May include `conflict: true` in JSON detail |
| Render / job busy | **409** | Retry after host finishes |

## Guest MCP tool failures

A failed `tools/call` is a tool result, not a JSON-RPC error. JSON-RPC `error` is for the
protocol only.

| Case | Shape |
|------|-------|
| Refusal (the call was understood and declined: unknown id, stale target, busy project, bad value) | `result.isError: true`, the refusal's message as text, and `structuredContent {ok: false, error, error_code}`. Codes are stable, for example `comment_not_found`, `edit_not_found`, `clip_not_found`, `no_clip_at_time`, `invalid_range`, `job_running`, `project_busy`. Host file paths in the message read `[path]` |
| Crash (anything unexpected) | `result.isError: true` with only `Error executing tool <name>`; no `structuredContent`. The host logs the detail |
| Unknown tool, or arguments that do not fit the tool | JSON-RPC **`-32602`** (`error.data.error_code: "invalid_arguments"` for arguments) |
| Share capability denied | JSON-RPC **`-32003`** |
| Share revoked, expired or its project gone | JSON-RPC **`-32004`** `share not found` |
| Failure outside any tool | JSON-RPC **`-32603`** `internal error` |

With a `progressToken`, a failed task's `notifications/progress` message reads `<name> failed`
for a crash and adds the refusal's message only for a refusal.

## AuthZ / missing caps

| Case | HTTP / MCP |
|------|------------|
| Share missing required cap | **403** |
| Remote MCP disabled on host | **501** |
| Remote MCP without `mcp` cap | **403** |
| Guest MCP tool not allowed | JSON-RPC permission error (message-only) |

## Rate limits

In-process token buckets (single worker). Full env matrix:
[host-online-relay.md § Rate limiting](https://github.com/calebn/sharecut-studio/blob/main/docs/host-online-relay.md).

| Signal | Shape |
|--------|--------|
| HTTP | **429** + `Retry-After` seconds; body may include `bucket`, `retry_after_sec` |
| Guest / document WS | Close code **4429** |
| Guest MCP | JSON-RPC **`-32029`** |

Defaults (order of magnitude): relay ~600 RPM/token, host reads ~300 RPM, host mutates ~60 RPM; audio uses concurrency caps, not RPM.

## Body size

| Layer | Default | Env |
|-------|---------|-----|
| Relay proxy | 4 MiB | `PODCAST_RELAY_MAX_BODY_BYTES` |
| Host GUI | 4 MiB | `PODCAST_GUI_MAX_BODY_BYTES` |
| Remote MCP | 1 MiB | `PODCAST_REMOTE_MCP_MAX_BODY_BYTES` |

Oversized → HTTP **413** `{ "detail": "request body too large", "limit_bytes": … }`.
Media upload routes use separate chunk/quota caps.

## Link-share auth model

Knowing the share token grants the share’s capability set (“anyone with the link”).
Treat tokens like passwords; revoke/rotate on the host when a link leaks.
Restricted / OAuth guest accounts are fail-closed stubs — not a production IdP yet.
