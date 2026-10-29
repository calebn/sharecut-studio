# ShareCut Studio mobile & responsive UX

> **Non-technical overview:** [ux/pages/mobile.md](../ux/pages/mobile.md) — what mobile does and why, for partners and users.

Phone- and tablet-first shells for ShareCut Studio, plus desktop polish shared with those patterns. Desktop keeps the Reaper-style grid; phone does **not** shrink that grid.

Canonical strategy and feature map for agents/contributors. Implementation lives under `gui/web/`.

Reading-room actions and Share dialog actions/checkbox labels use the shared
`--touch-min` target floor. On phones the Share dialog is a modal bottom sheet
(`Dialog`, a sheet by default on phone and tablet): it rises full width from the bottom edge, and its
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

The `StageFrame` adapter (`gui/web/src/stage/frame/`) renders the props-only `StageFrameView`
on every viewport class: header, Stage bar (a bottom tab bar on a phone), stage
content, Player bar and banners. Each stage has a host in `src/stage/hosts/` and
the Edit stage a workspace in `src/stage/edit/`. The adapters retain viewport
effects, commands, focus/presence refs and selection policy. The catalog
composes these views with fictional bounded regions at 360px phone and
desktop/tablet sizes (`Stages/Edit/Frame`, `Stages/<Stage>/`) without mounting
the full DAW runtime. See [shell chrome](design-system.md#shell-chrome) for the
catalog boundary and [the stage specs](design/stages/spec-edit.md) for the design.

**Vocabulary since #2292.** The sections below keep their history. Where they
say transport bar, status bar, tool rail, bottom dock tabs, splitter, layout
presets, Listen, Text, More hub, Menu or View menu, read the replacement in the
[feature map](#feature--home-map) and [Player bar and Edit corner](#player-bar-and-edit-corner):
the old chrome and its `layout/` code were deleted. `.daw-shell*` classes are now
`.stage-frame*`.
See [shell chrome](design-system.md#shell-chrome) for the catalog boundary.

## Breakpoints

| Shell | Width | Root class | Layout |
|-------|-------|------------|--------|
| Phone | `< 768px` | `data-shell="phone"` / `.stage-frame--phone` | Stage tab bar + Player bar + selection sheet |
| Tablet | `768–1194px` | `data-shell="tablet"` / `.stage-frame` | Stage bar in the header, Edit with a peek inspector sheet (portrait); side inspector when wide enough |
| Desktop | `> 1194px` | `data-shell="desktop"` | Stage bar in the header; Edit shows Timeline, Script and an Inspector column |

iPad 11″ landscape is 1180 CSS px wide on the Air and 1194 on the Pro. The tablet band used to end at 1100px, which put that orientation on the desktop shell and hid the editing tools behind collapsed transport chrome (the transport and the tool strip are gone; the Edit corner holds Select range on touch) (#1632). It then ended at 1180, which still left the Pro on the desktop shell (#1674). `TABLET_MAX_PX` now includes 1194 so both keep the tablet frame.

Hook: [`gui/web/src/hooks/useViewportClass.ts`](../gui/web/src/hooks/useViewportClass.ts) reads a first-render snapshot through the shared media-query subscription in `useMediaQueryStore.ts` (`matchMedia` + `visualViewport` resize). Pointer capability and Storybook docs theme use that subscription too; pointer events still select the last used device. Store mirrors `shellBreakpoint`. CSS class stem is `.stage-frame*` (`StageFrame`).

Chrome type/space is rem via theme tokens, and Studio color consumers use semantic `--color-*` roles. Pane density (Stage bar, pipeline, header) follows named `@container` (`app` on `.stage-frame`, `timeline` on `.timeline-area`), not viewport-width `@media`. Short-viewport `@media (max-height: 40rem)` for portaled sheets is a documented exception (`-- user-approved:`). Policy: [.agents/rules/gui-styling.md](../.agents/rules/gui-styling.md).

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
  `--color-bg-base`. Viewport-fixed top-layer panels also set their edges from
  the matching safe-area insets because they escape shell padding. Other pages
  pad the body's left and right.
- **Home Screen app.** `public/assets/app/manifest.webmanifest` declares
  `display: standalone`, the name "ShareCut Studio" (short "ShareCut"), the
  transport colour `#1b1815` as theme and background, and icons rendered from
  `icon.svg` by `gui/web/scripts/render-app-icons.ts` (`apple-touch-icon.png`
  at 180px, 192px and 512px PNGs; the mark sits inside the maskable circle).
  The manifest omits `start_url`, so a review link added to the Home Screen
  opens that link. The files live under `/assets/`, which the relay already
  maps to `/r/{token}/assets/`.
- **Add to Home Screen hint.** In an iPhone or iPad Safari tab
  (`navigator.standalone === false`, touch points, `display-mode: browser`;
  `utils/homeScreenHint.ts`, so desktop Safari and the Home Screen app stay
  quiet), both touch shells show a banner in their banner row (`stage/frame/HomeScreenHint.tsx`):
  "In Safari's Share menu, choose Add to Home Screen to open ShareCut full
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
- A fresh session without a saved collapsed-panel preference uses adaptive
  layout. On a tablet with a coarse primary pointer in landscape at most
  35rem tall, panels stow and give their row to the timeline. The transport's
  **Panels** button opens them through `layout.default`, with the accessible
  name **Show editor panels**. Automatic stowing has no overlaid drawer handle
  and does not save `sharecut.tabsCollapsed`. Above that height the panels
  return. An explicit panel or layout command ends adaptation for the session.
  The saved collapsed preference remains binary, and entering the phone shell
  keeps its existing reset to default. See [Responsive shells](gui-viewer.md#responsive-shells).
- **The Inspector is a column (#1696).** On a coarse primary pointer at most
  40rem tall and at least 40rem wide (a phone held sideways at 667×375, 844×390
  or 932×430; one rule, `useInspectorColumn`, whichever shell the width puts it
  on) the selection Inspector is a column on the inline end of the shell
  instead of a bottom sheet. The decision lives in `SelectionSheet.placement`
  (`useSelectionSheet`), flows through `SheetPresentation` and `MobileSheet`
  into `BottomSheet`'s `placement="column"`, and the frame's
  `:has(.bottom-sheet--column)` rule adds the second grid column, so no CSS repeats the media
  query. The column renders in place, as a grid child of `.stage-frame` (no
  portal), in a second grid column of `--inspector-column-width`
  (`clamp(16rem, 32vw, 22rem)`). Transport, banners and the status line keep
  the whole width; the timeline keeps the whole main row; the tablet's bottom
  tabs row and the phone's mode nav give way while the column is open and
  return when the current layout permits after it closes. Close leaves layout
  intent unchanged. Adaptive panels stay stowed in a short tablet, explicitly
  open panels return, and an explicitly maximized timeline stays collapsed.
  Phone navigation returns. It has the title, **Close**, Escape and focus
  restore of any sheet, and none of the sheet's other parts: no scrim, no
  drawer or detents, no Expand or Collapse, no slide-up, and no compact strip
  (the strip and its Undo and Redo header belong to the sheet; the corner
  stays usable beside the column). The panel carries
  none of `bottom-sheet--inspector`, `--compact` or `--lane-band`, so
  `inspectorSheetPanel`, `keepTargetClear`, `useKeepSelectionClear`,
  `useKeepEditedLaneClear` and the pending edit card's docking all find no
  sheet and do nothing: nothing caps the form or scrolls the timeline for it.
  The form is the regular one (stacked fields, help copy visible), in a header
  that stays pinned over a body that scrolls inside the column. For an
  envelope selection `useRevealEditedLane` only scrolls the edited lane whole
  into its scroller, again after a rotation. The tool rail makes the narrow
  rail's trade (ingest buttons to Menu and More, Select range as an icon) so
  it keeps one row beside the column, a toast centres over the timeline beside
  it, and a pending edit's Approve and Reject card, which has no sheet to dock
  in, floats within the timeline beside the column. The shell pads for the notch,
  Dynamic Island and home indicator, so the column inherits them. With the
  software keyboard up (`html[data-keyboard="open"]`) the column leaves the
  grid flow (its track stays, so the timeline does not move) and takes the
  visible band of the viewport: `--visual-viewport-top` down by
  `--visual-viewport-height`, with `grid-area: auto` and never below the Player
  (`--column-floor`, less the part the keypad covers), so its header and Close stay on screen and
  the body scrolls above the keypad. Turning the phone
  keeps the Inspector mounted: the sheet and the column portal into one host
  element that only changes parent (`ui/sheetHost.tsx`), so a draft, the
  focused field and the dialog's focus restore survive a flip inside one shell,
  and the compact sheet body keeps its scroll offset with the field revealed,
  and the full Inspector stays the full Inspector (`useCompactInspector`
  treats the column as held). Under 40rem wide (an iPhone SE first generation or
  a 568×320 window) and in portrait the bottom sheet or compact strip stays,
  and so does a mouse window of that size. Pins:
  `e2e-compat/inspector-column.spec.ts`; the bullets below describe the sheet
  that remains.
- **A volume-envelope sheet leaves its lane in view (#1694, #1714).** On a
  tablet shell with a fine pointer, or a phone shell under 40rem wide (a
  568×320 window), at most 40rem tall, the regular inspector sheet for an `envelope` or
  `envelopePoint` selection (`editedLaneTrack`, class `bottom-sheet--lane-band`)
  takes the bottom tabs' row on the tablet shell (`responsive.css`, the same
  `max-height: 40rem` exception as the compact strip) and rests on the status
  row. On the phone shell held sideways (up to 767 px wide, so an iPhone SE or mini held
  sideways at 568×320) the sheet takes the Primary nav row instead
  (`--mobile-nav-height: 0rem` while the sheet is open, since the sheet rests on it)
  and the status chip overlays the timeline as ever; **Done** brings the nav back. The marker rows
  (chapters, comments, social clips) stop pinning under the ruler while it is
  open, so the lane sits right below the ruler and the rows are one scroll up
  (`.marker-lane` and the header column's chrome lose `position: sticky`; a pinned
  `::before` keeps the ruler's corner above the track names, under the Solo on
  chip, and takes no taps). The status line always stays, the sheet rests on it,
  and it keeps the shell's polite live region and the save state (#1448), also
  when a save is failed or waiting and the row grows to a touch target. At most
  24rem tall (914×331, and a 667×375 phone, 23.4rem) the marker rows scroll
  with the lanes in the idle layout too, on the tablet and the phone shell
  (`@media (max-height: 24rem)`), so the pinned rows never eat the lanes
  and a touch-only user can tap a lane's name to open its details; 932×430,
  1024×768 and 1194×834 keep them pinned. The **Solo on · Clear solo** chip lives
  in the header column's chrome, so wherever the rows scroll it scrolls with them
  (one scroll up), and the pinned corner no longer covers it. With the status line kept
  there, the sheet at that height has no room for a title row above **Done**:
  Expand and Close sit on the lane name's and Done's row
  (`@media (max-height: 24rem)` in `bottom-sheet.css`) and the sheet's title is
  readable to a screen reader only. The 9rem floor above belongs to the compact drawer; this
  sheet has its own. `useKeepEditedLaneClear` measures the ruler's bottom
  (`pinnedChromeBottom`, which still reads the marker lane where it pins) plus one
  lane height, caps the sheet to what is left (`--sheet-lane-cap`, never under the pinned chrome plus one touch row (`laneSheetCap`),
  honoured next to the transcript's `--sheet-cap` as the smaller of the two) and
  scrolls the edited lane into that band. It runs again whenever the scroller,
  the slot or the lane changes size, so a rotation that remounts the shell, which
  resets the lane scroller, lands the lane back under the ruler. With the demo
  project's three marker rows the whole 72px lane shows over the sheet at
  568×320 (before the column took the wider sizes it showed at 914×331,
  932×430 and 844×390, over sheets of 174px, 245px and 205px). A software keyboard lifts the
  cap (the sheet takes the visible slot) because the form outranks the lane then.
  On a window at most 40rem tall, in a slot at least 30rem wide
  (`@media (max-height: 40rem)` around `@container sheet-slot`), the sheet is a
  fixed header with a scrolling body: the sheet's own title row, then **Done**
  beside the title on a row of its own that never scrolls, then the body. The long
  help text is readable to a screen reader only, the point form is one row of
  **Time**, **Level**, **Save point** and **Cancel**, and its "Add point" or "Edit
  point" heading is readable to a screen reader only too, so the row of fields
  fits. A tall iPad slot (1194×834, 1024×768) is not that window: it keeps the
  regular form with its help text visible (Playwright asserts both). Opening the
  form on touch scrolls the fields into the visible body, and a resize keeps the
  open form in view. The open point
  draft is store state (`envelopeDraft`), keyed to its project, track and
  point and dropped when the selection leaves that target, so the phone and tablet
  shells swapping on rotation do not lose what was typed. A save in flight is store
  state too (`envelopeSaving`, keyed to the same project, epoch and track), so a
  remount keeps **Save point** busy and does not dispatch a second save; the entry
  clears when the request settles, success or failure. The sheet root pads
  its sides with `env(safe-area-inset-left/right)` so nothing sits under the
  notch or Dynamic Island held sideways; Playwright cannot emulate those insets, so only
  a real iPhone proves them.

Measured in Playwright WebKit with the iPhone 17 Pro Max descriptor, the touch
grammar on and the timeline maximized (px of lanes above the rail or the strip;
2-track demo, so capacity is usable height over lane height). The After column
was measured again after rebasing onto main with the edit modes (#1154), and
its strip-closed rows once more after rebasing onto the #1161 navigation work,
when the rail's Select/Blade track grew 6px to hold its 44px buttons (the
strip then covered the rail, so its rows did not move; round 9 moved the strip
above the rail, see below); the strip shows a tapped clip's name and span:

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
40rem wide, so the rail stays one 67px row at 440, 390 and 360px.

At large text the rail stays one row too (#1347). A rail narrower than 23rem,
which is every phone at 200% text, keeps its tools in `.editing-tool-rail-tools`
and scrolls them sideways instead of wrapping them into rows that eat the lanes.
The tools sit in their own box so the scroll does not clip the Undo and Redo
hint, which hangs from the rail above it. `reachability-sweep.spec.ts` holds the
rail to one row at every boundary cell.

On a coarse pointer the track-row clip-light clear sits below the lane's meter,
not up over the Solo button above it, so a tap on Solo's lower corner no longer
reaches Clear clip light. The Add track row, the Listen **Open all** link, the
track sheet's Label, Speaker and Role fields and Select range's In and Out
fields and track checkboxes, and the More tab's overlay toggle rows, all hold the 44px floor (`e2e/touch-floor.spec.ts` sweeps phone, tablet and landscape and names the dense-target exceptions); a native `select` takes it
as `block-size` because WebKit ignores `min-block-size` on one. Transcript
**Find and replace** rows wrap their controls on a
coarse pointer so landscape panels do not overflow (#1433). The sheet back buttons
hold the floor too (#1445). Controls
keep their DOM, form and disclosure state. On touch, in a window under 40rem tall
(`@container app`, so large text counts), the Transcript panel scrolls as a whole
with the list keeping at least 16rem, so its chrome does not cover the rows beneath
it. `e2e-compat/reachability-sweep.spec.ts` sweeps
the Transcript panel and the Prepare stage whole at every cell. The envelope-point select, the effect Bypass toggles and the comment composer's
fields and track picks hold the floor too, and the same sweep measures them (a seeded
track for the first two, the Comments panel on tablet and desktop, and Listen on a phone,
for the last).

In short windows with a fine pointer, Transcript uses less vertical spacing around
its content and hint.

Round 9 (#1181) moved the strip above the tool rail after an Undo tap could
nudge a pending edit. Issue #1205 moves the shared Undo and Redo controls into
the compact inspector header at peek, half and full height, then lets the strip
cover the rail again. Those header buttons use the same authorization,
unavailable-action feedback and `history.undo` / `history.redo` command path as
the rail. The open strip no longer reserves the rail's height from the lane
area. At 32 px root text the header may wrap, but its history, resize and Close
controls remain visible and separate.

`e2e-compat/phone-chrome.spec.ts` checks three 72px lanes at 932×432, Undo and
Redo on both shells, a page that never scrolls under the shell, and the Add to
Home Screen banner (shown in an emulated iPhone Safari tab, gone after Dismiss
and a reload), in Chromium and WebKit. A real iPhone check remains for the
Dynamic Island side in landscape.

Phone chrome is **≤767 CSS px**. DevTools device-mode / CDP viewport override can leave the CSS viewport at tablet width while the OS window is narrower — hard refresh does not clear that; clear the override (or set 390×844) before judging the phone frame.

## Software keyboard and bottom sheets (#1335)

Mobile Safari shrinks only the *visual* viewport when the keyboard opens and scrolls it under fixed elements, so a sheet sized from the layout viewport lost its pinned header, including **Close**, off the top in portrait and after rotation. While any `BottomSheet` is open, `useKeyboardInset` (`gui/web/src/hooks/useKeyboardInset.ts`) reads `visualViewport` and publishes `--keyboard-inset` and `--visual-viewport-top` with `data-keyboard="open"` on `<html>`. `bottom-sheet.css` then fits the sheet slot to the visible area, so the header and **Close** stay on screen and the body scrolls above the keyboard. A pinch zoom (scale above 1) is not a keyboard. When the viewport changes with a field focused inside a sheet, the field is scrolled into view with `focusAndReveal`. On touch input, opening an envelope form focuses its heading rather than a numeric field, so adding a point never raises the keyboard by itself.

**What iOS actually does (#1362, proven with a real software keypad on an iPhone 15, iOS 17.5).** With a field focused, Safari shrinks `innerHeight` along with the visual viewport (659 to 441 px) and then pans the visual viewport by `offsetTop` (218 px) to bring the field above the keypad; the root's `clientHeight` stays 659. A hook that reads `innerHeight - viewport.height - offsetTop` therefore computes a negative inset and never opens. The hook takes the layout height as `max(innerHeight, documentElement.clientHeight)`, calls the keyboard open when the visual viewport leaves at least 80 px of that uncovered (and scale is about 1), and publishes `inset = max(0, covered - offsetTop)`, which covers iOS (pan already hides the top part), Android (`innerHeight` constant, `offsetTop` 0) and the iPad. The non-compact half sheet scrolls as a whole, so with the keyboard open `bottom-sheet.css` pins `.bottom-sheet-chrome` to the sheet's top (`position: sticky`) and `focusAndReveal` reveals fields below it: the scroller's visible bottom is `top + clientTop + clientHeight` of its own box, not the sticky-adjusted top plus its height, and a field keeps a `--space-3` scroll margin above the keyboard. The simulator hides the software keypad when a hardware keyboard is connected; to see it, set `AutomaticMinimizationEnabled` to false for `com.apple.keyboard.preferences` in the device's defaults and relaunch Safari (restore it afterwards). Proof on the PR head: iPhone 15 portrait, light and dark, with Time focused and the keypad up, shows the sheet header and **Close** on screen and the field above the keypad, and tapping **Close** closes the sheet; on iPad Pro 11 (iOS 17.5) the keyboard does not move `innerHeight` or `offsetTop` (`--keyboard-inset` 340 px, `vvTop` 0) and the same fit holds. Landscape on the iPhone simulator is driven with a throwaway XCUITest runner that sets `XCUIDevice.shared.orientation` (the Simulator rotate shortcut needs accessibility access that automation lacks); the Inspector column's landscape keypad proof is below. The landscape envelope sheet (#1694) is proven in Playwright with `--keyboard-inset` and `data-keyboard` set by hand, not with a real keypad: with the keyboard up the sheet drops its lane cap and fills the visible slot (see the lane-band bullet under Short touch screens above). The Inspector column (#1696) answers the keypad differently: with `data-keyboard="open"` it is `position: fixed` with `grid-area: auto` and takes the visible band, `--visual-viewport-top` down by `--visual-viewport-height` (published by `useKeyboardInset`), on the inline end (`bottom-sheet.css`). **Proven with a real keypad (fix round 1).** On an iPhone 15 Plus (iOS 17.5, 932x430) and an iPhone SE (667x375), held sideways, the keypad shrank `innerHeight` (347 to 131 and 325 to 119) and Safari scrolled the page by the visual viewport's `offsetTop` (216 and 206). The first version set `inset-block` from `--visual-viewport-top` and `--keyboard-inset` and left the shell's `grid-area` on the column: the shell is a size container, so Safari resolved the offsets against the column's grid cell, which put the column at the left edge, 52 px low, and on the Plus collapsed it to about 21 px (visual viewport 122 at `offsetTop` 98, `--keyboard-inset` 127). With `grid-area: auto` and the band from the visual viewport itself, both phones show the column on the inline end at exactly the visible band (Plus rect 575,0,298,122 with Close at 817,8; SE 411,0,256,119 with Close at 611,8), with the title, Close and the focused Source start field above the keypad, and **Close** works with the keypad up. Screenshots and the measured rects: `podcast_mcp-session-state/trails/1696/live/fix1-*`. Playwright pins the same arithmetic with hand-set values, including the shrunk-`innerHeight` shape (`e2e-compat/inspector-column.spec.ts`). **Status strip (fix round 2).** With Safari's chrome collapsed after a rotation to portrait and back, the visual viewport can reach the shell's bottom edge (Plus: `innerHeight` 205, visual viewport 205 at `offsetTop` 142, `--keyboard-inset` 0, shell 347 tall at y -142), and the tablet shell's status strip, which stacks above the column (`--z-shell-chrome` over `--z-sheet`), painted over the lower 49 px of the column and the focused field. The shell now publishes `--column-floor` (the home-indicator inset, plus `--status-height` on the tablet shell, `responsive.css`) and the column's `block-size` is `min(--visual-viewport-height, 100% - --visual-viewport-top - --column-floor)`, so it ends where the strip begins whatever the layout height is. Proven on the same Plus after rotating to portrait and back and tapping Source start with the real keypad: column 575,0,298,156 (the strip starts at 156), Close at 817,8, the field at 592,104,88,44 clear of the strip, and Close works; the SE (667x375, no strip) still takes the whole band, 411,0,256,119. Screenshots and measured rects: `podcast_mcp-session-state/trails/1696/live/fix2-*`. `e2e-compat/inspector-column.spec.ts` pins the geometry with hand-set values and fails without the clamp. The landscape envelope sheet (#1694) is still proven only with hand-set `--keyboard-inset` values, not a real keypad. Rotating a phone from the column to the sheet inside one shell (SE 667x375 to 375x667) keeps the typed draft and the focused field on a real device; iOS closes the keypad when the field's DOM node moves, so the field keeps focus and its caret but the keypad needs a tap. A rotation that also crosses the phone and tablet shell (Plus 932 to 430) swaps the whole shell and still loses the draft. After a rotation Safari's chrome left the page offset by 50 px for under a second on the SE; a longer offset of 3 to 20 s (83 px on the Plus, 50 px on the SE) was seen later (#1761). `useViewportPan` (`gui/web/src/hooks/useViewportPan.ts`, mounted in `StudioShell`) publishes a pan that no keyboard, pinch zoom or focused field explains as `--viewport-pan-top` and `--viewport-pan-height` with `data-viewport-pan` on `<html>`, and on the touch shells `layout.css` gives the fixed shell that top and height, so it and the fixed children inside it sit in the visible band. Sheets, dialogs and toasts portaled to `<body>` are not moved; the first touch ends the pan, so none can be opened during it. Safari starts and ends the pan without a `visualViewport` event in some frames, so after a viewport, focus, orientation, visibility or pointer-up event the hook re-reads once a frame while a pan is engaged and for 1.5 s after, writes only when the pan changes, and goes idle after that (#2126). The pan can still show for one frame when the compositor paints the new offset before the page has read it. No transform is used: portaled menus place themselves from `visualViewport.offsetTop` in layout coordinates (`anchoredPlacement.ts`), and a transformed body would count the pan twice. Scrolling the page does not help: `scrollY` stays 0 while Safari holds the offset (measured on the Plus and SE).

iOS Safari also zooms the page when a focused field's computed `font-size` is under 16px, and `useKeyboardInset` reads that zoom as a pinch and stands down (#1354). So under `@media (pointer: coarse)` every `input`, `textarea` and `select` is at least `1rem`. `--font-size-field-min` is `0rem` by default and `1rem` on coarse pointers (`theme/tokens.css`). Field rules size text through `--font-size-field`, `--font-size-field-small` or `--font-size-field-current` (a field that keeps its surrounding size), which are `max(<size>, var(--font-size-field-min))`. A new field rule that sets `font` or `font-size` must use one of them (or `--font-size-review` / `--font-size-heading`, both at least 1rem); `tests/test_css_policy.py` fails otherwise, and `e2e-compat/touch-field-size.spec.ts` checks the computed size in WebKit. Never block zoom with `maximum-scale=1` or `user-scalable=no` in the viewport meta; that removes accessibility zoom.

## Menu popover support

Menu panels use the Popover API (Chrome 114, Firefox 125, Safari 17.0 on iOS 17
and macOS). `ui/Menu.tsx` selects native mode only when both `showPopover()` and
`hidePopover()` exist. Native panels stay beside their trigger and enter the
browser top layer. Without both methods, the menu portals the same panel into
the trigger's `ownerDocument.body`; it omits the `popover` attribute and uses
`position: fixed`, `ui/anchoredPlacement.ts`, and `--z-menu`. The body portal
escapes clipping and containing blocks between the trigger and panel. It keeps
the trigger's computed `--menu-item-min-block-size`, including the transport's
named-container touch size and the phone modifier-footer size. Native Tab order
is unchanged; fallback Tab and Shift+Tab leave relative to the trigger because
the portal changes document order. `--z-toast` stays above fallback menus, and
native menus keep the toast ordering in
[design-tokens.md § Top layer](design-tokens.md#top-layer).

## Phone: five stages + one sheet

```
┌─────────────────────────────┐
│ App header                  │
├─────────────────────────────┤
│ STAGE CONTENT (flex)        │
├─────────────────────────────┤
│ Player bar                  │
├─────────────────────────────┤
│ Record | Prepare | Edit |   │
│ Review | Deliver            │
└─────────────────────────────┘
     ↑ selection → BottomSheet
```

| Stage | Content | Primary jobs |
|-------|---------|--------------|
| **Record** | Launcher with live-take status; the record dialog stays mounted in `DawApp`, so a take survives stage switches | Capture |
| **Prepare** | Import, pipeline jobs, vocabulary | Get audio ready |
| **Edit** | Timeline surface (playhead that starts at 0 and holds the center once passed; Ferrite lane gutter; eye sheet) and Script surface (transcript), switched by an icon pair | Spatial edit, word fix, suggest cut |
| **Review** | Queue (guests: Comments) | Guest review and comments, approve or reject edits |
| **Deliver** | Export, Bounce, Share for review | Hand off |

Guests see only the stages their role allows (`stagesForRole`): a Commenter link is Review alone and has no Stage bar.

The Player bar and the header wrap their controls when one row cannot hold them, which happens at Safari page zoom 200% on a phone and at 200% text. The bar grows with the wrap so the stage content starts below it. Targets stay `--touch-min`. This is not pinch-zoom on the timeline. A physical iPhone Safari 200% Aa zoom remains a Mac-simulator check. Phone menu rows use the 44px touch target and omit keyboard shortcut hints.
**The short fold is a measured fit, not a size threshold (R-short-9).** `useShortFrame` (`gui/web/src/stage/frame/useShortFrame.ts`) folds the frame when its height is less than the full header, the full Player, the tab bar and `--stage-stacked-lanes-min` together (`frameFolds`, pinned in `useShortFrame.test.ts`). The hook lifts the fold, reads the natural heights of `.stage-frame-header`, `.stage-frame-player` and `.stage-frame-tabs` and resolves the lane floor token, then restores the fold in the same task before paint, so the fold tracks text size, header wrapping and the safe area with no `rem` breakpoint. Its only observer is the governed `useResizeObserver`. A folded frame sets `data-frame-short` on `<html>` (system.css and stage-frame.css key on it): the tab bar becomes the header's Stage menu, the Edit rows and the corner (zoom, the eye and, off the phone, the Script toggle) become the header's Tools button and its sheet, and the Player is one touch-height row. The corner folds whenever it would leave the lanes less than their floor (`laneAreaHeight - cornerHeight < lanesMin`), so it never floats over a lane at the floor, as at 844x390. The stacked lanes' floor is capped at the workspace height, so a frame too short even when folded keeps its lanes inside the body, not clipped under the Player.

While `project === null` (progressive load), the frame shows the header and Stage bar with skeleton content and a disabled Player bar ("Loading episode…"). That chrome is not the ingest empty-session coach.

**Commenting (#1338).** Commenting is the job of a Commenter or Editor review link, so the Player bar always carries a comment-at-playhead control and Review holds the list and `CommentCompose`. A guest types, taps **Post comment**, and the **at 0:12** chip shows where the comment lands (the selected range, else the playhead; see [timeline-comments.md](timeline-comments.md#daw-viewer)). A guest's first post asks for a name instead of posting (#2164): a **Your name** field takes focus beside **Post as Guest** (`GuestNameStep`), the typed text stays, and the post is announced in a polite live region ("Comment posted at 0:12") and in the toast, which docks above the Player bar. The name (40 code points at most) is remembered in a guest-only `localStorage` key the host's name field never reads or writes; **Post as Guest** or an empty name keeps **Guest**. A reply uses the chosen name or Guest without asking. The field is 1rem so iOS does not zoom in on focus. On the phone the keyboard lifts the composer above it, and posting closes the keyboard on purpose. A Viewer link shows no composer.
A share link never opens the Inspector by itself: a stored or remote selection whose target is gone clears silently, and no tab, host or guest, takes on another viewer's selection (see [session-sync.md](session-sync.md)) (#1339).

A timeline or transcript range opens the same sheet with **Range fields** as its body on the phone and the tablet (`Inspector` renders `RangeFields`; the tablet no longer draws them in the bar under the scrim). While **Select range** is armed over a clip, track or other selection, the sheet carries the In and Out fields above that selection's inspector (`SelectionSheetBody`, shared by both shells). On a tablet, an agent range moves the existing In and Out fields, selected-track checkboxes and explicit **Use agent range on selected tracks** action into any open selection sheet. The agent range is not adopted automatically. The sheet keeps those controls in one place, including at compact peek, where they appear above the peek inspector and scroll with the sheet body. The selected target and saved sheet detent do not change. Arming **Select range** with nothing selected opens the sheet on the tablet too (#1793), as it does on the phone, so In, Out, the track checkboxes, Select range and Cancel never sit in a card at the top. On the tablet's half sheet that holds only those fields, the sheet is as tall as they are (`bottom-sheet.css`, `.range-numeric`), so the lanes the range is dragged across stay in view. Only the desktop shell keeps them in the transport bar. Selection opens a non-modal **half → full** [`BottomSheet`](../gui/web/src/ui/BottomSheet.tsx) wrapping the desktop inspector views. It retains `aria-modal="false"`, Escape, focus restoration, and an interactive timeline background. It has no Tab trap. **Expand** and **Collapse** change view size only; these actions and **Close** use the sheet-scoped `--touch-min` floor. Only the compact inspector below swipes.

**Split speakers…** is a track-inspector button, so the same sheet carries it on a phone, and the Prepare stage's empty-session hint ("One recording of everyone? Import it, then choose Split speakers.") points there. Its dialog is a bottom sheet with **Split speakers**, **Cancel split** or **Undo split** and **Done** pinned in the footer ([communication-philosophy.md](communication-philosophy.md#terminology) names the terms). After a split, the scrollable result lists saved unsure and overlapping stretches with timeline start, length and speaker tracks; repeated timeline placements have separate **Go to** buttons. A stretch removed from the timeline shows recording time and explains why **Go to** is unavailable. Close the sheet to listen with the lane Solo controls, then choose **Review split…** in that track's inspector to return to the list. The review entry is session-scoped and expires after any saved project edit, including a saved mute change; listen-only Solo keeps it available.

A timeline selection in Timeline mode, or on the tablet shell upright or
sideways (#1871), opens the **compact inspector** instead: a peek strip with the target's name, its key
value and rows of 44 px nudges at the keyboard's steps: a clip's fade or
trim, a pending edit's start and end, and an envelope point's time and level
(for the host and Editor links; Commenter and Viewer links see them view-only). Holding a nudge repeats it,
faster after a few steps, and the run saves as one edit; a held run stops at a
soft boundary (the playhead, a chapter, a clip or pending edge) and a fresh
press goes past it. A trim's strip wears the **Ripple** mark: later clips on
every dialogue track move with it, and a held nudge previews them all. A
ripple trim drag draws the same on every lane it moves: arrows to where the
later clips go and, on the other lanes, the span a shortening trim takes.
While a compact inspector is visible, the covered editing rail is inert and
keeps its layout height. Native keyboard navigation uses the visible inspector
header controls. Closing or stowing the inspector restores rail interaction.
The stowed sheet is inert too; when it returns, its controls rejoin native
keyboard navigation.

The compact inspector is a swipeable drawer (#1051 round 4b): drag its header,
which shows a grabber pill, up or down between **peek** (the strip), **half**
(the full inspector at no more than half the slot) and **full**. The sheet
follows the finger 1:1 on the compositor and re-renders nothing until the
release; then it coasts on the finger's speed to the nearest detent, so a
quick flick opens or closes it fully and a slow drag lands where it was left
(reduced motion lands it without the slide). A second finger drops the swipe, and a finger resting on the drawer counts as a first finger for the timeline's two-finger rule (a second finger's long press on a target arms nothing). **Expand** steps up
one detent and **Collapse** returns to the strip; both stay, named for where
they go ("Expand to full height"). A visually hidden range, "Inspector
height", changes the detent from the keyboard or a screen reader. The title
keeps the target's name at every detent, and the last detent opens the next
selection. A selection the open plain sheet's own form makes (a point saved from a
track's envelope form) stays in that sheet until it closes, so the form keeps
its layout and focus; a tap on the timeline, even with that sheet open, opens
the drawer as usual. In a folded frame the sheet's grabber sits in the
header row and the title shrinks to an ellipsis before the actions wrap, so the
chrome is one row wherever its actions fit one (R-short-11). Where half the slot
cannot hold that one-row chrome and a touch row (`halfDetentFits`, measured from the
slot and the header in `ui/compactSheet.ts`), the sheet has no half detent: Expand
goes from the strip to full, and a stored half shows as full without being
overwritten. Where even the full sheet cannot hold the chrome and a touch row
(`chromePins`), the chrome scrolls away with the body, so the content gets the whole
slot. The header's actions (Collapse, Expand,
Close) wrap beneath the title when they cannot sit beside it, as at 32 px text
on a 390 px phone, so the title keeps a line of its own (at least 8rem wide)
instead of being squeezed to nothing. A slot under 20rem tall, at the strip,
half or full size (a phone held sideways or a small portrait phone at large
text, or a slot the keyboard has shrunk), lets the compact title shrink to 4rem
first, so the actions stay beside it. Collapsing to the strip scrolls the
body back to its top, so the first nudge is not left out of view by the scroll
the taller detent had (#1762). A phone held sideways at 200% text (636×390)
has the strip fill the slot above the mode bar: the title shares the header
row with the actions there, and the nudges are one scroll of the body away,
which ends at the mode bar. The strip leaves the timeline undimmed;
half and full dim it. The drawer's scroll keeps a focused control clear of its
pinned header in Chromium and WebKit. The
timeline scrolls the selection above the strip or sheet, and any timeline drag
stows it until release. A touch screen held sideways under 40rem wide (568×320)
gets the same compact inspector in place of the bottom tabs; at 40rem wide and
up the Inspector is a [column](#browser-chrome-safe-areas-and-home-screen-1077)
instead, and a mouse window of that size keeps the strip. Its name,
**Expand** or **Collapse** and **Close** stay pinned at the top while the
expanded inspector scrolls, and the strip docks above the nav or status row
beside it (`--z-sheet-docked`). The open inspector covers the tool rail, which
is inert; Undo and Redo stay visible in the pinned header at every detent. The
editor page never rubber-bands. Decision and
measurements: [touch-editor-decisions.md § Compact inspector](touch-editor-decisions.md#compact-inspector-1051-round-3)
and [§ Collapse stays in reach](touch-editor-decisions.md#collapse-stays-in-reach-1051-round-4).

On touch, a direct long press on a fade or trim handle may open Auto precision;
envelope points, pending edges, and chooser chip grabs keep the grammar drag.
**Auto precision** (#1184) then opens a jog pad in the drawer's place when the
target or its neighbour is narrower than a finger, or drags directly on the
timeline when a step is already at least 4 px wide (slower finger motion moves
finer steps). Slide up on the pad to slow the move; **Done** or a tap outside
finishes. A second finger cancels. Detail: [touch-editor-decisions.md § Auto
precision jog pad](touch-editor-decisions.md#decision-auto-precision-jog-pad-on-touch).

The compact header uses the strip's vertical spacing at every detent. At
667×360 with 32px root text, the full sheet keeps room below its wrapped
history and resize controls for a complete fade field and label. Native Tab
reveals a fitting label with its field below the pinned chrome. Ordinary
sheets retain their existing header spacing.

Ordinary noncompact modifier inspector sheets and range-armed ordinary noncompact sheets use one scroll owner for their content, including sheet chrome, actions, fields, errors, related commands, and audition footer. The content has natural height, so enlarged headers cannot compress a separate field scroller. Scroll to the top to reach **Expand**, **Collapse**, and **Close**. Compact modifier sheets keep the header pinned outside their bounded body, where feedback and fields share the body scroller. Desktop modifier inspectors also scroll as one aside; their fields and errors flow with the header and footer. Envelope focus transitions reveal the current control within its sheet or inspector without scrolling the page or timeline. The taller half peek applies to ordinary noncompact modifier inspectors and range-armed ordinary noncompact sheets. Sheets remain transient with no stacking. Deferred mutation errors across shell remount, Firefox layout CI, and overlapping Approve remain in [ROADMAP.md § Follow-up](../ROADMAP.md#follow-up).

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
scrim dismissal leave More open and restore focus to its literal Mix trigger.
Close initially receives focus when the sheet opens. The shared
`openerControl` fallback uses the last clicked control when a browser leaves
focus on the page body or a container around that control. The existing
`e2e-compat/phone-mix.spec.ts` core flow also checks the pointer case where
the Commands and shortcuts row held keyboard focus.
Navigation keeps focus on the chosen nav control. Project, follow, destination,
selection, or range changes invalidate Mix permanently; returning to More does
not reopen it. Mix and Inspector share one keyed sheet. Gestures closes Mix
before opening its existing dialog. Other global dialogs also
invalidate Mix, and so does Bounce, which goes to Deliver. Committed writes continue through the shared
mix queue after closing. A swipe overlay remains deferred.

`e2e-compat/phone-mix.spec.ts` checks pointer opening after Commands and shortcuts has
keyboard focus, the initial Close focus, restoration after Close, Escape, or
scrim dismissal, and keyboard navigation away from and back to More. These
focus scenarios run in the existing core flow alongside its native mix edit
and touch geometry checks.

Inspector sheets keep the timeline interactive behind them: their background scrim is decorative and pointer-transparent, so a phone user can drag a pending edge or tap the ruler without closing the inspector. A blank ruler tap seeks and clears the current selection. Confirmation sheets, including the blade-cut confirmation, keep a dismissible outside scrim; Close and Escape remain available for both sheet types.

Pending timeline edits use the same lane-wide region on phones. A selected region shows 44px start/end touch targets only when its drawn width is at least 44px and the lane leaves room for both targets. For a narrow region or compact lane, the edge handles stay hidden on touch; the selected action card offers **Edit timing**, which focuses the existing Source start field in the inspector. Outside compact-inspector mode, the card floats below or above the lane without covering the region or adding horizontal timeline scroll; while the tablet's regular inspector sheet is open it stays out of the canvas, and the sheet's own **Approve** and **Reject** carry the review. Whenever the compact inspector is open, the same card moves into its pinned header. **Approve** and **Reject** stay visible there, while the strip's Start and End rows hold timing and **Expand** opens the fields. The pinned header keeps **Undo**, **Redo**, **Expand**, **Collapse**, and **Close** reachable as the inspector body scrolls. Long recovery messages scroll inside the card. Dense unselected cuts reveal a floating label on hover or keyboard focus, and labels follow zoom and responsive layout changes. The Review Queue lists the pending edits that need review, and its Cut all is limited to review-required edits.

Coarse-pointer timeline lanes keep a minimum height of 104 canvas pixels, matching the compact header floor already used by the phone timeline. A short screen (a phone held sideways) is the exception: lanes drop to 72px so three fit (see [Browser chrome](#browser-chrome-safe-areas-and-home-screen-1077)), and the hit router's crowded-target chooser resolves the tighter targets. The lower seam roll target is 48 canvas pixels high and at least the shared touch target width. It stays below the fade corners and inside its clip, while the join glyph remains in the top gutter and the crossfade endpoint control uses its separate rail below the timeline.

On phones, Pipeline step parameters open in the shared modal Dialog. Escape and
Close dismiss it and return focus to the selected step; Tab stays inside the
dialog. Tablet and desktop keep the parameter form inline. An open modal dialog
holds every app shortcut (`ui/modalGate.ts`), as the native `confirm()` did:
Escape closes the dialog and does not also clear the selection, and Mod+Z,
Space or Delete do nothing behind it, so an in-app confirm over the Inspector
neither undoes nor removes anything while it asks. An open peek sheet also
holds Escape: `overlayOpen()` skips keymap `edit.clearSelection`. Every `Dialog` is a bottom sheet on phone and tablet (a tablet sheet keeps a
42rem measure) with its primary pinned in the footer; the split asks
`askConfirm` ("Cut at 01:23.500?") on both shells, and the People list on the
phone More sheet is a `Menu` behind a "People · n" button.
Inspector dismiss still clears the clip selection. A remounted Inspector
sheet stays under a still-open JoinPopover and does not steal focus from
a docked waiver field. A new sheet still takes Close after deferred
envelope first-entry.
Typing, Tab and Enter inside
the dialog stay native. A modal can hand on named shortcuts; the Record room
hands on M for a live marker. On close, focus returns to the control that
opened it (`ui/pressedControl.ts`: the focused control, or the one just
clicked, since Safari does not focus a clicked button).

### Feedback toast

Single pending-edit **Approve** and **Reject**, from either the inspector or
the timeline action card, answer with "Approved 1 pending edit" or
"Rejected 1 pending edit" and the command's guarded toast **Undo** when an edit
changed. A zero-effect reply says "No pending edits were approved" or
"No pending edits were rejected" without Undo. A queued send keeps "Still
sending." without Undo. A refused structural edit does not announce
approval before the decision completes; confirmed approval then uses the same
result feedback and guarded Undo.

The app toast (`feedback/FeedbackToast`) has one message, optional guarded Undo,
and explicit Dismiss. Compact composition puts its host first inside the same
scrolling body as the fields. The pinned header stays outside that scroller.
The compact half and full detents keep the same outer height with or without
feedback. Dismiss removes the card without changing the detent height or lane
room.

Feedback and a full native label can exceed the available body height at large
text sizes, so ordinary body scrolling reveals them in turn rather than sharing
a reserved row. Field focus reveals the control and its complete label below the
pinned header when the label fits in the bounded body. A saved edit preserves
the focused or just-pressed control. Undo, Redo, resize and Close stay fully
visible and on top before and after feedback, field focus and body scrolling.

`FeedbackToast` moves one stable portal container between this body and its
ordinary floating host. The same `Toast` card keeps its eight-second timer,
focus and hover pause, disabled-Undo pause, Dismiss and history freshness.
A presentation-boundary intersection observer pauses expiry whenever the card
is clipped by its actual ancestors. Toast retains the remaining visible time
through every pause and host move. An oversized card stays paused while the
user scrolls through its message and actions. Host changes do not restart the
timer or remount Undo. Closing or stowing a compact
inspector returns feedback to the floating host, outside the inert rail.
An intentionally focused Undo or Dismiss keeps its native identity when the
phone and tablet inspector hosts remount. Sheet entry focus and the volume-envelope
view's first-entry focus yield to that action. Dismissing it, or this tab's own
undo removing or disabling Undo, or another client's edit removing it, returns
focus to the current usable inspector Close, whether the card sits in the sheet
or floats above it. A selection that arrives from another client or the agent
is not this person's navigation: it swaps the sheet, and the focused action
moves with the card. A sheet that remounts behind an open modal stays below it and does not
take focus from it; when that modal closes and its own return target is gone,
the sheet's Close takes focus. A host move that drops a focused action without
a blur, such as into a modal-covered or stowed host, resumes the toast timer.
The person's own selection, project, or outside-control navigation cancels the remembered
action.
Other workflows retain the existing floating dock. Placement uses the actual
card's horizontal footprint. Comment fields, the latest pressed control and Play
affect vertical placement only when they intersect that footprint. A desktop
comment composer beside the card does not lift it (`feedback/toastDock.ts`,
#2221).

On phones the dock measures bottom chrome, the latest pressed control and
Listen's Play row. When a clear position fits, the card moves above Play, or
below when there is no room above, on a short phone such as 320x460 where the
dock spot would land on Play (#1960). Its full-sheet fallback can cover scrolling
content in those other workflows. Desktop and ordinary tablet feedback rests
above the status bar.

On every shell, visible parts of the comment composer, the **Commenting as**
line, its **Change** field and the guest name step take protection priority when
they intersect the card's horizontal footprint. The dock moves the card above
or below them when a clear position fits, including above the top chrome when
needed (#2199, proven at 844x390 and 390x340 in
`e2e/comment-toast-clearance.spec.ts`). These viewport tests do not establish
native software-keyboard, visual-viewport panning or Safari behavior.

If no clear position fits, the existing resting fallback can cover a control.
At 320x300, the measured 62 px failure card cannot fit in the 53 px band between
Play and the comment composer (#2221). Dismiss the card or enlarge the window
before using the covered control.

Compact half and full detents keep the same outer height when feedback appears.
The shared body scroller exposes feedback without taking more timeline room.
At enlarged text in short slots, the existing minimum chrome height can leave
no ruler or lane room. Feedback does not change that baseline. Native focus
outlines inside compact controls use an inset offset, so fitting controls and
labels retain their painted indicator at the body clip edge. The detent range
continues to show focus on its visible grabber. Floating feedback also pauses
its clock when the whole card is outside the viewport or clipped.


Regression checks assert header reachability before any recovery scroll at
every compact detent. They measure feedback and all active controls and native
labels against the viewport and every overflow ancestor, then compare their
visible intersections. Ordinary body scroll must expose feedback actions when
they cannot coexist with a focused field. Feedback's own actions are checked
for target size and hit ownership separately. Time and Level changes each prove
complete saved arrays through Undo and Redo. The no-feedback strip retains the
ordinary lane measurements.

### One selection surface table

`gui/web/src/inspector/selectionSurface.tsx` holds `SELECTION_SURFACES`, a table keyed by every selection kind (`range`, `transcriptRange`, `clip`, `pending`, `applied`, `track`, `chapter`, `social`, `comment`, `envelope`, `envelopePoint`). Each entry supplies the inspector `body`, the screens where the selection opens the sheet (`screens`), its `peek` actions, its `related` commands and its `more` destination. A tapped word is a one-word `transcriptRange`. `Inspector` (the desktop aside) and `SelectionSheetBody` (the sheet on the phone and the tablet) both render from it, and `useSelectionSheet` (`stage/edit/useSelectionSheet.tsx`) holds the one open rule: the phone and the tablet each name the screen they show (the phone's mode, the tablet's layout) and open on Inspect (I, the Inspect verb or a double-click on a clip: `inspectorKey` in the store, derived from the selection so a new selection, Esc or Close shuts it) for a selection whose kind lists that screen, or on an armed **Select range** on the phone and the tablet; the desktop's column follows the same Inspect rule. Selecting alone opens nothing: the Action bar (`stage/edit/EditActionBar.tsx`) carries the verbs, floating on the tablet and the desktop and docked above the Player on the phone. A new selection kind that is missing from the table fails to compile.

The sheet body is the same on both touch shells: Select range's In and Out fields while armed, the selection's inspector or compact peek, then the three-zone commands below. On the tablet, a session region keeps the **Range fields** in the sheet for every selection kind that does not already contain a selected range. The controls remain in the sheet at compact peek, above the peek inspector. The transport bar keeps one copy only on the desktop shell. This keeps the agent's range out from behind the sheet scrim, where the tool rail cannot arm **Select range** (Ledger on #1445). `selectionSurface.test.tsx` covers each selection kind and checks whether agent-range adoption applies. The related and more zones take the inspector's gutter inside the sheet (`e2e-compat/selection-sheet-zones.spec.ts`). `e2e-compat/reachability-sweep.spec.ts` measures every interactive element at the boundary sizes and text scales (see [testing.md](testing.md)).

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

| Old home | Phone home now |
|----------|----------------|
| Listen hero (play, time, scrub) | Player bar on every stage; swipe up for the Player sheet. Guests and passive listening land in Review |
| Mode nav (Listen, Timeline, Text, More) | Stage tab bar: Record, Prepare, Edit, Review, Deliver (`stage.*`, Mod+1 to Mod+5). Edit holds the Timeline and Script surfaces behind a waveform and text icon switch; selection and playhead carry across |
| Comment / Fit | Comment at the playhead in the Player bar; Fit in the Edit corner |
| Track headers M/S/FX | Lane gutter tap (the whole rail; the initials chip is the affordance) → track sheet (**M**/**S** toggles and the saved **Volume** fader; drag the Volume envelope layer for envelopes). The mix sheet adjusts all tracks without changing selection. Header mixer chrome is hidden when the timeline pane is narrow; reorder by dragging the header or the track sheet's Move up and Move down. On a tablet with a coarse pointer the wide header's **M** and **S** are 44px touch targets like the track sheet's (#1028) |
| Timeline overlays (layer chips) | Eye sheet in the Edit corner |
| Inspector | Selection sheet |
| Transcript tab | Edit → Script surface |
| Comments | Review → Comments, and the comment field in the Player |
| History | Edit → History sheet (right-click the header's Undo, or the palette) |
| Queue / Tighten | Review sections |
| Pipeline | Prepare |
| Command palette (`?`) | Header search button, or `?` and `/`; opens as a bottom sheet with Search focused |
| Theme | Project menu → Appearance |
| Status bar chips | Stage bar badges (Review count, Prepare running or needs you, Record live, Deliver ready); **Mix out of date** is the Player bar mix ring (**No mix yet** when nothing is rendered), and a new empty project stays fresh |
### Gestures

Touch gestures for common actions, documented in the **Gestures** cheatsheet (Commands and shortcuts → Gestures). It is an app-level modal (outside inert app chrome) and can switch directly to **Commands and shortcuts**; that dialog links back to Gestures without stacking. Two-finger Undo is an optional ShareCut shortcut, not an iOS system convention; the app header has visible Undo and Redo, and the Edit stage has the History sheet. Pinch zoom remains available, and it never edits: a second finger on the timeline cancels any one-finger drag or press in progress without saving it and puts the selection back ([decision](touch-editor-decisions.md#pinch-never-edits-1051-round-4)). Timeline editing follows the [touch input grammar](touch-editor-decisions.md#decision-one-touch-input-grammar-for-timeline-editing): one finger moving scrolls and never edits, a tap selects, a long press arms a target (the chooser when targets crowd) and only an armed target drags, along its own axes, with a brief detent at each soft boundary; a long press on a movable clip's body, away from its handles, arms the clip, which then moves in time within its lane and bumps at the session start; a long press on empty timeline space opens the create menu (split here, add chapter, add comment, add envelope point), with each entry the link cannot run disabled beside its reason ([round 4b](touch-editor-decisions.md#touch-grammar-round-4b-1051)). Every timeline target kind's touch, drag and key behaviour comes from one contract, `gui/web/src/timeline/inputContract.ts`. Visible command routes remain available for the shipped gesture shortcuts; the cheatsheet lists only shipped gestures. Remaining non-drag edit alternatives are tracked in [the touch-editor decision record](touch-editor-decisions.md). Gesture thresholds (hold time, touch slop, click-versus-drag distances, drag detent, drawer swipe and flick, ghost-click window, double-tap gap, swipe distances and drag cap) live in one module, `gui/web/src/hooks/gestureConstants.ts`, which every gesture reads. The hold is 500 ms and a held finger may drift 10 px, after iOS's long-press defaults (0.5 s, 10 pt) and inside Android's (400–500 ms, 8 dp touch slop); the module cites the platform sources. Long-press selection varies by target (clip, comment, track, or transcript word), so it is explicitly exempt from a single command ID; each target keeps its existing selection or correction action.

- **Long-press** (`useLongPress`) selects a comment or track and opens the existing inspector sheet; on a transcript word it opens correction, and in Select mode a hold followed by a drag selects a word range instead (`transcript/useWordRangeDrag.ts`: one finger moving before the hold scrolls, a second finger cancels, a hold that does not move is still correction). The Range fields carry **Add word before / after** and **Drop first / last word** (hold to repeat) for every shell, and the sheet never covers the selected words: the transcript, then any scrolling ancestor, scrolls them clear of the sheet's real top and the visual viewport (the toolbar's Add to Home Screen banner and the iOS keypad both shorten it) and the list gains room under its last turn (`--sheet-clearance`). When no scroll can lift them clear, the half sheet shortens to sit under the range (`--sheet-cap`, never below one readable strip) and its body scrolls. The same sheet carries **Ignore** / **Restore** for the range (host only), with a toast Undo. Every hold-to-repeat button shares the `hold-repeat` class (`user-select: none`, `-webkit-touch-callout: none`) from `useHoldRepeat`, so iOS draws no selection handles or loupe on a held Words button. A timeline touch selects a clip only on a tap and never while scrolling (see [touch-editor-decisions.md](touch-editor-decisions.md#touch-target-chooser-1051)), so clips have no separate recognizer and a hold never reselects or collapses a multi-selection. Movement, cancellation, and a second finger (even on an element that stops propagation) abort it. It fires on release and consumes the synthesized click; a press whose click never arrives is flushed by the next pointerdown rather than dropped. On coarse pointers, transcript words and comment headers set `user-select: none` / `-webkit-touch-callout: none`, and the native context menu is suppressed while a press is armed, so the OS selection UI does not claim the hold. Physical iOS/Android verification is still required; CDP touch in CI does not trigger native selection.
- **Double-tap word**: the first tap seeks immediately (no added latency); a second tap on the same word within the double-tap gap opens correction. `.transcript-list` sets `touch-action: manipulation` so browser double-tap zoom cannot eat the second tap. On desktop, a host's double-click opens inline word editing instead (the first click still seeks); touch double-tap keeps the correction sheet. The navigate-mode hint under the transcript toolbar follows the pointer: coarse pointers read "Double-tap a word to correct its text…" and fine pointers get the inline Enter/Esc hint. The split is deliberate: the sheet leaves room for the on-screen keyboard and keeps Suppress and phrase (End index) correction one tap away, which a chip-sized inline input cannot. Both paths submit through `submitWordCorrection` (`gui/web/src/transcript/wordCorrection.ts`), so they cannot drift.
- **Word correction from a gesture is scoped to that gesture**: it switches the panel to Correct only while the word sheet is open; closing restores the previous mode (and a Select range). Gestures only open correction for hosts with hydrated words — guests and unhydrated transcripts keep tap-to-seek and never enter Correct.
- **Swipe left** invokes `comment.resolve` through the shared comment mutation path for an open comment in the comments list (hosts only; opt-in via `swipeToResolve`, so embedded threads such as the pending-edit Ask thread never resolve from a stray drag). It gives up on vertical travel, must finish before a long-press would, and the card keeps `touch-action: pan-y pinch-zoom`. Controls inside the card (checkbox labels, links, inputs, reply rows) keep their own behavior. While the drag is tracked, the card follows the finger leftward, capped at 2× the resolve threshold, and a `Resolve` cue fills the gap it opens; the cue switches to the accent style once travel reaches the threshold, exactly when release would resolve. The card snaps back on release, vertical travel, pointer cancel, or a hold past long-press, so the cue never shows for a swipe that cannot resolve. With `prefers-reduced-motion: reduce`, the card does not move; the cue instead overlays the card's inline end. Resolving from either the swipe or the footer **Resolve** button shows an Undo toast (`Resolved comment at <time>`, shown through the shared feedback toast and spoken once by the shell's status region, 60 s auto-dismiss like every Undo toast, paused while a mouse or pen hovers it, while focus is inside it, or while Undo is disabled by another pending comment change; touch contact does not pause it). Only the latest resolve has a toast: resolving another comment replaces it. **Undo** reopens the comment and moves keyboard focus to the Comments panel (including when the browser blurs Undo to the page body while it is disabled during the reopen request); reopening from the card's **Reopen** button still works after the toast is gone or was replaced.
- In **Review → Comments**, selecting a comment (tap, long-press, or posting a new one) opens the Inspector sheet, matching the Player. In **Review → Queue**, Open in Edit on a pending edit selects it on the Edit stage; Inspect (I or the bar's Inspect) opens the Inspector.

The Comments panel owns its scroll area so the Undo toast stays reachable while
the list scrolls. Closing a focused toast returns focus to the panel with
`preventScroll`. Browser regressions cover desktop and phone in both themes,
plus one Chromium and WebKit phone flow. They measure Dismiss separately from
Undo because removing or restoring a row can change list layout. Physical iPhone
and iPad Safari checks remain pending.

Two-finger Undo is active only while a project is loaded and the shared Undo command is available. Its recognizer yields to timeline pinch/rotation and rejects delayed, moving, or cancelled contacts so zooming does not also undo an edit.

| Gesture | Command | Status |
|---------|---------|--------|
| Two-finger tap | Optional ShareCut Undo shortcut | Available when project Undo is available |
| Long-press | Select a comment or track and open its sheet; correct a transcript word (hosts) | Available |
| Pinch | Zoom in/out on timeline | Available |
| Swipe left on open host comment (Comments panel) | Resolve (Undo toast follows) | Available |
| Swipe right on a comment card (Review queue, phone) | Resolve (Undo toast follows); left does nothing | Available |
| Double-tap word | Correct word (hosts); first tap seeks | Available |

## Wireframes (ASCII)

### Phone — Review (the old Listen)

```
┌─ Project   save   ↶ ↷   1 avatar +2 ┐
│ Queue                                 │  ← Review (one section)
│ ● 04:12  “level feels low”            │
│ ○ 11:02  “cut cold open?”             │
├─ Player: ▶ 12:34   Hear original ────┤
├─ Record | Prepare | Edit | Review | Deliver ─┤
```
### Phone — Timeline (fixed playhead)

```
┌─ Play  12:34 / 58:39  [Fit] [⋯] ──┐
│ Pending edits Volume envelope Markers Comments │  ← chips
│ ┌─ref│░░░░░░░░░░░░░░░░░░░░░░░░░░ │ │
│ │gue│░░░░░░░░░░░░░░░░░░░▼░░░░░░ │ │  ← slim sticky gutter + CapCut ▼
│ └────┴───────────────────────────┘ │
│         drag timeline to scrub    │
├─ Record | Prepare | Edit | Review | Deliver ─┤
│ ┌ sheet: track / Pending cut ─ X ┐ │
│ │ M · S · Volume / Approve       │ │
│ └───────────────────────────────┘ │
```

The timeline loads with time 0 right after the track headers and the playhead on it, with no empty gap, even though that is left of center (#1707, Caleb's call of 2026-10-17; it replaced the always-centered line of #385). The playhead is the line at its true place in the view. Playback moves it right until it reaches the center, then holds it there and the timeline scrolls under it (the usual follow behavior). A drag moves the content and the time by the same amount, so the playhead stays where it is under the finger. The time column is padded by half the time viewport before 0 and a whole viewport after the end (`--timeline-lead`, `--timeline-lead-end`; `fixedPlayheadLeadPx`, `fixedPlayheadEndLeadPx` in `gui/web/src/utils/timelineViewport.ts`), so a scrub can put any time under the playhead wherever it sits. The pads are only reached by scrubbing past an end; a load, a seek, a fit and playback never show them.

- **Logical scroll.** Store `scrollLeft` is logical: time × zoom from the column's left edge, down to −lead. A load starts at 0. `TimelineView` converts at the DOM edge (`logicalToDomScrollLeft` / `domToLogicalScrollLeft`), and the scroll before 0 is dropped when the view unmounts.
- **Where the line sits.** `fixedLineOffsetPx`: the playhead's time × zoom minus the scroll, kept inside the time viewport. The line (`FixedPlayheadNeedle`, `--timeline-fixed-line`) is drawn there, so it reads the transport time at all times.
- **Follow.** `FixedPlayheadRecenter` scrolls only when the playhead passes the center or leaves the view, never to a scroll before 0, and does nothing for a session that fits the view. Mounting the Timeline tab follows a playhead that moved while it was away.
- **Seek is instant.** A seek (ruler tap, jump, Stop) writes the scroll in the same frame, with no animation: the playhead goes to the center, or stays left of it near the start (`followScrollLeft`). A scrub is also an audio seek, but the view is already where the person put it, so the recenter skips that revision.
- **One measurement.** The scroller's time viewport (`clientWidth` minus the header column, the same source as fit commands, zoom anchoring and presence) sets the fit, the lead pads, the line and the center math. A `ResizeObserver` on the scroller and the header column only triggers a re-measure, and the fit reruns only for a new width or session length. A classic scrollbar's gutter therefore can't shift the line. Fixed-playhead scrollers reserve no empty gutter, because Chromium shortens the scroll range by the gutter width and the end became unreachable.
- **The session end is geometry.** A fixed-playhead canvas is exactly the session (`fixedPlayheadCanvasSize`), even below fit zoom, and the largest scroll (`maxLogicalScrollLeft`) puts the session end at the left edge, so scrubbing stops at the end and the end pad shows beyond it; nothing is written back during a drag or fling.
- **Only a person's scroll seeks.** Fit, recentering and follow writes are programmatic; a late scroll event that lands on the last written position is their echo. A person's scroll moves the time by exactly what it moved the content, sub-pixel moves included, so a slow drag does not drift from the finger.
- **Resize preserves navigation.** A browser clamp before the new columns are measured does not seek or stop Follow. Once measured, DOM and store scroll agree with the available range. A pan constrained by tablet layout is restored on phone return unless deliberate navigation, a seek, Fit, project switch, playback movement, or the end of its recording preview has replaced it.
- **Recording preview can extend the pan range.** While a take is recording or paused, phone users can pan past the saved-media end to see its provisional needle. Panning in that visual-only range leaves the saved-media playhead and seek bounds unchanged. The scroll handler and follow use one saved-end check with the line position from before the pan. That pan remains visual-only through pointer zoom, viewport resizing, unrelated renders, and leaving and returning to Timeline. An explicit seek, playback movement, project switch, or Fit ends the retained visual-only pan and uses the existing follow policy.
- **Zoom.** Fit starts at time 0 with the whole session in view, the playhead at its place in it. Command zoom (menu, keys) keeps the playhead's time and its place in the view, and never opens a gap before 0. Pinch and Ctrl+wheel, claimed anywhere on the timeline except the track headers, keep the time under the fingers still within the session, and the playhead takes the time now at its place in the view. The correction completes before paint, so the needle does not display the previous time at the new zoom.

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
├─ Record | Prepare | Edit | Review | Deliver ─┤
```

### Tablet and desktop — Edit

```
┌─ Project  save  Undo Redo │ Record Prepare Edit Review Deliver │ people ─┐
├───────────────────────────────────────────────────────────────┤
│ Headers │ Timeline (moving playhead) │ Script ┊ │ Inspector column  │
│         │ [Range] [Fit − + Script 👁]       │ (wide only)       │
├───────────────────────────────────────────────────────────────┤
│ Player bar                                                        │
└───────────────────────────────────────────────────────────────┘
```

### Desktop — Script and Timeline

Layout presets (`layout.default`, `layout.timeline`, `layout.text`, `layout.review`, Mod+1 to Mod+4 and View › Layout) were removed with the splitter and the bottom dock tabs. **Show or hide Script** (`T`, `view.toggleScript`) and **Script focus** (`Shift+T`, `view.scriptFocus`) replace them, and the Script and Timeline divider is dragged or moved by keyboard (`ScriptDivider`). Review and Comments are the Review stage, not a layout. Mod+1 to Mod+5 now go to stages; a browser tab may keep them for tab switching (the desktop app does not), so click the Stage bar there.

The frame grid uses named rows (`header / banners / alerts / body inspector / player / tabs`); stages only change what the body holds, so banners and the Player bar never move (`stage/frame/StageFrame.test.tsx`).
## Interaction principles

1. One job per phone screen (no timeline + full transcript + inspector).
2. ≥44×44pt targets; fade/envelope hit areas ≥2× visual width.
3. Sheets: Close + dismiss; never stack.
4. Dialog overlays cap to `90dvh` with a single `.command-palette-body` scroller. Native Menu panels use the top layer; API-unavailable menus portal the same panel to `document.body`. Both use `ui/anchoredPlacement.ts` (#1372): below the trigger, flipped above when that side has more room, and clamped `--menu-edge-margin` inside every visual viewport edge. They cap to `min(90dvh, var(--menu-available-height))`; the cap is re-measured every frame while open so a banner row cannot leave it stale. Panels scroll internally so every item stays reachable on short viewports. The `.ui-menu-root` keeps row sizing in `--menu-item-min-block-size`; the named transport container sets the touch size, which fallback placement copies from the trigger. Phone modifier-footer menus also use the touch size. The active phone navigation item keeps a transparent tab with an accent label and accent top indicator (the platform tab-bar convention for the current location); its state transition is disabled for reduced motion. The centered phone playhead uses `--color-timeline-playhead` so it remains visible in the dark timeline well.
5. Snap only to on-screen anchors.
6. Listen-first: every edit surface keeps the Player bar and a seek footer.
7. Progressive complexity via `shareMode` capabilities.
8. Waveforms paint at a DPR capped at 2 (`paintDpr`, on a 1/8 grid). The phone shell uses smaller waveform caches: 48 MB of bitmaps and 32 MB of data tiles, against 128 MB and 64 MB on desktop ([waveform.md § Renderer](waveform.md#renderer)). Guests on phones draw from pyramid tiles only, never raw PCM.

## Player bar and Edit corner

The transport bar, status bar and tool rail are gone (#2292), and the Edit tool strip followed in #2294 (W1a): touch has no Alt, so the Split verb for touch arrives with the action bar in W1b; W1b adds the visible Split button, the S key and the create menu's Split here. Alt-click Split is mouse only. Their jobs moved
to three places, on every shell; there is no narrow or collapsed variant to
test any more.

| Piece | Where | Holds |
|-------|-------|-------|
| App header | Top, 48px (phone: 44px under the safe area) | Project menu (All projects, Settings, Connect agent, Help, Appearance), save indicator, Undo and Redo (right-click Undo opens History), people (`AvatarStack`; phone: one avatar plus a count), Invite for hosts, search; the Stage bar sits centered on desktop and tablet |
| Stage bar | Header (desktop, tablet) or the bottom tab bar (phone, 56px plus safe area) | Record, Prepare, Edit, Review, Deliver with badges, on Mod+1 to Mod+5 |
| Player bar | Above the tab bar, 56px, every stage | Play and Pause, time, edited length, **Hear original**, the mix ring, the Solo chip, comment-at-playhead |
| Edit corner | Timeline corner (`EditCorner`) | Range arm (touch only, 44 px; the Select/Blade tools, Comment mode and Cut at playhead buttons are gone, #2294), Fit, Zoom out and Zoom in, the Script toggle, and the eye (View options), which opens the View sheet (layers, waveform scale, amplitude, track height, zoom) |

- **Hear menu.** Long-press (touch) or right-click the Hear original button for Full mix (default), Without mix processing and Original. Guests get the mix only. `render.refreshMix` is in the palette and Deliver.
- **Zoom (#1028).** Zoom out and Zoom in (in the corner) run `view.zoomOut` and `view.zoomIn` on the command bus, the same steps as `-` and `=`. At a limit the button is `aria-disabled` with its reason, not `disabled`, so a finger can still tap it and focus stays. Zoom shows for everyone who can open the timeline.
- **Touch targets.** The corner packs its controls into the 48px chrome; buttons are 28px there, below the 44px floor. This is a known limit; the Player bar and tab bar keep `var(--touch-min)`.
- **The phone sheet never covers the header row** (R-short-8). At every detent its slot starts at the header's bottom edge (`bottom-sheet.css`, `--app-header-height-phone` plus the top safe area), so the Stage menu and Tools button stay reachable while a selection is open, including at 200% text. The clearance tokens then count only the rows under the header (`--sheet-header-clearance` is 0 on the phone).
- **Split** is a confirm sheet on touch (tracks and timecode), as before; the sheet rests above the tab bar and Player (`--frame-bottom-chrome`).
- **Undo and Redo** live in the app header on every shell. When the compact inspector is closed they are not repeated in the strip.
- The `--mobile-nav-height`, `--tabs-height` and `--status-height` tokens are replaced by `--frame-bottom-chrome` for sheets, jog and toast offsets.
- The host recording chip is a Record-stage badge on the Stage bar. **Solo on · Clear solo** is the Player bar's Solo chip, 44px.
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

- Project menu Appearance row and eye sheet (theme, layers, zoom; add chapter at the playhead is `edit.addChapter` in the **+** menu)
- Script toggle (`T`, `view.toggleScript`) and Script focus (`Shift+T`, `view.scriptFocus`) instead of layout presets
- Wider invisible hit targets for fades/envelopes
- Status that opens its panel: the Player bar mix ring and Review/Prepare badges on the Stage bar
- Capability-aware chrome for guests
- Pinch-to-zoom on timeline (all shells; spatial claim on `.timeline-scroll` + shared `applyAnchoredZoom` with keys; browser page-zoom does not fight); **the phone-only playhead that holds the center once passed (#1707)**
- Follow: tablet slaves viewport like desktop (People in the header). Phone is listen-along — the Follow banner is its own frame row (`stage-frame--following`); scrubbing the Player unfollows; Timeline colors the phone needle and still draws other ghosts (never the local guest, whose share WS id is `guest-{token}-…`). Touch floors are `var(--touch-min)` in rem via `@container app` (banner, sheets) and `@container transport` (Project menu rows), not `@media` viewport queries.
- Track headers lock vertically with lanes inside one scroller (sticky on inline-start). The ruler and marker row stay pinned above the lanes as you scroll vertically. They keep panning horizontally with the lanes, while the phone's playhead stays in the viewport. Density (gutter vs mixer rail) follows `@container timeline` on `.timeline-area`. Zoom hit-tests the time column, not mute/solo.
- Desktop and tablet timelines keep a vertical scrollbar present so the time viewport width stays steady as track overflow changes. Phone fixed-playhead mode shows the vertical scrollbar only when tracks overflow.

Do **not** bring phone bottom-nav or CapCut fixed playhead to desktop.

### Decision: Host attention uses the compact inspector body when open

<!-- decision
id: D-attention-details-overlay
status: accepted
date: 2026-10-14
decided-by: calebn
evidence:
- PR #1520 production Chromium at 390×844/root32 with nonzero safe-area insets showed the fixed attention summary intercepting native full-sheet Collapse
- Existing compact inspector bodyHeader provides separate flow below pinned header actions without changing the shell slot or outer detent allocation
enforced-by:
- gui/web/e2e-compat/compact-feedback-detents.spec.ts::feedback preserves selected half and full geometry and permitted ruler and lane room
-->

Host offline command attention occupies its own shell row on phone, tablet, and desktop; queued host edits stay visible while reconnect/replay is pending, and conflict rows can be dismissed. While a compact inspector is open, the one native Details disclosure moves into its existing feedback body header, below the pinned inspector controls. Its explanation and recovery actions use the inspector body scroller; the header actions keep their own space at every detent. In compact half and full detents, the existing Pending review toolbar also starts the scrolling body, so it does not consume the pinned header budget. Peek and regular inspector placement stay unchanged, and the same toolbar keeps its callbacks, review draft and focus across those moves. Otherwise, Details opens a bounded dropdown below the shell row. The shell slot keeps its compact footprint and inspector detents stay unchanged. A stable local portal container preserves native open state and focused recovery controls when the existing host closes, stows, or returns. Switching projects resets the disclosure. Outside the inspector, the dropdown height subtracts its measured row bottom and the bottom safe-area inset. Removing attention or unmounting removes the portal container and cancels position updates. The share-mode label remains guest-only.

## Testing
- Vitest: `useViewportClass`, `BottomSheet`, `stage/frame/StageFrame.test.tsx` (phone tab bar, Script and Timeline surfaces, guest stages), follow live region, `stage/hosts/paletteCoverage.test.tsx` (every command that lived in the removed menus is still a catalog command, or its new home is rendered and runs it)
- Playwright: phone viewport (`390×844`) asserts `.stage-frame--phone` and the Stage tab bar (`e2e/stage-shell.spec.ts`); `e2e/overlay-viewport.spec.ts` Project menu + Share dialog reachability at `1280×715` and `390×844`; `e2e/presence-follow.spec.ts` two-client follow at 390 / 820 / 1440; `e2e-compat/timeline-scroll-end.spec.ts` checks the desktop horizontal end with short lanes and classic scrollbars on Chromium and WebKit. Specs reach chrome only through `e2e/stageNav.ts` ([testing-e2e.md](testing-e2e.md#stage-navigation-helpers))
- Playwright compat: `e2e-compat/phone-chrome.spec.ts` (#1077) checks three 72px lanes sideways at 932×432, the Edit corner, a page that never scrolls under the frame, and the once-per-browser Add to Home Screen banner, in Chromium and WebKit with touch emulation
- Manual / guest parity: [`gui/web/e2e/PARITY.md`](../gui/web/e2e/PARITY.md)
- Manual / guest parity: [`gui/web/e2e/PARITY.md`](../gui/web/e2e/PARITY.md)

See [`gui/web/README.md`](../gui/web/README.md) and [gui-integration.md](gui-integration.md) § Responsive shells.

### Transcript speaker editing

Tap a speaker label to rename or reassign every turn on that track. The editor wraps its input, scope hint, and Save and Cancel controls within the transcript panel. On coarse pointers, speaker labels and the name input use the shared `--touch-min` target size. Hosts and guests with the `edit` capability can save speaker names.

### Transcript find and replace

The host Text/Transcript toolbar exposes **Find and replace** on every shell. On desktop and tablet, the command palette action reveals Transcript through the same tab-jump policy. It restores the default layout from timeline or review, retains the transcript layout, and clears timeline key focus when leaving timeline. Revealing a collapsed drawer clears its saved collapsed preference, keeps its previous height, and leaves the panels visible after reload.

The native labeled inputs and preview list wrap within the panel and scroll without replacing the transcript list. Hosts review source-keyed changes and apply the complete set as one Undo action. Different word counts show the source-span timing warning before apply. Shared guests retain the existing text-correction restrictions. See [daw-editing.md](daw-editing.md#transcript-find-and-replace).

### Crossfade length on Timeline

Open a crossfade join glyph to reveal a reserved endpoint row below the scrolling lanes. The right-endpoint grip has a target at least 44 px in both dimensions. Its leader connects to the centered overlap X, and its caption shows the seam and effective or draft length. The grip stays outside clip move, seek, fade and roll targets, with the popover above its reserved row. Dragging saves one coupled join change on release. The grip follows the touch grammar like every timeline target (kind `crossfade-end`): a finger sliding on it scrolls, and only a long press arms it to drag. A mouse drags it at once. Use the native Length range for keyboard editing. Canceling restores the saved overlap. Stored unequal fades remain visible in the popover until an intentional edit sets both edges equally.

Moving a clip without dragging, and the panel size controls, are described in [daw-editing.md § Move clips without dragging](daw-editing.md#move-clips-without-dragging).
