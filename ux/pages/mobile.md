# Using Sharecut Studio on mobile

Sharecut Studio works on your phone, not just your desktop. The mobile version isn't a shrunken-down desktop — it's designed around what you actually do on a phone.

> **Google Docs:** use **Copy Markdown** on this UX site, then paste into Docs. Keep this page as the source of truth.

## Four modes, one job each

At the bottom of the screen you'll see four tabs. Each one is designed for a specific task:

| Mode | What it's for |
|------|---------------|
| **Listen** | Review the episode. Play, scrub through, read and leave comments. |
| **Timeline** | Edit audio. See the waveforms, split clips, and adjust fades and joins. |
| **Text** | Read the transcript. Choose Correct to edit a word or ignore it, or Select to suggest a cut or ignore/restore a range. |
| **More** | Comments, history, impact, tighten suggestions, pipeline, and Gestures. |

You won't see everything at once, and that's intentional. Each screen shows what you need for the task at hand. Timeline clip labels lead with the speaker name when one is set, then show a readable duration such as "Avery · 17m 26s"; narrow labels clip visually while their accessible names keep the full identity.

Select a clip to open its inspector sheet. The two fade sliders preview while you move and save together on release, key release, or leaving the control. The opposite edge stays fixed, and the controls clamp to the track cap and clip length. The selected track's **Track actions** menu holds **Smooth all joins**. Pending timing keeps **Snap to silence** as a separate checked option; turn it off to apply the exact times you entered.

In Timeline, the time ruler and marker rows stay visible when you scroll through
tracks. They move with the waveforms when you pan horizontally; the playhead
stays centered. The phone shows a vertical scrollbar when tracks need more room;
desktop keeps its scrollbar present so adding tracks does not shift the time view.

While a take is recording or paused, an aggregate band and needle shows its
provisional timeline span even when the Record room sheet is closed. On phones,
the pan range grows with the take so you can scroll to the live needle beyond
saved media; that visual-only pan leaves playback position and saved-media seek
bounds unchanged. Stop clears the preview, and landing shows the finalized clips.

A playback meter beneath each track's initials shows its output peak. The clip
light stays lit after playback stops. This indicator leaves the initials free
for opening track details. To reset it, tap the track's initials, then choose
**Clear clip light** in the track inspector. With reduced motion enabled, the
meter bar stays still while clip detection continues.

Pending edit regions fill their lane. Select one to reveal its label and review
actions above or below the lane; they stay clear of the edge controls, and a
narrow region does not make the timeline wider. In a dense set of cuts, point
to or keyboard-focus one small region to see its label without labels stacking
over each other. When the compact inspector is open, the same review actions
dock in its pinned header, with Approve and Reject visible while the inspector
body scrolls. Outside compact mode, the card stays beside the selected region.
On the matching track, you can drag a cut's outer start or end edge while the
other edge stays in place. The moving edge follows nearby waveform ticks and
stays inside its source clip. Audition manually adjusted cuts before approval.

## Selecting things

In Timeline, tap a clip or track header to open its inspector in a bottom sheet.
Selecting a word in Text can open a word sheet. The Listen comment list seeks to
the comment; use **More → Comments** for comment actions.

An inspector stays open while the timeline remains interactive behind it. Fine pointers can drag pending-cut edges. On touch, selected cuts show 44px edge targets only when the drawn region is at least 44px wide and the lane fits both targets; otherwise choose **Edit timing** in the selected action card to focus Source start in the inspector. In compact mode, the peek strip's Start and End rows hold timing. The review card docks in the pinned header, and **Expand**, **Collapse**, and **Close** remain available there. The strip stands above the tool rail, so Undo and Redo stay visible and tappable while it is open. The Impact panel lists every pending edit for selection. Tap the ruler to seek; a blank ruler tap also clears the current selection. Confirmation sheets keep their outside-dismiss scrim, and Close or Escape dismisses either sheet type.

The selection sheet groups actions in this order:

1. **Details** — the inspector for what you selected
2. **You might also want…** — related commands when available
3. **More** — available clip Cut or track Move up/down actions. Selections with no related or overflow actions omit the command region.

Phone and tablet inspector sheets scroll together, including the heading,
actions, fields, help, errors, and audition controls. Scroll to the top to reach
**Close**, **Expand**, and **Collapse**. Use **Expand** for more room on a short
screen. The sheet has no drag handle.

