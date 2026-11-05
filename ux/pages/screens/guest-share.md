## Guest / share (`/r/{token}`)

Every review role (Viewer, Commenter, Editor) holds `view`, so every role opens ShareCut Studio guest. There is one guest surface for review links.

```mermaid
flowchart LR
  shareLink["Review link /r/token"] --> hasView{Has view?}
  hasView -->|yes, every role| dawGuest[ShareCut Studio guest]
  hasView -->|no, API-only share| noPage[Cover: link does not open the project]
```

### Which surface?

| Share setup | Surface | What the guest sees |
|-------------|---------|---------------------|
| Viewer, Commenter (default) or Editor | **ShareCut Studio guest** | Stages gated by role (a Commenter link is Review alone). Role chip in the header. |
| Any capability set without `view` (API only, no role mints one) | **Cover** | "This link doesn't open anything" with "Ask the person who sent it for a new link." beneath it. |

A dead, revoked or no-`view` link, and a host that cannot be reached with no saved copy, each show a full-page cover instead of the studio: the link covers say "This link doesn't open anything" and "Ask the person who sent it for a new link."; "The host's computer is asleep" (a moon) (a down host, or a 502, 503 or 504 from the relay) says "This page tries again every 30 seconds." and offers **Try now**; any other load failure, such as a 429 or 500, shows "This link did not load" with **Retry**. The cover takes focus when it appears. When the host cannot be reached but this browser holds a saved copy, the studio opens read-only and the Save dot shows a hollow cloud and "Saved copy · N waiting" (the comments waiting to send, left out when none; the phone shows the cloud and the count); its tooltip and screen-reader text say "Showing a saved copy because the host can't be reached. It is read-only."

Step flows: [Guest journeys](#/journeys).

### Capability → plain language

| Cap | Guest can… |
|-----|------------|
| `play` | Hear the review mix or session audio in ShareCut Studio |
| `view` | Open ShareCut Studio guest (timeline, transcript, sanitized project) |
| `comment` | Leave time-anchored comments |
| `reply` | Reply in a comment thread |
| `action` | Check off comment action items |
| `suggest` | Commenter and Editor. Propose structural cuts (pending); nudge its own suggestions; **not** hard-apply |
| `edit` | Editor only. Approve/reject pending, fades/joins, FX bypass, apply structural cuts |
| `mcp` | Connect an **external** agent at `{base}/mcp/{token}/mcp` (host Share section copies the MCP URL when the host allowed AI assistants; **no guest in-app MCP connect UI**) |

### ShareCut Studio guest chrome (when `view` is granted)

| Header Role chip (accessible name) | Role (`guest_mode`) |
|---------------|--------------|
| *Editor: can edit* | Editor (`edit`) |
| *Commenter: can comment* | Commenter (`comment`) |
| *Viewer: can listen* | Viewer (`view`; listen + inspect, not “no audio”) |

**Comment field on a phone:** on the phone layout only (a landscape phone wider than 767 px uses the tablet shell and is not docked), a Commenter's Review comment field (with its "at 0:12" chip) comes last in the card and stays docked at the bottom of the panel, above the Player, while the card scrolls (on a viewport 480 px tall or shorter, such as a landscape phone, it is not docked and stays at the top of the card as on a tablet; an on-screen keyboard or a pinch zoom does not change this); on a tablet, a desktop and for the host it stays at the top of the card.

**Approve in the queue:** an Editor decides the suggested cuts in the Review queue with **Cut** and **Keep** (the Review badge counts them); Find more, unsure-word Fix and Resolve stay host-only. Approve and Reject also work from the Timeline overlay, and as Cut and Keep from the Action bar.

**Playback:** prefer **proxy media** (short MP3 listen chunks, often via CDN) so ordinary listen does not pull long host WAVs through the tunnel. Fallback to WAV when proxies are unavailable.

**AI assistants (`mcp`):** Hosts copy the MCP URL from Invite (or Deliver → Share for review) after creating the link with **Allow AI assistants (MCP)**. The assistant connects through an MCP client such as Claude or ChatGPT — not a guest Settings pane. Same role as the human on that share. Listen-first Suggested is HTTP (`guest_pending_preview` / `GET …/daw/pending-preview`), not host speakers.
