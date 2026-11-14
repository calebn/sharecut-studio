## Phone — Review (the old Listen)

| | |
|--|--|
| **Purpose** | Guest-style review: play the mix, scan comments, jump from badges |
| **Primary actions** | Player scrub and ±15s · type a comment and post it (a phone Commenter link starts with the dock's Comment button) · open comment · tap a Stage bar badge |
| **Always visible** | App header · Review (the host reads comments in the Queue and presses **C** to comment; on a tablet or desktop a Viewer or Commenter guest reads the same Queue, comments only (a Commenter's also lists its own suggestions), with the field for a Commenter, an Editor's Queue also holds the suggested cuts, with the field, and the center column holds the one expanded Player first, so no Player bar there unless the window is very short; on a phone a Viewer or Commenter link gets the Listen layout below instead) · the Player (the bar; the card for a tablet or desktop guest; the Listen dock for a phone Viewer or Commenter link) · the Stage bar (five tabs for the host, three for an Editor link, none for a Viewer or Commenter link). A comment field with the **at 0:12** chip and a **Post** send arrow, always present for a Commenter or Editor guest on a tablet or desktop and for an Editor on a phone (docked at the foot, inline in the card on a short window), opened with C or a Comment button for the host and from the dock for a phone Commenter; on the host's field, with two or more tracks, a **Comment on tracks** row (**All tracks** or a pick of tracks) scopes the comment, and an **Add action item** link adds up to five short to-dos the comment carries |
| **Data shown** | Mix playhead · `review.comments[]` (time, body, resolved) · pending/stale badges |
| **Empty** | “No comments yet.” (the shared quiet empty state of the queue; a phone Viewer or Commenter link with nothing to show has no row at all). With no tracks yet and no playback to finish, Play and Stop are unavailable (“Import audio to play.”). If the final track disappears during playback, Pause remains available |
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

A Viewer or Commenter link on a phone shows the app header (the role chip is an icon only), the transcript (or, when the link has none, the chapter list or a cover) filling the middle, one 3 rem comments row (only while the link holds comments, suggestions or something needing attention), and the Listen dock. On a Commenter link no text field is on screen until the guest taps **Comment**; a Viewer link never has one.

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

- **Dock.** A labelled region named Player, so a screen reader can jump to it. The scrubber is always visible, inset 1.5 rem from each screen edge so an edge-back swipe never starts a seek. The readout shows the elapsed time, the mix status as text or the chapter, and the total. The transport holds Chapters, Back 15 seconds, Play, Forward 15 seconds and the **Comment** button (a Viewer has no Comment button). Chapters is absent when the link has no chapters or the middle already is the chapter list. At and below a container width of 376 px (23.5 rem) the Comment button shows its icon only, so the row fits from 320 px up with room to spare; its accessible name is still "Comment at" the time.
- **Comment.** Tapping it pins the playhead time (text kept by Close keeps its time), pauses an episode that is playing, and opens the composer above the dock with the keyboard. **Post** or **Close** plays on again if Comment paused it and nothing touched the transport since, and focus returns to the Comment button. The name row appears with the composer on the first comment from this browser and is optional.
- **Comments row.** It reads "15 comments" (with " · 2 suggestions" and " · Needs attention" after it when those exist) and is named "Show 15 comments" ("Show 1 comment" for one); while it shows a comment or the "Comment added" line, its name is "Show 15 comments" followed by that text, so the name always holds what is on screen. While a comment sits in the 15 seconds before the playhead the row shows that comment instead (author, time, one truncated line) with the count beside the comment icon. Tapping the row opens the Comments list: scrolled to the comment being heard and highlighting it when there is one, otherwise on the comment last selected, or at the top. After a post it reads "Comment added at 1:26" for about 3 seconds; the post is announced once, by the status line. With no comments, no suggestions and nothing needing attention there is no row.
- **Comments sheet.** The list of comments; picking one plays it, as on a tablet or desktop, and pushes a thread step: one header row with Back ("Back to comments") left of the sheet title, then the comment and, on a Commenter link, its reply field. Back scrolls the list to the row the guest came from and focuses it. A sheet closed by anything but its own Close (Comment, Chapters) reopens on the list, not on the old thread. Sheets rest exactly on the dock's top edge.
- **Middle.** The transcript when the link carries one; otherwise the chapter list, or a cover with the project name and "Press play to listen." The Chapters button opens a sheet of chapters and is absent when the link has no chapters or the middle is already the chapter list.
- **Short landscape.** At 667 x 375 the frame folds (the same fit that folds the tab bar), so the dock is one row holding the elapsed time, the scrubber, Chapters (when the link has chapters and the list is not the middle), Play and, on a Commenter link, an icon-only Comment; Back 15, Forward 15, the total and the chapter name give way, and a mix status shows as a warning button that says why. An unfolded dock is three rows.
- **Keyboard.** With the soft keyboard open the frame takes the visual viewport and the dock hides, so the composer sits above the keys.
