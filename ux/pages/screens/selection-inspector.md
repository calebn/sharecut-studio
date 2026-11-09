## Shared: Selection → Inspector / Bottom sheet

| | |
|--|--|
| **Purpose** | Modifier for whatever is selected (pending cut, clip fade, track FX, word, …) |
| **Primary actions** | Cut / Keep (Approve / Reject for a split, exact range or no accept action) / Restore · Hear before / Hear after (footer Play around where there is no Action bar) · param edits · Close |
| **Data shown** | Type badge · label · agent reason · source + timeline ranges · shape-specific params |
| **Phone** | Ordinary modifier sheets use half or full height. Heading, actions, fields, errors, and audition footer scroll together. Scroll to the top for Close, Expand, and Collapse. Ordinary modifiers use a taller half height. The compact inspector uses peek, half, and full heights with its header pinned outside one bounded body scroller. Feedback and fields scroll in that body. A clip's trim and fade fields, a suggestion's Source start and end, and an envelope point's Time and Level each carry the strip's fine and coarse minus and plus nudge buttons (hold to repeat) beside the field. Sheets never stack. |
| **Tablet** | The Inspector card anchors to the floating Action bar in the Edit workspace, with the selected element or workspace bottom edge as fallback. Its heading stays fixed while its body scrolls. |
| **Desktop** | The Inspector card anchors to the floating Action bar in the Edit workspace, with the selected element or workspace bottom edge as fallback. Its heading stays fixed while its body scrolls. |
| **Empty** | “Select a clip, edit, or word” |
| **Out of scope** | Deep nested wizards; one panel per MCP tool name |

A fade gesture based on values changed by Undo or another editor saves nothing.
The current project shows "This clip changed. Nothing was saved. Adjust the fade
again." Repeat the gesture against the restored values. The inspector shows the
error inline; timeline handles and phone nudges show the same recovery in a toast.

A selected word and an applied edit (a cut) open in the Inspector sheet. The word shows its confidence, Suppressed and Ignored state, the Text and End index fix, Suppress, Ignore and Return to automatic, and its timing; the cut shows its facts with Restore or Open History. A share link sees neither the word fix nor its actions.

On a phone, the Inspector uses Full height when the available room is too short for its dock and fields, then returns to Half when room returns. A manual height change stays selected as the phone size changes.

A selected chapter or social clip opens in the same sheet. A chapter shows **Title** (saved when you leave the field or press Enter; an empty title is refused) and **Time** (drag, arrow keys or type a number; each change saves once), and a seek button; a chapter is removed with Remove on the Action bar. A social clip shows its title, track, **Start** and **End** (each saves once; an end that is not after the start is refused), score, approved and review state, **Seek to start** and **Delete**. There is no Apply button. A share link, including an edit share, sees the values read-only and no Delete on a social clip. A failed save stays in the sheet as an alert.

A selected automatic reduction (from the clip's Inspect automatic audio reduction button or its Timeline overlay) opens in the same sheet: the plan, rendered-audio and saved-choice facts, the regions in the clip, **Restore original audio**, **Refresh regions** and **Undo Restore**. A share link reads that the project host alone can inspect and restore it.

A selected comment with no pending edit behind it opens the same sheet: a Time button that seeks, the author, status and tracks, the comment text, action items, replies, a **Reply** field and **Resolve** (or **Reopen**). A share link without reply permission has no Reply field, and a share link never sees Resolve.

A selected suggestion (a pending edit), or a comment on one that is still pending, opens in the same sheet with a kind line and a Why row, Start and End Scrub fields that save as you commit each one, a **Snap to silence** row, suggested bounds, the Ask thread (posting the first Ask moves focus to the empty reply field) and, on a sheet with no Action bar, the Current, Suggested and A/B listen controls (otherwise Hear before and Hear after are on the bar, Seek to start under More). **Cut** and **Keep** are on the Action bar when the suggestion has an accept action, and the sheet then drops its own buttons; for a suggestion with no accept action, a split, an exact range proposal, a comment on a pending edit and a phone sheet with no bar dock (the compact drawer, the full sheet at a tight height), **Approve** and **Reject** stay in the sheet. The phone peek strip's body shows no verbs; the review card docks into its chrome with Cut and Keep (Approve and Reject for the cases above).
