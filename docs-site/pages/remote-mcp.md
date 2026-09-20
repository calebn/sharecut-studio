# Remote MCP

> **Requires** the built-in FOSS `collaboration` extension, share capability `mcp`, and
> `PODCAST_REMOTE_MCP=1` on the host. Not available when `PODCAST_EXTENSIONS=`
> (extensions disabled). Public agents also need tunnel + relay.

Capability-scoped guest MCP over Streamable HTTP JSON-RPC at
`/mcp/{token}/mcp` (share URL alias `/r/{token}/mcp`). Requires share capability
`mcp` plus the other caps that unlock each tool.

Full narrative: [docs/host-online-relay.md](https://github.com/calebn/sharecut-studio/blob/main/docs/host-online-relay.md)
§ Remote MCP.

Host product surfaces (GUI / keys / host MCP / skills): [Capabilities](#/capabilities).

<!-- remote-mcp-tools:generated -->

> **Auto-generated** from `services/remote_mcp/allowlist.py`. Run `make schema-export`.

### Tools by capability

| Caps | Tools |
|------|-------|
| `play` | `guest_audio_info`, `guest_get_review_summary`, `guest_list_comments` |
| `play` + `view` | `guest_audition_context`, `guest_pending_preview` |
| `+view` | `guest_get_project`, `guest_get_session_presence`, `guest_list_applied_edits`, `guest_list_clips`, `guest_list_pending_edits`, `guest_render_status`, `guest_search_transcript` |
| `+comment` / `reply` | `guest_add_comment`, `guest_add_reply` |
| `+action` | `guest_set_action_done` |
| `+suggest` / `+edit` | `guest_submit_document_command` |
| `+edit` only | `guest_render_preview`, `guest_upload_media` |

<!-- /remote-mcp-tools:generated -->

## Document submit

`guest_submit_document_command` uses the **same** JSON Schema as host/guest HTTP:

- Live catalog: [Document commands](#/document-commands)
- Schema file: [document-commands.schema.json](../schemas/document-commands.schema.json)
- Guest OpenAPI (HTTP twin): [guest-share.openapi.json](../schemas/guest-share.openapi.json)

Invalid arguments return JSON-RPC **`-32602`**.

## Not available on guest MCP

Even with `mcp` set: pipeline run, full ingest consolidate, episode create,
host-speaker `play`, and other host-only mutations. Agents stream audio via HTTP
URLs from `guest_audio_info` and `guest_pending_preview` — remote MCP does not
play on the host laptop.
