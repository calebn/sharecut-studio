## Phone — Edit: Script

| | |
|--|--|
| **Purpose** | Read/fix transcript; seek by word; suggest cut-away |
| **Primary actions** | Follow playhead · double-click word or focus word + F2 → inline fix (one at a time; a pending save finishes first and the mode hint says it is saving; a late failure shows under the hint with Dismiss and, whichever stage is open, once as an error toast; automatic layout changes keep the open field and its typing without saving; a fix says "Text fixed" with Undo) · tap word → sheet · suppress / correct / ignore (Ignore strikes through and mutes at render, no cut; Restore brings it back — always visible under touch, no hover needed) · Script unsure chip → next low-confidence word (wraps) · Alt+Down / Alt+Up on a word → next / previous unsure word · a selection across tracks is drawn from its first to its last word; click a cut seam → its join, click a suggestion → its pending edit; other people's carets show before their word |
| **Data shown** | Speaker labels · `transcripts` words (text, confidence, suppressed, ignored, suspect_hallucination) · selection range |
| **Empty / loading** | No transcript yet · low-confidence chips when present |
| **Out of scope** | The Review queue and Prepare (their own stages) |

An applied cut seam shares the Timeline selection and highlight. Tapping it again closes the join and keeps the applied selection.

From Review, **Open in Edit** opens Script and reveals the exact unsure word,
even when it is far away or its text repeats. The word is selected without
turning Follow playhead on. This jump takes precedence over the saved reading
position. Returning later without another jump does not repeat that navigation.
For a blocked proposal whose Fix word is gone, **Open in Edit** opens the
pending edit. Resolved comments have no such link on the phone Review card.

Words whose audio is fully cut leave the active Unsure words queue and Script
count. Neighboring words with audio remain reviewable. Undo restores a cut word
to both lists if it is still unsure.

Follow playhead keeps overlapping speakers highlighted in transcript order.
Backward seeks update the active words through the same time-indexed lookup.

Annotate boundary handles keep a fixed size during a roll or trim. A floating
preview shows the time change, restored-word side, and legal limits. The glyph
follows the pointer; hold Shift for fine motion of 1 ms per CSS pixel without
jumping when Shift changes. Escape or an interrupted gesture discards the
preview. Saving blocks another drag on that handle; a failed save displays an
error. Tap or use Enter/Space to open the host precision dialog for a signed
offset, 10 ms or 1 ms nudges, and separate current/proposed affected-track audio.
It distinguishes fully restored words from partial spans, keeps an unchanged or
cancelled draft out of history, and reports an offline Apply as queued. A load
that gets no answer says "The server didn't answer. Try again.", saves
nothing, and offers **Try again** to load the controls in place. Network load
failures also offer **Try again**. Retry and **Reload boundary** keep focus in
the dialog, on progress and then the boundary control. New ripple cuts retain the removed source words for boundary previews. Expanding far
enough to restore a complete word brings its text and suppression choices back
with the audio. Partial words remain archived. Existing older cuts without a
word archive require History recovery.

When neighboring clips have a gap above the existing 50 ms abutment tolerance,
the mark explains that this pair has no roll seam and identifies the left
clip's end trim. The host precision dialog repeats that reason before its
controls. Gaps within the tolerance and overlaps continue to roll.

Dragging either edge of a cut's pill rolls its seam at 12.5 ms a pixel; hold Alt for 1 ms a pixel (Shift does nothing here). A drag is refused while another seam save is running, and a roll that cannot save says why in the status line. The seam sheet's Offset field is the exact alternative.

Timeline and transcript join rolls use the same recording limits. Rolling later
stops at the left recording's end; an unknown duration allows no later expansion.
Outer neighbors constrain the drag only when they play the right recording, so
an unrelated take does not shorten the preview. Releasing saves the previewed
offset after a fresh check that the join still matches.

Keyboard word actions: Enter on a focused timed word seeks through its native
button action. F2 opens inline correction for a hydrated host project and does
nothing on guest shares or while a correction is saving. Enter in the inline
editor saves and returns focus to the word while the field still owns focus.
Tab saves a change and moves focus and selection to the next unsure word.
Unchanged Tab keeps the existing close-to-current-word behavior. Escape cancels
and returns focus while the field still owns focus. A blur saves the correction
and leaves focus on the destination the user chose.

```
┌─ header      Follow · Edit ────────┐
│ HOST                                 │
│ so we ┌were┐ talking about …         │
│ GUEST                                │
│ yeah and the ┌launch┐ …              │
├─ ▶ 12:34   Hear original ────────────┤
├─ Record │ Prepare │ Edit │ Review │ Deliver ─┤
```

Review keeps an open Fix draft while word detail reloads for the same recorded
word. If another word takes its place, Review closes the old draft. Save, Looks
right, and a word card's Open in Edit wait until the words are ready. A proposal
can still open in Edit. A failed load offers Try again. While words are loading
or could not load, Review leaves word-dependent totals and completion unknown;
known suggestions and comments remain countable, and Deliver stays secondary.
Deliver keeps Check available during this wait and does not report zero unsure
words until transcript detail establishes that count. Export remains available
under its existing requirements.
