# Using ShareCut Studio on mobile

ShareCut Studio works on your phone, not just your desktop. The mobile version isn't a shrunken-down desktop — it's designed around what you actually do on a phone.

> **Google Docs:** use **Copy Markdown** on this UX site, then paste into Docs. Keep this page as the source of truth.

## Five stages, one job each

At the bottom of the screen you'll see five tabs, one for each stage of making an episode. The player sits just above them on every stage. On a narrow phone the player keeps Play and the clock clear of the other controls; if the audio fails, Comment and the status text step aside so Retry fits.

| Stage | What it's for |
|-------|---------------|
| **Record** | Start or join a recording and see a live take. |
| **Prepare** | Add audio, see whether it is getting ready, and fix what it needs from you. The **Getting ready** summary comes first and opens like a disclosure; Sources, Help the transcriber and Cleanup follow. **Advanced** sits inside the opened Getting ready summary and is also where a running job is cancelled. The hand-off button to the next stage is secondary, with a reason, while work is running, and turns primary when everything is done. |
| **Edit** | Edit audio. A switch at the top flips between the **Timeline** (waveforms, split clips, fades and joins) and the **Script** (read the transcript; choose Correct to edit a word or ignore it, or Select to suggest a cut or ignore/restore a range). |
| **Review** | Play through, read and leave comments, and approve or reject suggested edits (the Queue, where comments are items; a guest sees Comments). This is where review links land. |
| **Deliver** | Export, bounce, and share for review. |

You won't see everything at once, and that's intentional. Each screen shows what you need for the task at hand. Timeline clip labels lead with the speaker name when one is set, then show a readable duration such as "Avery · 17m 26s"; narrow labels clip visually while their accessible names keep the full identity.

Select a clip to open its inspector sheet. The two fade sliders preview while you move and save together on release, key release, or leaving the control. Escape during a fade preview cancels it and leaves the inspector open. Idle Escape on a fade slider still dismisses the sheet. The opposite edge stays fixed, and the controls clamp to the track cap and clip length. The selected track's **Track actions** menu holds **Smooth all joins**. Pending timing keeps **Snap to silence** as a separate checked option; turn it off to apply the exact times you entered.

In Timeline, the time ruler and marker rows stay visible when you scroll through
tracks. They move with the waveforms when you pan horizontally; the playhead
starts at 0 beside the track headers and holds the center once playback passes it. The phone shows a vertical scrollbar when tracks need more room;
desktop keeps its scrollbar present so adding tracks does not shift the time view.
Pinch keeps the time under your fingers still and updates the playhead before
the new zoom appears.
Resizing or turning the screen preserves playback position and Follow. If a
tablet view has less room to pan, returning to the phone restores the prior
view until you navigate, seek, use Fit, switch projects, or end the preview.

While a take is recording or paused, an aggregate band and needle shows its
provisional timeline span even when the Record room sheet is closed. On phones,
the pan range grows with the take so you can scroll to the live needle beyond
saved media; that visual-only pan leaves playback position and saved-media seek
bounds unchanged, including while you pinch to zoom or leave Timeline and return. An explicit seek returns to
normal playback follow. Stop clears the preview, and landing shows the finalized clips.

A playback meter beneath each track's initials shows its output peak. The clip
light stays lit after playback stops. This indicator leaves the initials free
for opening track details. To reset it, tap the track's initials, then choose
**Clear clip light** in the track inspector. With reduced motion enabled, the
meter bar stays still while clip detection continues.

Joins stay visible at any zoom as a small marker at the top of the lane: `|` cut, `╲╱` fade, `✕` crossfade. When you zoom in far enough that a crossfade draws as a real overlap, its marker shrinks to a small tag so the shape reads, and past 24 px of overlap a label such as "Crossfade 120 ms" appears beside it when there is room. On a phone held upright most joins sit closer than 24 px, so they fold into a count; tap it to zoom until they separate, then tap a marker to edit its join. Applied edits stay thin, untappable ticks.

Pending edit regions fill their lane. Select one to reveal its label and review
actions above or below the lane; they stay clear of the edge controls, and a
narrow region does not make the timeline wider. In a dense set of cuts, point
to or keyboard-focus one small region to see its label without labels stacking
over each other. When the compact inspector is open, the same review actions
dock in its pinned header, with Approve and Reject visible while the inspector
body scrolls. On a tablet, the full inspector sheet pins the same actions in its
header. Elsewhere the card stays beside the selected region and follows the
timeline when the marker lane or the bottom panel changes size.
On the matching track, you can drag a cut's outer start or end edge while the
other edge stays in place. The moving edge follows nearby waveform ticks and
stays inside its source clip. Audition manually adjusted cuts before approval.

## Selecting things

