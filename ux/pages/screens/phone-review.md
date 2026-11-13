## Phone — Review (the old Listen)

| | |
|--|--|
| **Purpose** | Guest-style review: play the mix, scan comments, jump from badges |
| **Primary actions** | Player scrub and ±15s · type a comment and post it · open comment · tap a Stage bar badge |
| **Always visible** | App header · Review (the host reads comments in the Queue and presses **C** to comment; on a tablet or desktop a guest reads the same Queue, comments only, with the field for a Commenter, and the center column holds the one expanded Player first, so no Player bar there; on a phone a Viewer or Commenter link gets the Listen layout below instead) · Player bar · the five-tab Stage bar (none for a Commenter link). A comment field with the **at 0:12** chip and a **Post** send arrow; on the host's field, with two or more tracks, a **Comment on tracks** row (**All tracks** or a pick of tracks) scopes the comment, and an **Add action item** link adds up to five short to-dos the comment carries |
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

When a host reviews an unsure transcript word in the Queue, its card shows up to four indexed words on either side from the same utterance. Suppressed words and edge-suppressed attachments stop the excerpt. The card underlines only the selected word. If word details are unavailable or the target is missing or ambiguous, the card keeps its existing text.

### Phone guest: Listen

A Viewer or Commenter link on a phone shows the app header (the role chip is an icon only), the transcript filling the middle, one 3 rem comments row, and the Listen dock. No text field is on screen until the guest taps **Comment**.

```
┌─ Project title            ◉ ☾ ⌕ ┐
│ reference  0:02                   │
│ my uncle was delighted for …      │
│ guest  0:08                       │
│ antonia pointed up to the sky …   │
├───────────────────────────────────┤
│ ▢ 15  Claude · 0:03 Cut candidate… ⌃│
├───────────────────────────────────┤
│ ▁▂▅▇▅▂▁▂▅▇▅▂▁ scrubber (44 px)    │
│ 0:05   Cold open   1:00           │
│ ☰   ↺15   ▶   ↻15   [▢ Comment]   │
└───────────────────────────────────┘
```

- **Dock.** A labelled region named Player, so a screen reader can jump to it. The scrubber is always visible, inset 1.5 rem from each screen edge so an edge-back swipe never starts a seek. The readout shows the elapsed time, the mix status as text or the chapter, and the total. The transport holds Chapters, Back 15 seconds, Play, Forward 15 seconds and the **Comment** button (a Viewer has no Comment button). Chapters is absent when the middle already is the chapter list. Below a width of 376 px the Comment button shows its icon only, so the row fits from 320 px up with room to spare; its accessible name is still "Comment at" the time.
- **Comment.** Tapping it pins the playhead time, pauses, and opens the composer above the dock with the keyboard. **Post** or **Close** resumes playback if Comment paused it, and focus returns to the Comment button. The name row appears with the composer on the first comment from this browser and is optional.
- **Comments row.** It reads "15 comments" and is named "Show 15 comments" ("Show 1 comment" for one). While a comment sits in the 15 seconds before the playhead the row shows that comment instead (author, time, one truncated line) with the count beside the comment icon. Tapping the row always opens the Comments list, scrolled to that comment and highlighting it. After a post it reads "Comment added at 1:26" for about 3 seconds; the post is announced once, by the status line. With no comments there is no row.
- **Comments sheet.** The list of comments; picking one plays it, as on a tablet or desktop, and pushes a thread step: one header row with Back ("Back to comments") left of the sheet title, then the comment and its reply field. Back scrolls the list to the row the guest came from and focuses it. A sheet closed by anything but its own Close (Comment, Chapters) reopens on the list, not on the old thread. Sheets rest exactly on the dock's top edge.
- **Middle.** The transcript when the link carries one; otherwise the chapter list, or a cover with the project name and "Press play to listen." The Chapters button opens a sheet of chapters and is absent when the middle is already the chapter list.
- **Short landscape.** At 667 x 375 the frame folds (the same fit that folds the tab bar), so the dock is one row holding the elapsed time, the scrubber, Chapters (when the chapter list is not the middle), Play and an icon-only Comment; Back 15, Forward 15 and the readout give way. An unfolded dock is three rows.
- **Keyboard.** With the soft keyboard open the frame takes the visual viewport and the dock hides, so the composer sits above the keys.
