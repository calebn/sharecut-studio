## Phone — Review (the old Listen)

| | |
|--|--|
| **Purpose** | Guest-style review: play the mix, scan comments, jump from badges |
| **Primary actions** | Player scrub and ±15s · type a comment and post it · open comment · tap a Stage bar badge |
| **Always visible** | App header · Review (the host reads comments in the Queue and presses **C** to comment; a guest reads the same Queue, comments only, with the field for a Commenter; on a tablet or desktop a guest's center column holds the one expanded Player first, so no Player bar there) · Player bar · the five-tab Stage bar (none for a Commenter link). A comment field with the **at 0:12** chip and a **Post** send arrow; on the host's field, with two or more tracks, a **Comment on tracks** row (**All tracks** or a pick of tracks) scopes the comment, and an **Add action item** link adds up to five short to-dos the comment carries |
| **Data shown** | Mix playhead · `review.comments[]` (time, body, resolved) · pending/stale badges |
| **Empty** | “No comments yet.” (the shared quiet empty state). With no tracks yet and no playback to finish, Play and Stop are unavailable (“Import audio to play.”). If the final track disappears during playback, Pause remains available |
| **Out of scope** | Multitrack waveform editing |

```
┌─ Project ▾   ●   ↶ ↷        ◉ +2 ┐
│ Comments                            │
│ ● 04:12  “level feels low”          │
│ ○ 11:02  “cut cold open?”           │
├─────────────────────────────────────┤
│ [Add a comment                    ] │
│ [at 12:34]                   [↑]    │
├─ ▶ 12:34   Hear original ───────────┤
├─ Record │ Prepare │ Edit │ Review │ Deliver ─┤
```

Hear original’s menu (Full mix / Without mix processing / Original) is on every stage; Review keeps its controls focused on playback and comments.