In Timeline, tap a clip or track header to open its inspector in a bottom sheet. The track header is the 56px avatar rail (no name, no drag to reorder; Move up / Move down are in the track sheet).
Held sideways on a phone wide enough for it (at least 40rem, such as 667, 844 or
932 points wide), the inspector is a column on the right instead: the timeline
keeps its full height beside it, the player and tab bar step aside while it
is open, and the on-screen keyboard only shortens the column, so its title and
**Close** stay in view. Narrower screens and portrait keep the bottom sheet.
Closing the inspector returns the phone's tab bar. On a tablet, closing the
inspector keeps your Script choice.
Selecting a word in Text can open a word sheet. The comment list in Review seeks to
the comment; comment actions are on that comment's card in the Review queue.

Inspector action buttons, including **Replace audio…**, **Remove track**,
**Go to start**, and preview controls, keep at least 44 CSS px of height on
touch devices and in the phone layout, including when you use a mouse.
Transcript **Find and replace** row wraps its
controls on a coarse pointer so landscape panels stay inside the panel. At large text
or in a short window, the Transcript panel scrolls as a whole so its chrome does
not cover the rows under it.
The envelope point's Time and Level, the effect **Bypass** toggles and the comment fields and track picks are 44 CSS px tall on touch too.

The overlay toggles in the Edit stage's eye sheet (Pending edits, Markers, Comments and the rest) are whole rows at least 44 CSS px tall on touch.

An inspector stays open while the timeline remains interactive behind it. Fine pointers can drag pending-cut edges. On touch, a direct long press on a fade or trim handle may open the Auto jog
pad; envelope, pending edges, and chooser chip grabs keep the grammar drag. Auto then either opens a **jog pad** in the drawer's place (slide up while dragging to slow the move) or drags directly on the timeline with finer steps when the finger moves slowly. Done or a tap outside the pad finishes a jog; a second finger cancels. When the target is too narrow to hit reliably, choose **Edit timing** in the selected action card to focus Source start in the inspector instead. In compact mode, the peek strip's Start and End rows hold timing. The review card docks in the pinned header, and **Expand**, **Collapse**, and **Close** remain available there. When the compact inspector is open, its header keeps Undo and Redo visible at peek, half and full height, and the strip covers the tool rail so the lanes keep their room. Tapping an unavailable history button briefly shows "No undo" or "No redo" inside that button. The hint clears when that action becomes available. If the action becomes unavailable again, the hint stays clear until another tap. The full reason is announced for screen readers, and the feedback leaves the inspector content clear. Collapsing the inspector to the strip shows the top of its content again. On a phone held sideways at large text the strip fills the screen above the mode bar, with Undo, Redo, Expand and Close on one row, and the nudges are one scroll of the strip away. The Review Queue lists the pending edits that need review. Tap the ruler to seek; a blank ruler tap also clears the current selection. Confirmation sheets keep their outside-dismiss scrim, and Close or Escape dismisses either sheet type.

While the compact inspector is open, keyboard navigation skips the covered tool
row and reaches Undo and Redo in the visible header. Closing the inspector or
dragging a timeline target restores the tool row. While the inspector is
stowed, its hidden controls are skipped too.

On a short screen with enlarged text, scroll the expanded inspector to reach
its fields. The compact header keeps its close spacing at every height, and
Tab reveals the field and its label below the pinned actions when they fit.

The selection sheet groups actions in this order:

1. **Details** — the inspector for what you selected
2. **You might also want…** — related commands when available
3. **More actions** — available clip Cut or track Move up/down actions. Selections with no related or overflow actions omit the command region.

The phone and the tablet build this sheet from one table of selection kinds, so what you can do with a selection is the same on both. While a sheet is open, no range control sits behind it. On a tablet, a clip sheet with an agent session range includes its In/Out fields, selected-track checkboxes and explicit **Use agent range on selected tracks** action; opening the sheet does not adopt the agent range.

An iPad held sideways, 1180 or 1194 points wide (Air or Pro 11″), keeps the tablet shell, so **Select range** stays in the Edit corner and + Track and Import stay in the **+** menu. There is no Select or Blade tool: Split is Mod+K, or Alt-click with a mouse; touch has no Alt, and its Split verb arrives with the action bar.

Ordinary phone and tablet modifier sheets, and the Select range sheet while it
is armed, scroll together, including the heading, actions, fields, help, errors,
and audition controls. **Cancel range selection** stays in that same sheet
scroll, not in a nested inner scroller. Scroll to the top to reach **Close**,
**Expand**, and **Collapse**. Use **Expand** for more room on a short screen.
These sheets use a taller half height and have no drag handle.