To adjust a track's volume envelope, open track details and choose **Add volume
envelope** or **Edit volume envelope**. Choose **Add point** or select a point
and choose **Edit point**, enter Time and Level, then choose **Save point**.
**Cancel** keeps the saved points. After Save or Cancel, the selected point is
visible again; **Done** returns to the track's envelope action. Scrolling and
changing sheet size keep the current draft.

Desktop and tablet editor panels use a resize separator. Escape cancels its
current preview and restores the previous panel preference, including the
default when none was saved. These
view changes do not add project History.

Escape also cancels an active clip body or chapter/social marker preview.
Canceled pointer ownership cannot save on later held movement or release.
Completed edits retain their existing command and Undo behavior.

Use Close or Escape to dismiss an inspector sheet. Tap outside a confirmation
sheet to dismiss it. Audition modes and export controls are in the compact
transport Menu on Timeline, Text, or More.

## Gestures

| Gesture | What it does |
|---------|--------------|
| **Two-finger tap** | Optional Sharecut shortcut for Undo |
| **Pinch** | Zoom the timeline in/out |
| **Long-press** | Open the selection sheet for a comment or track, or correct a transcript word (hosts). On the timeline, a long press arms a target so it can be dragged (on a clip's body, the clip, which then slides in time), or on empty space opens a menu to add an envelope point, a blade cut, a chapter or a comment |
| **Swipe left on comment** | Resolve an open comment in the list (hosts). The card slides with your finger; **Undo** appears for a few seconds afterwards (for the most recent one only). The toast stays reachable as the Comments list scrolls. Closing it with keyboard focus inside returns focus to Comments without scrolling |
| **Double-tap word** | Open word correction (hosts) in the sheet; the transcript hint says so on touch; closing it returns to your previous mode (touch keeps the sheet rather than desktop's inline editor so the keyboard has room) |

A full list is in the app: **More → Gestures**.

## Following someone

If you're collaborating, you can follow another person's view. On mobile, the
app follows their mode, selection, and playback where those are available.

Your phone does not show their mouse cursor.

To stop following, scrub the timeline or tap **Stop following** in the banner.

## What's different from desktop?

A few things live in different places on mobile:

- **Comments** are in the Listen tab and under More
- **History, Tighten, and Pipeline** are all under More
- **Gestures** has a reference list under More
- **Mute/Solo and Volume** for a track: tap its header row on the left side of Timeline
- **Solo on · Clear solo** sits above every tab while a track is soloed, so you can see why other voices are silent and turn solo off in one tap
- **Audition and export** are in the compact transport Menu outside Listen
- **Undo and Redo** are the two arrow buttons at the right end of the tool row above the Timeline tabs. When there's nothing to undo or redo, the button is dimmed, and tapping it says why

The phone layout groups controls by task so they fit a smaller screen.

## Tips

- **Listen mode** is the fastest way to review. Play through and open **More → Comments** to use the comment tools.
- **Text mode** with "Follow" on will highlight words as the audio plays — great for catching transcript errors.
- **Undo and Redo** sit at the right end of the Timeline tool row. On a phone held upright, + Track and Import are in the Menu (under Media) and More instead, to keep that row to one line. A **two-finger tap** also undoes your last action, and History is under More.

### Full screen on iPhone

Safari's address bar and toolbar take a lot of room, especially with the phone held sideways, and Safari doesn't let a web page hide them. To get the room back, **add Sharecut to your Home Screen**: in Safari's Share menu, choose **Add to Home Screen**. Opened from its icon, Sharecut runs full screen with no browser bars. The first time you open Sharecut in Safari, a banner at the top says so; **Dismiss** hides it on that phone for good, and More keeps the tip.

Held sideways, tracks get shorter so at least three fit on screen, and the controls keep their full-size touch targets. The empty marker band under the ruler steps aside until there are markers to show. The layout also stays clear of the camera cutout and the home indicator.

### Mix tracks from More

More → Mix shows all tracks without opening each inspector. M and Volume save
for hosts and editors; S affects your listening only. Other guests can use local
M and S, while Volume shows its permission reason. Shared playback uses Full
mix, so these local controls may not be audible in that preview. Close and
Escape return focus to the Mix control in More. Dismissing the sheet from its
scrim does the same. Close starts with focus when Mix opens. Switching modes or
inspecting something else closes Mix; returning to More does not reopen it.
The timeline gutter keeps its identity-only layout. Swipe-to-mix is deferred.
