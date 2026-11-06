## Host: Invite sheet (every stage) and the Deliver Listen link

| | |
|--|--|
| **Purpose** | Manage public review links and record-room guest / producer invites for the open episode |
| **Open** | Header **Invite**, Project → Share… and the Record stage's Invite all go to Deliver's Share section (`share.manage`; collaboration extension slot `share.ui.menu`) |
| **Primary actions** | Role radios under **Anyone with the link** (Viewer / Commenter / Editor, each with a one-line description; default Commenter) · **Allow AI assistants (MCP)** with its consequence note (“Paste into an MCP client such as Claude or ChatGPT. The assistant gets this link's permissions.”) · **Create review link** (pinned footer) · **Create record links** · per review link **Copy link**, **Copy MCP URL** and **Stop sharing** · Copy guest / producer links · Replace a closed record invite · per room **Open Record stage** and **End room** |
| **Data shown** | Online sharing line at the top (when the `tunnel.status` feature is present): “Guests can open your links”, “Connecting…”, “Reconnecting… guests may see a brief interruption” with a “Trying again in N s” countdown (a still clock time under reduced motion), “Not reachable online: guests can't open links until you're back online” with a **How to fix** disclosure and guide link, or “Online sharing is off” with **How to turn it on**; no line on a local-only host; each review link named by its role (“Commenter link”) with its review mix label, “AI assistants allowed” when it has an MCP URL, when it was created and last opened, a host-chosen expiry only if one was set on the CLI or MCP, and its coolname as the address; each record room with its guest and producer links and invite closure state |
| **Empty / error** | Quiet “No review links yet.” / “No record rooms yet.” text (no field-like box), with **Create record links** under the rooms. Create publishes a **Share mix** review version if none exists (needs premix/mastered). A project with no mix yet says “This project has no mix yet. Refresh the mix to create the link.” and a stale preview gets a friendly alert; both show **Refresh mix**, and after a successful render, Create retries once. A stale master explains that a new master is needed and does not offer preview refresh. |
| **Out of scope** | Restricted ACL; expiry picker (links never expire until the host stops sharing; `expires_at` stays on the CLI and MCP); in-place review-role edit (rotate = new link + stop old); guest share-token MCP UI |

**Stop sharing** and **End room** confirm in place: the row swaps its actions for the consequence (“Stop sharing this Commenter link? Anyone using it loses access.” / “End this record room? Both guest and producer links will stop working.”) with **Keep link** / **Keep room** first and focused, and the danger action last. Escape keeps the link or room (the same as **Keep**), and focus returns to **More** (or **End room**).

**Deliver** keeps only the **Listen link** row, in the right column after the Episode file (phone: after the Episode file, before Chapters), with the same behavior as the sheet's Listen group. After an export finishes its **Copy** button is outlined as the follow-up; Export stays the only filled button. The palette command **Copy listen link** (`share.copyListenLink`) copies it from any stage; the design system drops the old ⌘⇧C chord, so it has no key.

When a participant is removed, the Record stage directs the host to **Copy
links…**. The Invite sheet marks the affected role's invite closed to new guests, disables
copying its old link, and offers a same-room, same-role replacement. Existing
leases remain valid. Guests never see the sheet (`canManageProjects` is false
on `share:{token}`).

Storybook `Stages/Deliver/Share` previews the props-only `ShareSection` with fictional links. The section holds:
the role, MCP and Freeze choices, **Create review link**, the live links with
**Copy**, **Copy MCP URL** and **Stop sharing** (confirmed in place), the online
sharing line, and record rooms. The link is made and copied from the click on
Create; if the browser refuses the copy, the row reads “Press Ctrl C” with the
whole link selected.
