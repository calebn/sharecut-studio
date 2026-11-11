## Host: Invite sheet (every stage) and the Deliver Listen link

| | |
|--|--|
| **Purpose** | Manage review links, record-room guest / producer invites and the listen link for the open episode from one sheet |
| **Open** | Header **Invite** on every stage, Project → Share…, and the Record stage's empty Person tile, Record **More** → **Invite and links…** (these open it at **Record links**) all open the Invite sheet over the current stage (`share.manage`, optional `at: record`; collaboration extension slot `share.ui.menu`). Header Invite is hidden for Viewer and Commenter guests. A centered sheet on desktop and tablet, a bottom sheet on a phone |
| **Groups** | **Review links**, **Record links**, **Listen link**, in that order. Each Review and Listen group opens with a ready Link row at its default (Review: Commenter, following the latest version; Listen: Viewer, pinned to the version current when you copy it). There is no Create button: the link is made and copied on the row's first **Copy** |
| **Link row** | Role chip (a Viewer / Commenter / Editor choice while the review link is not made yet), the link in mono cut in the middle, a globe glyph (filled: reachable from anywhere; slashed: only on this network) that opens a one-sentence popover, who opened it with a count, a **Pin to this version** toggle (on: frozen on this version; off: follows the latest; set before the link is made and shown read-only after), **Copy** and **More**. More holds **Allow AI assistants** (a setting before the link is made, **Copy MCP URL** after) and **Stop sharing**, which confirms in place. The QR code, **Replace link** on a review link and changing the pin of a made link are not built: they need a backend that does not exist yet |
| **Record links** | Each record room with its guest and producer links, Copy for each, **Replace** for a closed invite, **End room** (confirmed in place); **Create record links** and, once, **Open Record stage** under the rooms (only when at least one room exists, the sheet is over another stage and the Record stage is available; disabled while a share action is running; it closes the sheet and, like Mod+1, stops following). “No record rooms yet.” when there are none |
| **Data shown** | Online sharing line at the top (when the `tunnel.status` feature is present): “Guests can open your links”, “Connecting…”, “Reconnecting… guests may see a brief interruption” with a “Trying again in N s” countdown (a still clock time under reduced motion), “Not reachable online: guests can't open links until you're back online” with a **How to fix** disclosure and guide link, or “Online sharing is off” with **How to turn it on**; no line on a local-only host. Each review link by its role with its review mix label, “AI assistants allowed” when it has an MCP URL, and its dates |
| **Empty / error** | A project with no mix yet turns the row that asked into “Make a mix to share” with **Refresh mix** and the message “This project has no mix yet. Refresh the mix to create the link.”; a stale preview gets the same row and a friendly alert, and after a successful render the create is retried once. A stale master explains that a new master is needed and does not offer preview refresh. If the browser refuses the copy the button reads “Press Ctrl C” with the whole link selected |
| **Out of scope** | Restricted ACL; expiry picker (links never expire until the host stops sharing; `expires_at` stays on the CLI and MCP); in-place review-role edit (rotate = new link + stop old); guest share-token MCP UI |

**Stop sharing** and **End room** confirm in place: the row swaps its actions for the consequence (“Stop sharing this Commenter link? Anyone using it loses access.” / “End this record room? Both guest and producer links will stop working.”) with **Keep link** / **Keep room** first and focused, and the danger action last. Escape keeps the link or room (the same as **Keep**), and focus returns to **More** (or **End room**). In the Invite sheet, a confirmed stop or end moves focus to that group's heading once the refreshed list removes the link or room.

**Deliver** keeps only the **Listen link** row, in the right column after the Episode file (phone: after the Episode file, before Chapters), with the same behavior as the sheet's Listen group. After Deliver confirms that a Project default export matches the current settings and episode, **Copy** is outlined as the follow-up. While the settings check is unavailable, the successful export still shows its summary and files and **Copy** keeps its usual appearance. A one-off named loudness export keeps the existing Listen link. Export stays the only filled button until a file exists, then Reveal or Download takes over. The design system drops the old ⌘⇧C chord, so Copy listen link has no key and no palette command; the row's **Copy** is the way.

In Deliver, a selected audio format that becomes unavailable stays checked and
removable in Episode file, without a size estimate. Export and Feed repair wait
until that choice is restored or removed. It cannot make an earlier export
current by silently dropping the missing format. Once compatible choices return,
Deliver checks current settings again before highlighting the Listen link.

When a participant is removed, the Record stage directs the host to **Copy
links…**. The Invite sheet marks the affected role's invite closed to new guests, disables
copying its old link, and offers a same-room, same-role replacement. Existing
leases remain valid. Guests never see the sheet (`canManageProjects` is false
on `share:{token}`).

Storybook `Stages/Frame/InviteSheet` previews the sheet with fictional links and `System/LinkRow` the row states; `Stages/Deliver/Deliver` the Listen link row in Deliver.