The compact inspector keeps its header and actions pinned outside one bounded
body scroller. Feedback and fields scroll together below that header. Its half
height leaves room for the timeline, with a minimum height for its controls on
short screens. Drag its header or use the **Expand** and **Collapse** icon buttons to resize it.
A short sheet, such as the Tools sheet on a phone held sideways at large text, keeps
enough half height for a scrollable body. On the Prepare stage, resizing the window
keeps the focused control in view.

To adjust a track's volume envelope, open track details and choose **Show
volume envelope**. Long-press the lane to add a point with **Add volume
point**, or select an existing point, then choose **Inspect**. The sheet shows
the point's **Time** and **Level**; each change saves at once and Undo takes it
back. **Remove point** deletes it. A failed save stays in the sheet with
**Reload points** when the envelope changed under you.

Desktop and tablet editor panels use a resize separator. Escape cancels its
current preview and restores the previous panel preference, including the
default when none was saved. These
view changes do not add project History.

Escape also cancels an active clip body or chapter/social marker preview.
Canceled pointer ownership cannot save on later held movement or release.
Completed edits retain their existing command and Undo behavior.

Use Close or Escape to dismiss an inspector sheet. Closing the inspector
clears that clip selection. While the sheet is open, Escape does not also
run the timeline's clear-selection shortcut. If a join popover is open,
Escape closes that popover first, even if the inspector sheet remounts
behind it. A compact-to-regular inspector remount keeps a waiver reason
field focused.

Tap outside a confirmation sheet to dismiss it. Hear original sits in the player on every stage; press and hold it to choose Full mix, Without mix processing or Original. Export, Bounce and Share are in Deliver, and project actions such as All projects, Settings and Connect agent are in the Project menu (the project title at the top). Timeline selection, track order, waveform and zoom controls stay in the Edit stage. Phone menu rows are at least 44 CSS px tall and hide keyboard hints.

## Gestures

