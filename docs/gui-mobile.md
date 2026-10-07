# Sharecut Studio mobile & responsive UX

> **Non-technical overview:** [ux/pages/mobile.md](../ux/pages/mobile.md) — what mobile does and why, for partners and users.

Phone- and tablet-first shells for Sharecut Studio, plus desktop polish shared with those patterns. Desktop keeps the Reaper-style grid; phone does **not** shrink that grid.

Canonical strategy and feature map for agents/contributors. Implementation lives under `gui/web/`.

Reading-room actions and Share dialog actions/checkbox labels use the shared
`--touch-min` target floor. On phones the Share dialog is a modal bottom sheet
(`Dialog` `phoneSheet`): it rises full width from the bottom edge, and its
footer pins **Create review link**, the just-created link's **Copy link** and
the status line in the thumb zone while the body scrolls. Stop sharing and
End room confirm in place (`ui/InlineConfirm`) rather than stacking a second
sheet. Dialog and sheet close buttons use the same square
target. Reading form labels, hints, and errors use `--font-size-body`, while
actions use reading-body type. Compact timeline/inspector controls retain their
editor density. See the [component recipes](../gui/web/docs/ui-library.md#composition-recipes)
and [consistency audit](design-system-audit.md) for checked examples and remaining
phone coverage. Guest review bounds its reading column and lets native composer
fields shrink to fit narrow viewports.

The live `MobileShell` and `StudioShell` adapters render props-only shell views.
`MobileShellView` owns the four-mode chrome, More-back, and the single Inspector or Mix sheet.
`StudioShellView` owns desktop/tablet chrome, editor tabs, and ingest target/coach.
The adapters retain viewport effects, commands, focus/presence refs, selection
policy, and memoized timeline headers. The catalog composes these views with
fictional bounded regions and representative transport controls. It includes
360px phone and desktop/tablet fixtures without mounting the full DAW runtime.
See [shell chrome](design-system.md#shell-chrome) for the catalog boundary.

## Breakpoints

| Shell | Width | Root class | Layout |
|-------|-------|------------|--------|
| Phone | `< 768px` | `data-shell="phone"` / `.daw-shell--phone` | Four modes + selection sheet |
| Tablet | `768–1100px` | `data-shell="tablet"` / `.daw-shell--tablet` | Timeline + peek inspector sheet (portrait); side inspector when wide enough |
| Desktop | `> 1100px` | `data-shell="desktop"` | Reaper four-pane grid + optional layouts |

Hook: [`gui/web/src/hooks/useViewportClass.ts`](../gui/web/src/hooks/useViewportClass.ts) reads a first-render snapshot through the shared media-query subscription in `useMediaQueryStore.ts` (`matchMedia` + `visualViewport` resize). Pointer capability and Storybook docs theme use that subscription too; pointer events still select the last used device. Store mirrors `shellBreakpoint`. CSS class stem `.daw-shell*` is frozen BEM (`StudioShell` / `MobileShell`); do not rename it in lockstep with the TypeScript component.

Chrome type/space is rem via theme tokens. Pane density (status chips, pipeline, header rail) follows named `@container` (`app` on `.daw-shell`, `timeline` on `.timeline-area`), not viewport-width `@media`. Short-viewport `@media (max-height: 40rem)` for portaled sheets is a documented exception (`-- user-approved:`). Policy: [.agents/rules/gui-styling.md](../.agents/rules/gui-styling.md).

## Browser chrome, safe areas and Home Screen (#1077)

On iPhone the owner found landscape close to unusable: Safari's bars and the
bottom drawer left less than one whole 104px track. iPhone Safari gives a page
no way to hide its bars: `minimal-ui` has been ignored since iOS 8, and the
Fullscreen API covers video only on iPhone. Safari minimizes the bars only
while the document itself scrolls
([WebKit bug 231878](https://bugs.webkit.org/show_bug.cgi?id=231878),
[bug 266835](https://bugs.webkit.org/show_bug.cgi?id=266835)), which the fixed
app shell never does. An earlier round scrolled a hidden runway under the
shell to trigger that collapse; the owner's iPhone test found the bars stayed
in both orientations, so it is gone. Since iOS 26 any site added to the Home
Screen opens as a web app with no browser chrome
([WebKit, Safari 26](https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/)),
and the owner confirmed it on the phone: **the Home Screen app is the phone's
full-screen path.**

- **Fixed shell.** On a touch screen the phone and tablet shells are
  `position: fixed; inset: 0` and follow the dynamic viewport. The page under
  them never scrolls, and `overscroll-behavior: none` keeps it from
  rubber-banding, so nothing slides under the strip (the round-4 rule). The
  timeline scroller keeps `overscroll-behavior: contain`, so a one-finger
  scroll on the lanes scrolls only the lanes.
- **Safe areas.** `index.html` sets `viewport-fit=cover`. The shell pads all
  four sides with `env(safe-area-inset-*)`, so rows clear the notch or Dynamic
  Island side held sideways and the home indicator; the inset bands take
  `--color-bg-base`. Other pages pad the body's left and right.
- **Home Screen app.** `public/assets/app/manifest.webmanifest` declares
  `display: standalone`, the name "Sharecut Studio" (short "Sharecut"), the
  transport colour `#1b1815` as theme and background, and icons rendered from
  `icon.svg` by `gui/web/scripts/render-app-icons.ts` (`apple-touch-icon.png`
  at 180px, 192px and 512px PNGs; the mark sits inside the maskable circle).
  The manifest omits `start_url`, so a review link added to the Home Screen
  opens that link. The files live under `/assets/`, which the relay already
  maps to `/r/{token}/assets/`.
- **Add to Home Screen hint.** In an iPhone or iPad Safari tab
  (`navigator.standalone === false`, touch points, `display-mode: browser`;
  `utils/homeScreenHint.ts`, so desktop Safari and the Home Screen app stay
  quiet), both touch shells show a banner in their banner row (`layout/HomeScreenHint.tsx`):
  "In Safari's Share menu, choose Add to Home Screen to open Sharecut full
  screen." with **Dismiss**. Dismissing it is remembered in this browser
  (`localStorage` `sharecut.homeScreenHintDismissed`, read and written through
  `utils/storage.ts`, so blocked storage only means the banner comes back).
  More keeps the same sentence as a quiet line under Gestures, so the tip
  stays findable after the banner is gone.

Short touch screens (at most 40rem tall with a coarse primary pointer, a phone
held sideways) compact the editor:

- Touch lanes drop from 104px to the 72px compact lane (`LaneFit` `touchShort`
  in `timeline/timelineMetrics.ts`), whatever the saved fixed height, so three
  or more fit. The lane does not follow the stage height, so the strip opening
  or closing never resizes lanes under a finger; **Fit tracks to window
  height** still fills the stage. With large text the lane is 3.25rem
  (`shortTouchFloorPx`), so the 2.75rem identity chip and its meter stay whole
  (104px at a 32px root). Track headers switch to their compact one-row layout,
  and a sideways pane at least 50rem wide keeps the full 11.25rem header so
  the name still reads beside M and S.
- An empty marker lane gives its quiet row to the tracks; rows with chapters,
  clips, comments or clip flags still show.
- The tablet timeline row takes all spare height and the tool rail keeps its
  own (`grid-template-rows: minmax(0, 1fr) auto`), with 2px of block padding
  (`@container app (max-height: 40rem)`).

Measured in Playwright WebKit with the iPhone 17 Pro Max descriptor, the touch
lab on and the timeline maximized (px of lanes above the rail or the strip;
2-track demo, so capacity is usable height over lane height). The After column
was measured again after rebasing onto main with the edit modes (#1154), and
its strip-closed rows once more after rebasing onto the #1161 navigation work,
when the rail's Select/Blade track grew 6px to hold its 44px buttons (the
strip covers the rail, so its rows did not move); the strip shows a tapped
clip's name and span:

| Viewport | Before: lane, usable, capacity | After: lane, usable, capacity |
|---|---|---|
| 838×390 sideways, Safari bars | 104, 211, 2 | 72, 228, 3 |
| 838×390 with the strip open | 104, 151, 1 | 72, 187, 2 |
| 932×432 sideways, Home Screen app | 104, 253, 2 | 72, 270, 3 |
| 932×432 with the strip open | 104, 193, 1 | 72, 229, 3 |
| 440×763 portrait, Safari bars | 104, 550, 5 | 104, 544, 5 |

Portrait gives up nothing. The first round's Undo and Redo wrapped to a second
rail row at 440px and narrower (498px usable, 4 lanes). Now the pair is a
non-wrapping unit and **+ Track** and **Import** give way on a rail at most
30rem wide, so the rail stays one 67px row at 440, 390 and 360px.

`e2e-compat/phone-chrome.spec.ts` checks three 72px lanes at 932×432, Undo and
Redo on both shells, a page that never scrolls under the shell, and the Add to
Home Screen banner (shown in an emulated iPhone Safari tab, gone after Dismiss
and a reload), in Chromium and WebKit. A real iPhone check remains for the
Dynamic Island side in landscape.

Phone four-mode chrome is **≤767 CSS px**. DevTools device-mode / CDP viewport override can leave the CSS viewport at tablet width while the OS window is narrower — hard refresh does not clear that; clear the override (or set 390×844) before judging Listen / Text.

## Phone: four modes + one sheet

```
┌─────────────────────────────┐
│ Compact transport           │
├─────────────────────────────┤
│ MODE CONTENT (flex)         │
├─────────────────────────────┤
│ Listen | Timeline | Text |  │
│ More                        │
└─────────────────────────────┘
     ↑ selection → BottomSheet
```

| Mode | Content | Primary jobs |
|------|---------|--------------|
| **Listen** | Mix-oriented scrubber, comment list, status chips | Guest review, audition |
| **Timeline** | Fixed-center playhead scrub, Ferrite lane gutter (sticky identity), layer chips | Spatial edit / seek |
| **Text** | Transcript panel (follow, edit, cut-away) | Word fix, suggest cut |
| **More** | Hub → **Search commands** (opens Commands and shortcuts), Mix sheet, Comments, History, Impact, Tighten, Pipeline, settings | Track mixing, long-lived panels, command discovery |

While `project === null` (progressive load), Listen keeps its hero with disabled play and “Loading episode…” as its heading; the shell header row is absent. Timeline shows skeleton lanes below its compact header transport and gutter grid. That chrome is not the ingest empty-session coach.

Selection opens a non-modal **half → full** [`BottomSheet`](../gui/web/src/ui/BottomSheet.tsx) wrapping the desktop inspector views. It retains `aria-modal="false"`, Escape, focus restoration, and an interactive timeline background. It has no Tab trap. **Expand** and **Collapse** change view size only; these actions and **Close** use the sheet-scoped `--touch-min` floor. Only the compact inspector below swipes.

With the `touchChooser` lab on, a timeline selection in Timeline mode opens the
**compact inspector** instead: a peek strip with the target's name, its key
value and rows of 44 px nudges at the keyboard's steps: a clip's fade or
trim, a pending edit's start and end, and (for the host) an envelope point's
time and level (for the host and Editor links). Holding a nudge repeats it,
faster after a few steps, and the run saves as one edit; a held run stops at a
soft boundary (the playhead, a chapter, a clip or pending edge) and a fresh
press goes past it. A trim's strip wears the **Ripple** mark: later clips on
every dialogue track move with it, and a held nudge previews them all. A
ripple trim drag draws the same on every lane it moves: arrows to where the
later clips go and, on the other lanes, the span a shortening trim takes.
The compact inspector is a swipeable drawer (#1051 round 4b): drag its header,
which shows a grabber pill, up or down between **peek** (the strip), **half**
(the full inspector at no more than half the slot) and **full**. The sheet
follows the finger 1:1 on the compositor and re-renders nothing until the
release; then it coasts on the finger's speed to the nearest detent, so a
quick flick opens or closes it fully and a slow drag lands where it was left
(reduced motion lands it without the slide). A second finger drops the swipe. **Expand** steps up
one detent and **Collapse** returns to the strip; both stay, named for where
they go ("Expand to full height"). A visually hidden range, "Inspector
height", changes the detent from the keyboard or a screen reader. The title
keeps the target's name at every detent, and the last detent opens the next
selection. The
timeline scrolls the selection above the strip or sheet, and any timeline drag
stows it until release. A phone held sideways (tablet shell, at most 40rem
tall) gets the same compact inspector in place of the bottom tabs. Its name,
**Expand** or **Collapse** and **Close** stay pinned at the top while the
expanded inspector scrolls, and the strip stacks above the nav or status row
beside it (`--z-sheet-docked`); the editor page never rubber-bands. Decision and
measurements: [touch-editor-decisions.md § Compact inspector](touch-editor-decisions.md#compact-inspector-1051-round-3)
and [§ Collapse stays in reach](touch-editor-decisions.md#collapse-stays-in-reach-1051-round-4).

Modifier inspector sheets use one scroll owner for their complete content, including sheet chrome, actions, fields, errors, related commands, and audition footer. The content has natural height, so enlarged headers cannot compress a separate field scroller. Scroll to the top to reach **Expand**, **Collapse**, and **Close**. Desktop modifier inspectors also scroll as one aside; their fields and errors flow with the header and footer. Envelope focus transitions reveal the current control within its sheet or inspector without scrolling the page or timeline. The taller half peek applies to every modifier inspector. Sheets remain transient with no stacking. Deferred mutation errors across shell remount, Firefox layout CI, and overlapping Approve remain in [ROADMAP.md § Follow-up](../ROADMAP.md#follow-up).

**More → Mix** opens one full-height non-modal sheet for every role. Rows follow
project order and show lane initials, names, M, S, and saved Volume. M and Volume
save through the existing mix commands for hosts and guests with `edit`; other
guests use local M and see disabled Volume with its permission reason. S stays
local for everyone. Shared playback still uses Full mix, as the sheet explains.
While any track is soloed, **Solo on · Clear solo** leads the sheet. Rows of
tracks you don't hear go grey; the initials tile outline is dashed when your
solo silences the track and solid for a saved mute.
The default row is 3.5rem with at least 2.75rem M/S/range targets. Long names
truncate only in their column; many rows scroll together with the explanatory
copy. Text scaling can move Volume onto a second row without clipping controls.

Opening Mix clears the prior selection and armed range. Close, Escape, and
scrim dismissal leave More open and restore its Mix trigger while mounted.
Navigation keeps focus on the chosen nav control. Project, follow, destination,
selection, or range changes invalidate Mix permanently; returning to More does
not reopen it. Mix and Inspector share one keyed sheet. Gestures closes Mix
before opening its existing dialog. Other global dialogs, including Bounce, also
invalidate Mix. Committed writes continue through the shared
mix queue after closing. A swipe overlay remains deferred.

Inspector sheets keep the timeline interactive behind them: their background scrim is decorative and pointer-transparent, so a phone user can drag a pending edge or tap the ruler without closing the inspector. A blank ruler tap seeks and clears the current selection. Confirmation sheets, including the blade-cut confirmation, keep a dismissible outside scrim; Close and Escape remain available for both sheet types.

Pending timeline edits use the same lane-wide region on phones. A selected region shows 44px start/end touch targets only when its drawn width is at least 44px and the lane leaves room for both targets. For a narrow region or compact lane, the edge handles stay hidden on touch; the selected action card offers **Edit timing**, which focuses the existing Source start field in the inspector. The card keeps its label and Approve/Reject controls in a fixed, viewport-anchored surface below or above the lane; it does not cover the region or add horizontal timeline scroll. Dense unselected cuts reveal a floating label on hover or keyboard focus, and labels follow zoom and responsive layout changes. A host transcript-refine recovery card stays inside the measured, scrollable action surface. The Impact panel lists every pending edit for selection, while bulk review actions remain limited to review-required edits.

Coarse-pointer timeline lanes keep a minimum height of 104 canvas pixels, matching the compact header floor already used by the phone timeline. A short screen (a phone held sideways) is the exception: lanes drop to 72px so three fit (see [Browser chrome](#browser-chrome-safe-areas-and-home-screen-1077)), and the hit router's crowded-target chooser resolves the tighter targets. The lower seam roll target is 48 canvas pixels high and at least the shared touch target width. It stays below the fade corners and inside its clip, while the join badge remains in the top gutter and the crossfade endpoint control uses its separate rail below the timeline.

On phones, Pipeline step parameters open in the shared modal Dialog. Escape and
Close dismiss it and return focus to the selected step; Tab stays inside the
dialog. Tablet and desktop keep the parameter form inline. An open modal dialog
holds every app shortcut (`ui/modalGate.ts`), as the native `confirm()` did:
Escape closes the dialog and does not also clear the selection, and Mod+Z,
Space or Delete do nothing behind it, so an in-app confirm over the Inspector
neither undoes nor removes anything while it asks. Typing, Tab and Enter inside
the dialog stay native. A modal can hand on named shortcuts; the Record room
hands on M for a live marker. On close, focus returns to the control that
opened it (`ui/pressedControl.ts`: the focused control, or the one just
clicked, since Safari does not focus a clicked button).

### Feedback toast

The app toast (`feedback/FeedbackToast`) waits up to 8 s, so on a phone it must
not sit over controls. It docks just above the highest bottom chrome that is
shown: an open sheet, the Timeline tool rail (Select, Blade, Import), or the
mode nav, and below the transport and status row. With a half sheet open it
sits over the timeline between the transport and the sheet. A full-height sheet
leaves no free band; the toast then sits above the mode nav, over the sheet's
scrolling body, which can be scrolled past. If that spot would cover the
control just pressed (a "Move track down" near the bottom of a full sheet),
the toast moves just above that control, or just below it when there is no
room above (`ui/pressedControl.ts` remembers the clicked control; Undo and
Dismiss in the toast itself do not count). `feedback/toastDock.ts` measures
those edges every frame while a toast shows (like an open menu) into the
region's `--toast-dock-bottom`; without it the CSS places the toast above the
mode nav. Desktop and tablet keep it above the status bar.

### Selection sheet: three zones

Every selection sheet follows the same three-zone layout for consistency:

1. **Primary actions** — the inspector content itself (2-3 most common actions, large targets)
2. **Related commands** ("You might also want…") — Copy for clips and single transcript words. Transcript and timeline ranges use the shared Play/Cut/Mute/Comment/Bounce sheet, with capability reasons on disabled actions.
3. **More** — context-filtered command overflow below Related. Clips offer Cut (copy to the session clipboard, then ripple-delete) to editors; tracks offer Move track up/down only for directions that exist. View-only guests do not see edit actions. Selections whose safe actions already live in the inspector or Related zone omit command chrome entirely. Both zones live in `RelatedCommands` (`gui/web/src/inspector/RelatedCommands.tsx`), with mappings in `relatedCommandDescriptors.ts`.

Example: Clip selected → Related shows Copy; More shows Cut for editors. Fade/delete remain clip-inspector controls and seeking remains in its footer.

In Timeline, **Select range** arms touch selection on clip bodies and empty
lanes. Numeric In/Out with lane checkboxes offers precision without dragging.
Trim/fade/join/envelope handles retain priority. Editors apply range edits and Commenters create
pending range proposals; Viewers keep the five actions visible with disabled reasons.

### Feature → home map

| Desktop region | Phone home |
|----------------|------------|
| Transport play/time/audition | Listen hero (`layout/ListenHero`, story `Templates/ListenHero`); compact header transport on Timeline, Text, and More (the project name moves to the Listen hero when the bar is under 30rem); audition/zoom in Menu. The Listen hero carries the same Menu beside the project name, so Listen reaches Bounce, Export deliverables, Share, audition and Help without switching modes |
| Mode nav | Icon + label tabs; the active tab is tinted with an accent top indicator (no filled block) |
| Comment / Fit | Header primary **icons** outside Listen; Fit is available on Timeline and in the non-Listen Menu |
| Track headers M/S/FX | Lane gutter tap (the whole rail; the initials chip is the affordance) → track sheet (**M**/**S** toggles and the saved **Volume** fader; drag the Volume envelope layer for envelopes). More → Mix adjusts all tracks without changing selection. Header mixer chrome hidden when the timeline pane is narrow; reorder via Menu → Move track up/down |
| Timeline overlays | Timeline mode + layer chips |
| Inspector | Selection sheet |
| Transcript tab | Text mode |
| Comments | Listen list + More → Comments |
| History / Impact / Tighten / Pipeline | More hub |
| Command palette (`?`) | More hub → **Search commands**, a field-styled row at the top of the hub that opens **Commands and shortcuts** as a bottom sheet with Search focused |
| Status bar | Actionable chips (tap → panel) except **Activity** (`kind=agent`), which is status-only until the activity-history drawer; Listen **Pending** selects first review-required pending and opens Timeline; **Mix out of date** (**No mix yet** when nothing is rendered) uses the shared render-status breakdown, so a new empty project stays fresh; **Pipeline** chip shows truncated headline, elapsed, and pulse (not `●`) and opens Pipeline; **Activity** chip uses the same chrome plus a count badge when more than one job is live |

### Gestures

Touch gestures for common actions, documented in the **Gestures** cheatsheet (More hub → Gestures). It is an app-level modal (outside inert app chrome) and can switch directly to **Commands and shortcuts**; that dialog links back to Gestures without stacking. Two-finger Undo is an optional Sharecut shortcut, not an iOS system convention; the Timeline tool rail has visible Undo and Redo, and More has the History route. Pinch zoom remains available, and it never edits: a second finger on the timeline cancels any one-finger drag or press in progress without saving it and puts the selection back ([decision](touch-editor-decisions.md#pinch-never-edits-1051-round-4)). With the touch chooser lab on, timeline editing follows the [touch input grammar](touch-editor-decisions.md#decision-one-touch-input-grammar-for-timeline-editing): one finger moving scrolls and never edits, a tap selects, a long press arms a target (the chooser when targets crowd) and only an armed target drags, along its own axes, with a brief detent at each soft boundary; a long press on a movable clip's body, away from its handles, arms the clip, which then moves in time within its lane and bumps at the session start; a long press on empty timeline space opens the create menu (add envelope point, blade cut, add chapter, add comment), with each entry the link cannot run disabled beside its reason ([round 4b](touch-editor-decisions.md#touch-grammar-round-4b-1051)). Every timeline target kind's touch, drag and key behaviour comes from one contract, `gui/web/src/timeline/inputContract.ts`. Visible command routes remain available for the shipped gesture shortcuts; the cheatsheet lists only shipped gestures. Remaining non-drag edit alternatives are tracked in [the touch-editor decision record](touch-editor-decisions.md). Gesture thresholds (hold time, touch slop, click-versus-drag distances, drag detent, drawer swipe and flick, ghost-click window, double-tap gap, swipe distances and drag cap) live in one module, `gui/web/src/hooks/gestureConstants.ts`, which every gesture reads. The hold is 500 ms and a held finger may drift 10 px, after iOS's long-press defaults (0.5 s, 10 pt) and inside Android's (400–500 ms, 8 dp touch slop); the module cites the platform sources. Long-press selection varies by target (clip, comment, track, or transcript word), so it is explicitly exempt from a single command ID; each target keeps its existing selection or correction action.

- **Long-press** (`useLongPress`) selects a comment or track and opens the existing inspector sheet; on a transcript word it opens correction. Clips already select on pointerdown (a hold is just a tap there; with the touch chooser lab on, a timeline touch selects only on a tap and never while scrolling, see [touch-editor-decisions.md](touch-editor-decisions.md#touch-target-chooser-prototype-1051-lab)), so they have no separate recognizer and a hold never reselects or collapses a multi-selection. Movement, cancellation, and a second finger (even on an element that stops propagation) abort it. It fires on release and consumes the synthesized click; a press whose click never arrives is flushed by the next pointerdown rather than dropped. On coarse pointers, transcript words and comment headers set `user-select: none` / `-webkit-touch-callout: none`, and the native context menu is suppressed while a press is armed, so the OS selection UI does not claim the hold. Physical iOS/Android verification is still required; CDP touch in CI does not trigger native selection.
- **Double-tap word**: the first tap seeks immediately (no added latency); a second tap on the same word within the double-tap gap opens correction. `.transcript-list` sets `touch-action: manipulation` so browser double-tap zoom cannot eat the second tap. On desktop, a host's double-click opens inline word editing instead (the first click still seeks); touch double-tap keeps the correction sheet. The navigate-mode hint under the transcript toolbar follows the pointer: coarse pointers read "Double-tap a word to correct its text…" and fine pointers get the inline Enter/Esc hint. The split is deliberate: the sheet leaves room for the on-screen keyboard and keeps Suppress and phrase (End index) correction one tap away, which a chip-sized inline input cannot. Both paths submit through `submitWordCorrection` (`gui/web/src/transcript/wordCorrection.ts`), so they cannot drift.
- **Word correction from a gesture is scoped to that gesture**: it switches the panel to Correct only while the word sheet is open; closing restores the previous mode (and a Select range). Gestures only open correction for hosts with hydrated words — guests and unhydrated transcripts keep tap-to-seek and never enter Correct.
- **Swipe left** invokes `comment.resolve` through the shared comment mutation path for an open comment in the comments list (hosts only; opt-in via `swipeToResolve`, so embedded threads such as the pending-edit Ask thread never resolve from a stray drag). It gives up on vertical travel, must finish before a long-press would, and the card keeps `touch-action: pan-y pinch-zoom`. Controls inside the card (checkbox labels, links, inputs, reply rows) keep their own behavior. While the drag is tracked, the card follows the finger leftward, capped at 2× the resolve threshold, and a `Resolve` cue fills the gap it opens; the cue switches to the accent style once travel reaches the threshold, exactly when release would resolve. The card snaps back on release, vertical travel, pointer cancel, or a hold past long-press, so the cue never shows for a swipe that cannot resolve. With `prefers-reduced-motion: reduce`, the card does not move; the cue instead overlays the card's inline end. Resolving from either the swipe or the footer **Resolve** button shows an Undo toast (`Resolved comment at <time>`, polite live region, 8s auto-dismiss paused while a mouse or pen hovers it, while focus is inside it, or while Undo is disabled by another pending comment change; touch contact does not pause it). Only the latest resolve has a toast: resolving another comment replaces it. **Undo** reopens the comment and moves keyboard focus to the Comments panel (including when the browser blurs Undo to the page body while it is disabled during the reopen request); reopening from the card's **Reopen** button still works after the toast is gone or was replaced.
- In **More → Comments**, selecting a comment (tap, long-press, or posting a new one) opens the Inspector sheet, matching Listen. In **More → Impact**, selecting a pending edit opens the same Inspector.

The Comments panel owns its scroll area so the Undo toast stays reachable while
the list scrolls. Closing a focused toast returns focus to the panel with
`preventScroll`. Browser regressions cover desktop and phone in both themes,
plus one Chromium and WebKit phone flow. They measure Dismiss separately from
Undo because removing or restoring a row can change list layout. Physical iPhone
and iPad Safari checks remain pending.

Two-finger Undo is active only while a project is loaded and the shared Undo command is available. Its recognizer yields to timeline pinch/rotation and rejects delayed, moving, or cancelled contacts so zooming does not also undo an edit.

| Gesture | Command | Status |
|---------|---------|--------|
| Two-finger tap | Optional Sharecut Undo shortcut | Available when project Undo is available |
| Long-press | Select a comment or track and open its sheet; correct a transcript word (hosts) | Available |
| Pinch | Zoom in/out on timeline | Available |
| Swipe left on open host comment | Resolve (Undo toast follows) | Available |
| Double-tap word | Correct word (hosts); first tap seeks | Available |

## Wireframes (ASCII)

### Phone — Listen

```
┌─ Episode name ────────────── [≡] ┐  ← hero card (fixed-dark transport tokens); [≡] is the app Menu
│ 12:34 / 58:39                     │
│ ══════════●═══════════════════    │  ← coarse scrub (44px, brand accent)
│     −15s  (▶)  ■  +15s            │  ← 44px targets; Play is the only orange control
└───────────────────────────────────┘
│ Pending: 3  ·  Mix out of date       │  ← chips (Pending → Timeline + first review-required)
│ Activity: running · Aligning… 0:12│  ← Pipeline chip taps More/Pipeline; Activity chip is status-only
│ ───────────────────────────────── │
│ ● 04:12  “level feels low”        │
│ ○ 11:02  “cut cold open?”         │
│ …                                 │
├─ Listen | Timeline | Text | More ─┤
```

### Phone — Timeline (fixed playhead)

```
┌─ Play  12:34 / 58:39  [Fit] [⋯] ──┐
│ Pending edits Volume envelope Markers Comments │  ← chips
│ ┌─ref│░░░░░░░░░░░░░░░░░░░░░░░░░░ │ │
│ │gue│░░░░░░░░░░░░░░░░░░░▼░░░░░░ │ │  ← slim sticky gutter + CapCut ▼
│ └────┴───────────────────────────┘ │
│         drag timeline to scrub    │
├─ Listen | Timeline | Text | More ─┤
│ ┌ sheet: track / Pending cut ─ X ┐ │
│ │ M · S · Volume / Approve       │ │
│ └───────────────────────────────┘ │
```

The playhead is a fixed center line and the timeline scrolls under it. The time column is padded by half the time viewport on each side (`--timeline-lead`; `fixedPlayheadLeadPx` in `gui/web/src/utils/timelineViewport.ts`), so any time, including 0 and the end, can sit under the line even at fit zoom.

- **Logical scroll.** Store `scrollLeft` is logical: time × zoom from the column's left edge, down to −lead. `TimelineView` converts at the DOM edge (`logicalToDomScrollLeft` / `domToLogicalScrollLeft`), and the scroll before 0 is dropped when the view unmounts.
- **One measurement.** The scroller's time viewport (`clientWidth` minus the header column, the same source as fit commands, zoom anchoring and presence) sets the fit, the lead pads, the line (`--timeline-fixed-line`) and the center math. A `ResizeObserver` on the scroller and the header column only triggers a re-measure, and the fit reruns only for a new width or session length. A classic scrollbar's gutter therefore can't shift the line. Fixed-playhead scrollers reserve no empty gutter, because Chromium shortens the scroll range by the gutter width and the end became unreachable.
- **The session end is geometry.** A fixed-playhead canvas is exactly the session (`fixedPlayheadCanvasSize`), even below fit zoom, so the scroll range itself ends with the session end under the line; nothing is written back during a drag or fling.
- **Only a person's scroll seeks.** Fit, recentering and follow writes are programmatic; a late scroll event that lands on the last written position is their echo; and a move of one pixel or less (`PLAYHEAD_MOVE_MIN_PX`) never changes the time.
- **Recording preview can extend the pan range.** While a take is recording or paused, phone users can pan past the saved-media end to see its provisional needle. Panning in that visual-only range leaves the saved-media playhead and seek bounds unchanged.
- **Zoom.** Fit and command zoom (menu, keys) center on the playhead's time, so they keep it. Pinch and Ctrl+wheel, claimed anywhere on the timeline except the track headers, keep the time under the fingers still within the session, and the playhead takes the new center time.

Lane identity is a sticky gutter beside the waveforms (same scroller; `headerSlot` into `TimelineView`), identity first, following praised mobile editors (BandLab, GarageBand, Ferrite): in the narrow rail each lane shows a **44pt initials chip** tinted with the lane color (full-strength ink, dashed and dimmed when muted), the lane color on the rail edge, and speaker-first clip labels with readable durations (for example, "Avery · 17m 26s", falling back to the track name when no speaker is set). The whole rail opens the track sheet; a trailing **›** disclosure marks that only in the wider phone rail. **Mute/Solo** and the saved **Volume** fader live in that sheet (same commands as the desktop header and inspector); envelopes stay on **Volume envelope** (drag a point, then edit time/value in the inspector). Do not put a mixer strip in the 4rem gutter.

**Arrange density** follows the timeline pane via `@container timeline` on `.timeline-area` (Every Layout Container escape hatch), not `window.innerWidth`:

| Pane inline-size | `--header-width` | Header chrome |
|------------------|------------------|---------------|
| `< 30rem` | `4rem` | Gutter: lane-color edge + 44pt initials chip; speaker or track identity moves onto clip labels; no grip (Menu → Move track up/down) |
| `< 68.75rem` | `8.75rem` | Mid mixer rail |
| else | `11.25rem` (root token) | Full desktop headers |

Headers stay `flex-wrap: nowrap` beside the time Reel — Sidebar’s wrap-when-narrow would stack identity above lanes (the bug we avoid). Shell mount (phone four-mode vs tablet/desktop) still uses `useViewportClass`; only rail width and mixer chrome follow the container.

A wide phone landscape pane can show the mid rail; a narrow desktop pane (inspector eating space) can show the gutter. That is intentional.

Timeline z-index roles preserve the mixer layer order across desktop, tablet,
and phone shells; see [design tokens](design-tokens.md#elevation).

### Phone — Text

```
┌─ Play  12:34  Follow · Edit ──────┐
│ HOST                              │
│ so we ┌were┐ talking about …      │  ← tap seek / edit sheet
│ GUEST                             │
│ yeah and the ┌launch┐ …           │
├─ Listen | Timeline | Text | More ─┤
```

### Tablet — portrait peek

Bottom tabs default to ~40–45% of space below transport/status, capped so the shell grid never exceeds the viewport (`--tabs-height` on `html[data-shell="tablet"]`). Short viewports (`@media (max-height: 40rem)`) shrink the tabs further. Hosts may drag the top edge of the tabs band to resize (same splitter as desktop); a stored `sharecut.tabsHeight` overrides the CSS default until reset. Selection peek sheet docks **above** that band (and above phone mode nav) and sizes to the remaining slot (`max-height: 100%`); text/review focus hides the sheet so the expanded panel stays readable.

```
┌─ Transport (decluttered) ─────────────────┐
│ Headers │ Timeline (moving playhead)      │
│         │         ┌ peek inspector ┐      │
├─────────┴─────────┴────────────────┴──────┤
│ Transcript / Comments / … (tabs band)     │
└───────────────────────────────────────────┘
```

### Desktop — layouts

| Layout | Command | Effect |
|--------|---------|--------|
| `default` | `layout.default` — **Restore layout** | Full grid |
| `timeline` | `layout.timeline` — **Maximize timeline** | Collapse bottom tabs (more lane height) |
| `text` | `layout.text` — **Maximize transcript** | Expand transcript; shrink timeline; dock Correct word editor when a word is selected |
| `review` | `layout.review` — **Review layout** | Comments tab + mix-oriented chrome |

One transport control (an expand/restore icon whose name says what a click does: **Maximize timeline** or **Restore layout**) maximizes the timeline, or restores from any layout; View › Layout radios reach the transcript and review layouts. A persistent "… · Restore" pill sits in the transport, which no layout hides (collapsed bar: "Restore"). The splitter is hidden outside the default layout. Status-bar chips and other tab jumps (comment markers, comment mode, `view.setTab`, tighten go-to-hit, pipeline runs, follow) only switch tabs. When the current layout does not show the requested tab (any tab in the timeline layout, which hides the tabs; any tab but Transcript in the transcript layout, or but Comments in the review layout), they first restore the default layout so the panel is visible. Leaving the timeline layout this way also clears timeline key focus. The old per-pane **Focus** buttons are gone. Starting to follow (or switching whom you follow) shows the leader's tab, restoring the default layout if yours hides it. After that, Follow switches tabs only when the leader's tab changes, so a follower's own layout or tab survives the leader's audition or transcript-anchor changes, and a leader moving to the tab a follower holds behind the timeline layout still reveals it.

Keyboard: `Mod+1` restore, `Mod+2` maximize timeline, `Mod+3` maximize transcript, `Mod+4` review layout. These work from anywhere except text inputs; bare digits do nothing. A browser tab may keep Ctrl/⌘+1–4 for tab switching (the desktop app does not); use the transport layout control or View › Layout there. View › Layout and View › Theme are radio groups (no cycling). Layouts exist only on the desktop and tablet shells: the `layout.*` commands are disabled on phone (`layoutShell` gate), and entering the phone shell resets the layout to default.

The shell grid uses named areas (`banners / follow / transport / main / tabs / status`); modes only resize the `main` and `tabs` tracks, so banners, transport and status rows never move (`layout/shellGrid.test.ts`).

## Interaction principles

1. One job per phone screen (no timeline + full transcript + inspector).
2. ≥44×44pt targets; fade/envelope hit areas ≥2× visual width.
3. Sheets: Close + dismiss; never stack.
4. Dialog overlays cap to `90dvh` with a single `.command-palette-body` scroller. Menus cap to `min(90dvh, var(--menu-available-height))`, where `--menu-available-height` is remaining space under the trigger (above phone `.mobile-nav` when present, re-measured every frame while the menu is open so a banner row appearing above the transport cannot leave a stale cap), and scroll internally so every item stays reachable on short viewports. The active phone navigation item keeps a transparent tab with an accent label and accent top indicator (the platform tab-bar convention for the current location); its state transition is disabled for reduced motion. The centered phone playhead uses `--color-timeline-playhead` so it remains visible in the dark timeline well.
5. Snap only to on-screen anchors.
6. Listen-first: every edit surface keeps Play around / seek footer.
7. Progressive complexity via `shareMode` capabilities.
8. Waveforms paint at a DPR capped at 2 (`paintDpr`, on a 1/8 grid). The phone shell uses smaller waveform caches: 48 MB of bitmaps and 32 MB of data tiles, against 128 MB and 64 MB on desktop ([waveform.md § Renderer](waveform.md#renderer)). Guests on phones draw from pyramid tiles only, never raw PCM.

## Transport chrome (narrow)

When the transport is **collapsed** (tablet/phone, or bar width ≤720px via `ui/useResizeObserver`):

The host recording chip remains a full touch target in the collapsed tablet transport. On phone it occupies a persistent status row above every mode body, leaving the header controls reachable. The same row shows **Solo on · Clear solo** (44 px) while any track is soloed, in Listen too, where the transport is hidden. The row sits under sheets, like the transport, so the Mix sheet's own chip stays visible. During a healthy take it shows a red dot, REC, and the running take clock; PAUSED and local capture failure use distinct text. Its accessible description includes the current take time. Reduced-motion settings keep the dot static.

| Tier | Controls |
|------|----------|
| Primary (always visible) | Play/Stop, compact playhead timecode, **Comment** icon, **Fit** (session width, except Listen), Menu icon; desktop/tablet also **Layout** (maximize/restore) and, on the wide bar, a **Fit tracks to window height** icon beside Fit |
| Menu → People | Live roster (follow / unfollow) when the bar is collapsed. Rows are `var(--touch-min)` (`2.75rem`) via `@container transport`. |
| Menu → Project (host) | New / Open, then the export pair Bounce… and Export deliverables…, then **Share…** (collaboration extension), Record room… and **Connect agent…**, with a divider between the three groups. Selection (**Select a range**) follows Markers, so Help sits right under the view sections. Home also has **Connect agent…** |
| Menu (secondary) | One combined menu on phone and tablet: Project, Media, audition Full mix/Edited stems/Original, **Refresh mix** when render is stale, layers, zoom, **Track height −/+** and **Fit tracks to window height** checkbox, layout, theme, Fit session width if omitted from bar, Help (wide desktop splits layers/zoom/track height/layout/theme into a **View** menu) |

### Editing tool rail (phone / tablet Timeline)

Ferrite-style bottom rail (`EditingToolRail`): **Select | Blade** icon toggle (structural guests; its track grows to hold the 44px touch buttons rather than leave them hanging below it), **Cut at playhead**, and a confirm sheet for blade cuts (tracks + timecode). **Undo** and **Redo** icon buttons close the rail at its inline end for the host and `edit` guests (#1077, the #1028 phone scope): bottom zone, beside the tools they reverse, through `history.undo` / `history.redo` on the command bus (`runHistoryAction`, which also announces a failure). Each is a 44px square. With nothing to undo or redo it is dimmed and disabled, the platform convention; a screen reader hears why ("Nothing to undo", "Nothing to redo") through `aria-describedby`, and a mouse or pen sees it as the tooltip. The pair never wraps or shrinks (`flex: none`), and buttons never break their labels. In a rail at most 30rem wide (`@container app`, so a phone in portrait) **+ Track** and **Import** leave the rail, because the row cannot hold them beside Undo and Redo without wrapping and costing the lanes 52px; both stay in Menu → Media and in More. Wider rails keep them. An unavailable Undo or Redo is `aria-disabled`, not `disabled`, so a finger can tap it: the tap shows the reason ("Nothing to undo", "Nothing to redo") in a note floating above the rail's inline end for a few seconds (the rail's `role="status"` line, so it is also announced), without moving the lanes or taking their touches. The two-finger tap and More → History remain. **Comment** stays on the collapsed transport so Listen/More still have it (compact `ToolModeToggle` omits Comment to avoid a duplicate). Desktop uses the expanded transport toggle (**V** / **C** when timeline-focused; same `execute` command bus as the rail — see `gui/web/src/keymap/` + `gui/web/src/commands/`); in blade mode a pointer-following cut preview marks target lanes, and click on **clip / empty-lane / ruler** splits immediately (no confirm sheet). Multi-track selection: Shift/Cmd-click track headers; blade with no selection targets all dialogue tracks.

Labeled audition/pills do not stay in the bar when collapsed — that was clipping Comment/Fit/Menu off-screen. The **Mix out of date** pill is wide-bar only; collapsed transport keeps timecode pinned (`flex: 0 0 auto`) and moves refresh into Menu so digits cannot paint over status. A missing mix is the same single status, reworded: the pill, the Menu's refresh item and the phone status chip read **No mix yet** (**No mix yet · Refresh** where the person can refresh; a guest sees **No mix yet** only) instead of **Mix out of date**. The Menu's Mix status section adds "Full mix is silent until you refresh the mix." above the refresh item, and the wide bar puts the same reason on the Full mix segment.

## Desktop / tablet back-apply

Keep the Reaper grid. Shared polish:

The desktop transport is a 3.5rem fixed-dark control strip in both themes, with
a large mono current timecode, a smaller duration, and an accent Play control.
Tablet and phone headers retain a 3.25rem compact row and keep audition modes
in Menu. The light theme gets a light timeline stage (no lane grid; the
empty stage's inset vignette is transparent, and the lane floor's edge falloff
is a 6% wash), the dark theme a dark well; the empty project
offers a gridded drop stage as the import target.
Track headers use their lane's clip color at the leading edge. Playback lighting
only animates when reduced motion is not requested.
Their horizontal playback meters remain visible in compact lanes and in the
phone rail beneath the initials chip. Wide headers retain a separate **Clear clip light** button. The narrow identity
rail shows a passive clipping indicator; open track details to use the labeled
**Clear clip light** action with its shared touch-target floor. The identity target
remains free of the meter's reset hit area. Reduced motion keeps the bar and peak
marker still while the clip light can latch. Pause and Stop
retain that light until cleared.
Phone lanes have a 104px minimum in both fixed and fit modes, leaving separate
touch targets for opening track details and clearing clipping. On a short
screen the minimum is 72px, or 3.25rem with large text (#1077). The saved track
height still applies when it is larger than that minimum.

- Transport overflow (theme, layers, zoom; host-only More → Add chapter at playhead, `edit.addChapter`)
- Layouts (above)
- Wider invisible hit targets for fades/envelopes
- Actionable status chips → Impact / Pipeline / Comments
- Capability-aware chrome for guests
- Pinch-to-zoom on timeline (all shells; spatial claim on `.timeline-scroll` + shared `applyAnchoredZoom` with keys; browser page-zoom does not fight); **fixed-center playhead is phone-only**
- Follow: tablet slaves viewport like desktop (People in Menu). Phone is listen-along — banner is its own grid row (`daw-shell--following`); Listen scrub/±15s unfollows; Timeline colors the center needle and still draws other ghosts (never the local guest, whose share WS id is `guest-{token}-…`). Touch floors are `var(--touch-min)` in rem via `@container app` (banner, More hub) and `@container transport` (Menu rows), not `@media` viewport queries.
- Track headers lock vertically with lanes inside one scroller (sticky on inline-start). The ruler and marker row stay pinned above the lanes as you scroll vertically. They keep panning horizontally with the lanes, while the phone's fixed-center playhead stays in the viewport. Density (gutter vs mixer rail) follows `@container timeline` on `.timeline-area`. Zoom hit-tests the time column, not mute/solo.
- Desktop and tablet timelines keep a vertical scrollbar present so the time viewport width stays steady as track overflow changes. Phone fixed-playhead mode shows the vertical scrollbar only when tracks overflow.

Do **not** bring phone bottom-nav or CapCut fixed playhead to desktop.

Host offline command attention occupies its own shell row on phone, tablet, and desktop; queued host edits stay visible while reconnect/replay is pending, and conflict rows can be dismissed. The share-mode label remains guest-only.

## Testing

- Vitest: `useViewportClass`, `BottomSheet`, mobile shell smoke, follow live region + Listen unfollow, layout CSS classes, shell grid areas (`layout/shellGrid.test.ts`), layout controls; Playwright `e2e/layout-modes.spec.ts` (layout × attention × following geometry at 1512×805)
- Playwright: phone viewport (`390×844`) asserts `.daw-shell--phone` + mode nav; `e2e/overlay-viewport.spec.ts` Menu + Share dialog reachability at `1280×715` and `390×844`; `e2e/presence-follow.spec.ts` two-client follow at 390 / 820 / 1440; `e2e-compat/timeline-scroll-end.spec.ts` checks the desktop horizontal end with short lanes and classic scrollbars on Chromium and WebKit
- Playwright compat: `e2e-compat/phone-chrome.spec.ts` (#1077) checks three 72px lanes sideways at 932×432, rail Undo and Redo, a page that never scrolls under the shell, and the once-per-browser Add to Home Screen banner, in Chromium and WebKit with touch emulation
- Manual / guest parity: [`gui/web/e2e/PARITY.md`](../gui/web/e2e/PARITY.md)

See [`gui/web/README.md`](../gui/web/README.md) and [gui-integration.md](gui-integration.md) § Responsive shells.

### Transcript speaker editing

Tap a speaker label to rename or reassign every turn on that track. The editor wraps its input, scope hint, and Save and Cancel controls within the transcript panel. On coarse pointers, speaker labels and the name input use the shared `--touch-min` target size. Hosts and guests with the `edit` capability can save speaker names.

### Transcript find and replace

The host Text/Transcript toolbar exposes **Find and replace** on every shell. The native labeled inputs and preview list wrap within the panel and scroll without replacing the transcript list. Hosts review source-keyed changes and apply the complete set as one Undo action. Different word counts show the source-span timing warning before apply. Shared guests retain the existing text-correction restrictions. See [daw-editing.md](daw-editing.md#transcript-find-and-replace).

### Crossfade length on Timeline

Open a crossfade join badge to reveal a reserved endpoint row below the scrolling lanes. The right-endpoint grip has a target at least 44 px in both dimensions. Its leader connects to the centered overlap X, and its caption shows the seam and effective or draft length. The grip stays outside clip move, seek, fade and roll targets, with the popover above its reserved row. Dragging saves one coupled join change on release. With the touch chooser lab on, the grip follows the touch grammar like every timeline target (kind `crossfade-end`): a finger sliding on it scrolls, and only a long press arms it to drag. A mouse drags it at once. Use the native Length range for keyboard editing. Canceling restores the saved overlap. Stored unequal fades remain visible in the popover until an intentional edit sets both edges equally.
