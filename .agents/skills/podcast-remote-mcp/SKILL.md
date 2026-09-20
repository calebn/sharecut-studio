---
name: podcast-remote-mcp
description: >-
  Connect a remote MCP client to a review share token so an agent uses the same
  capabilities as that share's web guest (relay/tunnel). Use when a collaborator
  needs an agent on a shared episode without host filesystem access — not local
  podcast-mcp stdio on the host machine.
---

# podcast-remote-mcp

Connect a remote MCP client (e.g. Cursor) to a **review share token** so an agent can interact with the episode using the **same capabilities** as that share’s web guest. Not local `podcast-mcp` stdio, and not the host GUI URL `http://127.0.0.1:8765/mcp` (that is Menu → **Connect agent…** on the owner’s DAW). `--kind record` mints studio `/rec/` links (not for MCP yet).

## When to use

- Collaborator needs an agent against a shared episode without host filesystem access
- Share already (or will) include `mcp` plus `view` / `comment` / `suggest` / `edit` as appropriate

## Host checklist

1. Enable the FOSS collaboration surface (it is the default):
   `PODCAST_EXTENSIONS=collaboration`. Use
   `PODCAST_EXTENSIONS=collaboration,online` only when a provider extension is
   installed and its account surface is wanted.
2. `PODCAST_REMOTE_MCP=1 podcast gui --project <episode.project.json> --no-open`
3. `podcast tunnel --project … --relay-url wss://<relay>/tunnel --host-token …`
4. Publish a review version if needed: `podcast review publish-version …`
5. Create share with `mcp` **and** the caps the agent should have:

```bash
podcast review share --project … --version <id> \
  --role commenter --with-mcp \
  --base-url https://share.example.com
# or raw: --capabilities play,view,comment,mcp
```

Roles (`viewer` / `commenter` / `editor`) expand to the same caps the web guest
uses. Link shares stay login-free; Restricted ACL shares need a user-bound agent
credential (see [share-tokens.md](../../docs/share-tokens.md) § Identity).

CLI prints `Share URL` and `MCP URL` (e.g. `https://…/r/fantastic-acoustic-whale` and
`https://…/mcp/fantastic-acoustic-whale/mcp`). Token format and uniqueness:
[share-tokens.md](../../docs/share-tokens.md).

**URL shapes:** browser guest = `/r/{token}`; remote MCP = `/mcp/{token}/mcp`
(canonical / printed). `/r/{token}/mcp` is a same-bridge alias when a client appends
`/mcp` to the share URL. Do not invent other paths.

## Client config (Cursor)

```json
{
  "mcpServers": {
    "podcast-remote": {
      "url": "https://share.example.com/mcp/fantastic-acoustic-whale/mcp"
    }
  }
}
```

POST JSON-RPC with `Accept: application/json` (`initialize`, `tools/list`, `tools/call`).
Claude may also send `Accept: application/json, text/event-stream`.

Pass `params._meta.progressToken` on `tools/call` to receive MCP `notifications/progress` (headline, optional units) as Streamable HTTP SSE `event: message` frames, then the JSON-RPC result. Requests without a token stay JSON. The same wrap fans a `plane: "progress"` event to **this** share’s guest WS so ReviewApp / Studio share mode show an Activity chip. Host jobs and other tokens never appear. Payloads never include host filesystem paths.

## Client config (Claude.ai custom connector)

1. Settings → Connectors → Add custom connector.
2. Paste the printed **MCP URL** (`https://…/mcp/{token}/mcp`), not the Share URL.
3. Leave **OAuth Client ID** blank — link shares are **authless** (`none`); Claude must not enter OAuth DCR.
4. Restricted/`require_sign_in` shares are not Claude-authless (need agent Bearer / future MCP OAuth).

## Powers

Tools are scoped to the share’s capabilities — not the full local `podcast-mcp` stdio surface. Cap→tool matrix: [docs/host-online-relay.md](../../docs/host-online-relay.md) § Remote MCP.

**Share agent = share user:** the agent may take any action that human can take in Sharecut Studio/ReviewApp at those caps. `play` means both can hear (human transport vs agent windowed context). HTTP is the source of truth; guest MCP is a thin façade. Host CLI/skills/`afplay` stay off the share. **Comment resolve is host-only** (no guest HTTP/MCP).

Agents never pass `project_path`; the token binds the workspace. Audio is via share HTTP URLs (`guest_audio_info`, `guest_pending_preview`, `guest_audition_context`), not host speakers. For a pending session remove, call `guest_pending_preview` (`mode=suggested` default, optional `visual=true` for waveform/spectrogram PNGs) then stream the returned `/api/review/{token}/daw/pending-preview…` URLs. For an arbitrary timeline span, call `guest_audition_context` (`play`+`view`; captions + wave/spec PNG). Use `guest_get_session_presence` (`view`) to see who is in the Sharecut Studio session (cursor including chrome anchors, selection, viewport, transport, `ui` tab/audition/mute/solo). Sharecut Studio guests with `view`/`play` prefer **proxy MP3 chunks** (S3-compatible object storage/CDN when configured) over tunneling host WAV — see [docs/host-online-relay.md](../../docs/host-online-relay.md) § Proxy media. Shares with **`edit`** may call `guest_render_preview` (rebuild stems/mix preview) and `guest_upload_media` (chunked base64 into host `raw/`, same as `POST …/daw/media/upload`); suggest/view cannot.

## Related

- **podcast-timeline-comments** — publish/share/comments
- Docs: [host-online-relay.md](../../docs/host-online-relay.md), [timeline-comments.md](../../docs/timeline-comments.md)