| Gesture | What it does |
|---------|--------------|
| **Two-finger tap** | Optional ShareCut shortcut for Undo |
| **Pinch** | Zoom the timeline in/out |
| **Long-press** | Open the selection sheet for a comment or track, or correct a transcript word (hosts). In Select mode, hold a word and drag across more to select a range; Range actions also add or drop a word at either end. On the timeline, a long press arms a target so it can be dragged (on a clip's body, the clip, which then slides in time), or on empty space opens a menu to split here, add a comment or a chapter, (host) record here, add a volume point on a lane, or paste |
| **Double-tap word** | Open word correction (hosts) in the sheet; the transcript hint says so on touch; closing it returns to your previous mode (touch keeps the sheet rather than desktop's inline editor so the keyboard has room) |

A full list is in the app: **Commands and shortcuts → Gestures** (tap the search button in the header).

## Following someone

If you're collaborating, you can follow another person's view. On mobile, the
app follows their mode, selection, and playback where those are available.

Your phone does not show their mouse cursor.

To stop following, scrub the timeline or tap **Stop following** in the banner.

## What's different from desktop?

A few things live in different places on mobile:

- **Comments** are in Review, and the player has a comment button at the playhead
- **History** is a sheet in Edit; the **Queue** and Comments are in Review, and the pipeline steps are in Prepare
- **Gestures** has a reference list behind the search button (Commands and shortcuts)
- **Mute/Solo and Volume** for a track: tap its header row on the left side of Timeline
- **Solo on · Clear solo** sits above every tab while a track is soloed, so you can see why other voices are silent and turn solo off in one tap
- **Audition and export**: Hear original is in the player (press and hold for the other choices); export is in Deliver
- **Safari page zoom** wraps Play, time, and Comment onto another row instead of covering History
- **Undo and Redo** are the two arrow buttons in the header at the top. When there's nothing to undo or redo, the button is dimmed, and tapping it says why. That feedback ends after 3.5 seconds, when the action becomes available, or when the history controls disappear. Tap again if they return unavailable.

The phone layout groups controls by task so they fit a smaller screen.

## Tips

- **Review** is the fastest way to review. Play through and read comments in the Queue.
- **Script** with "Follow" on will highlight words as the audio plays — great for catching transcript errors.
- **Undo and Redo** sit in the header. + Track and Import are under the **+** below the last track header. A **two-finger tap** also undoes your last action, and History is a sheet in Edit (right-click Undo).

On a short landscape tablet, press **T** or use the Script button to hide the Script and leave room for the tracks.

### Full screen on iPhone

Safari's address bar and toolbar take a lot of room, especially with the phone held sideways, and Safari doesn't let a web page hide them. To get the room back, **add ShareCut to your Home Screen**: in Safari's Share menu, choose **Add to Home Screen**. Opened from its icon, ShareCut runs full screen with no browser bars. The first time you open ShareCut in Safari, a banner at the top says so; **Dismiss** hides it on that phone for good, and More keeps the tip.

Held sideways, tracks get shorter so at least three fit on screen, and the controls keep their full-size touch targets. The empty marker band under the ruler steps aside until there are markers to show. The layout also stays clear of the camera cutout and the home indicator. On a short screen the app header and a bottom sheet's header each fit on one row: the sheet's title shortens with an ellipsis, and Undo, Redo, Expand and Close stay at full touch size. A sheet has no half height when that height could not hold its header and one row of content, so it opens at full height instead. When the Script, view and zoom controls would cover a track, they move into the **Tools** button in the header, so the tracks stay clear and their Mute and Solo buttons stay reachable.

Editing a volume envelope point with the phone held sideways keeps the track you are editing on screen beside the card, along with the ruler. On the shortest screens (about 914×331, or an iPhone SE held sideways) the chapter, comment and clip rows scroll with the tracks at all times, so a tap on a track's name always reaches it. **Time**, **Level** and **Remove point** stay in view in the card. Turning the phone with a point open keeps it open. On a short window, dragging the divider above the tabs can make the tabs smaller as well as larger.

### Mix tracks

The Mix button on the Edit stage shows all tracks without opening each inspector. M and Volume save
for hosts and editors; S affects your listening only. Other guests can use local
M and S, while Volume shows its permission reason. Shared playback uses Full
mix, so these local controls may not be audible in that preview. Close and
Escape return focus to the Mix control. Dismissing the sheet from its
scrim does the same. Close starts with focus when Mix opens. Switching stages or
inspecting something else closes Mix; coming back does not reopen it.
The timeline gutter keeps its identity-only layout. Swipe-to-mix is deferred.

## Compact feedback

The inspector header keeps Undo, Redo, resize and Close visible while its body
scrolls. Feedback and fields share that one scroll order. At large text sizes,
a full native label and a long message may need separate views. Field focus
reveals the field and its complete label below the pinned header when the label
fits. Half and full detents keep the same outer height with or without the
feedback card; Dismiss removes the card without changing detent height or lane
room. Ordinary body scrolling exposes the message and its Dismiss or guarded
Undo action. Clipped feedback pauses its remaining visible lifetime. A saved
edit preserves the focused or just-pressed control, and Close or a timeline drag
returns the same card to its floating host.
Focused Undo and Dismiss stay focused when rotating between phone and tablet
layouts. Closing a focused feedback action returns focus to the current usable
inspector Close. Navigating to another selection or project ends that focus
intent; a selection the agent makes or one you follow does not (no other client's selection reaches your phone). If a peer's edit removes the
focused Undo, focus goes to the sheet Close. An open modal keeps its own focus.

## Floating feedback

Outside the compact inspector, feedback floats above the bottom chrome when
there is room. Its position accounts for the card's width, so a comment composer
beside the card does not push it upward. Visible comment and guest-name fields
that overlap the card horizontally take priority when a clear position fits.
On phones, the card also moves clear of Play when space allows.

A very short window can leave no clear position. At a tested 320×300 viewport,
the 62 px failure card cannot fit in the 53 px gap between Play and the comment
composer, and the fallback can cover a control. Choose **Dismiss** or enlarge
the window before using the covered control. The
[feedback placement contract](https://github.com/calebn/sharecut-studio/blob/main/docs/gui-mobile.md#feedback-toast)
describes the measured limits. These viewport checks do not establish native
keyboard or Safari behavior.

## Move clips without dragging

Select a clip and choose **Move clip** beside Timeline in its inspector. Choose
**Target track** and use **Earlier 10 ms**, **Later 10 ms**, or **Use playhead**.
For an exact destination, enter **Timeline start (seconds)**. Review the timeline
preview, then choose **Apply move** or **Cancel**. A selected group moves together,
with each clip clamped at zero and the outer tracks. Exact input does not snap.
Apply uses one existing move History action. Cancel and unchanged Apply save
nothing. A refused save keeps a current draft and an error so you can retry.
The **Moved clips** feedback offers **Undo** for the saved move, including the
whole selected group. A move waiting to send offers no Undo.

The panel size buttons sit beside the editor tabs. The tabs scroll horizontally
when the controls and labels need more room.

On desktop and tablet, **Shorter** and **Taller** change the bottom editor panels
by a 1 rem request, subject to the current available bounds. Steps start at the
visible height, including when a saved size exceeds the space available, so the
first step can clamp by more than 1 rem. Banners and root-text changes refresh
the bounds without rewriting that preference. **Reset panel size** clears
the browser preference. These controls do
not change the episode or History. Phone uses the sheet's **Expand** and
**Collapse** controls and has no Script divider.
