# ShareCut Studio mobile & responsive UX

> **Non-technical overview:** [ux/pages/mobile.md](../ux/pages/mobile.md) — what mobile does and why, for partners and users.

Phone- and tablet-first shells for ShareCut Studio, plus desktop polish shared with those patterns. Desktop keeps the Reaper-style grid; phone does **not** shrink that grid.

Canonical strategy and feature map for agents/contributors. Implementation lives under `gui/web/`.

Reading-room actions and Invite sheet actions/checkbox labels use the shared
`--touch-min` target floor. On phones the Invite sheet is a bottom sheet over
any stage, and the Deliver page carries only the Listen link row, after the
Episode file and above the sticky Export bar. Stop sharing and
End room act at once and leave an Undo toast for the server's 10 s restore window
(`feedback/FeedbackToast`), so there is no second sheet and no confirm row. Dialog and sheet close buttons use the same square
target. Reading form labels, hints, and errors use `--font-size-body`, while
actions use reading-body type. Compact timeline/inspector controls retain their
editor density. See the [component recipes](../gui/web/docs/ui-library.md#composition-recipes)
and [consistency audit](design-system-audit.md) for checked examples and remaining
phone coverage. Guest review bounds its reading column and lets native composer
fields shrink to fit narrow viewports.

**Phone guest Listen (#3784).** On the phone shell a Viewer or Commenter link places the Player as a `dock` (`playerPlacementOf` in `stage/frame/playerPlacement.ts`; `html[data-player="dock"]`) and Review renders `GuestListen` (`stages/guest/`) instead of the Queue and card: the transcript (or the chapter list, or a cover) in the middle (a Viewer's Script shows "Read only" as one caption line that describes the Script region, with no header row), one comments row (only while the link holds comments, suggestions or something needing attention), and the dock, with `listenLayoutOf` in `stages/guest/listenLayout.ts` choosing the middle (`script`, `chapters`, `empty`, from the transcript's real state, never the role) and the bottom surface (`row`, `composer`, `none`). The dock is a form of the one `Player` (`form: "dock"`): an always-visible overview strip inset 1.5 rem from each edge, the readout, and Chapters (absent when the link has no chapters or the chapter list fills the middle), Back 15, Play, Forward 15 and, on a Commenter link, a Comment button (a Viewer link has none) whose label hides at and below a container width of 23.5 rem, in a labelled `region`. Every way to start a comment but typing (the dock's Comment, the transcript selection bar's, the C key, the touch create menu) is one `open` event of the composer session (`state/composerSession.ts`, a pure reducer; `commands/composer.ts` dispatches it); typing in the field a tablet or desktop Commenter or Editor, or a phone Editor, always has on screen is a `type` event instead. The `open` event carries `listen`, whether the phone Listen layout holds, which `listenLayoutOf(shell, guestMode)` in `state/stageRoutes.ts` answers as a boolean (a different function from the one in `stages/guest/listenLayout.ts`; it is built on `listensOn`, the predicate behind `playerPlacementOf` and behind `ReviewHost`'s choice of `GuestListen`): in that layout it pins the time (text already typed keeps the time it was typed at when the dock's Comment, or C with nothing selected, opens it again; a selection's Comment or C pins the selected range instead), pauses a playing episode through the transport's own toggle, and opens the composer. Anywhere else (a host, a desktop or tablet Commenter or Editor, an Editor on a phone) it opens the composer, replaces the pin and leaves playback alone, and a pause the composer already holds stays promised, so Post or Close still plays on. A link that stops allowing comments takes the composer and its text away (Close would keep the text), and the episode plays on if the composer had paused it. Post or Close plays on only what Comment paused and nothing touched since (a Play, a Pause or the end of the episode, even while a Post is in flight, takes the promise back), and a Post in flight shows Post disabled; on a phone Commenter link focus then returns to the dock's Comment button. The comments row opens the Comments list, scrolled to the comment being heard when there is one. The composer, the Comments list, a thread and Chapters are one value, the session's `surface`: opening one closes the others (leaving the composer for a sheet is a Close), and the sheets go when the layout stops being the phone Listen layout (text the composer held becomes the open composer there, at the time it was typed at, and posts at it). A thread is a pushed step of the Comments sheet; Back returns to the list at the scroll offset it was left at, with focus on the row. `--frame-bottom-chrome` for the dock excludes the tab bar (Viewer and Commenter have none), a folded frame (`html[data-frame-short]`) makes the dock one row of the elapsed time, the scrubber, Chapters (when the link has chapters and the list is not the middle), Play and, on a Commenter link, an icon-only Comment, plus a warning button that says why while the Player has a status (the mix's state, or why Play cannot start) (Back 15, Forward 15, the total, the chapter name and the status text give way), and with the soft keyboard open (`html[data-keyboard="open"]`) the frame takes the visual viewport and the dock hides. An Editor on a phone keeps the bar and the Review card, and the comment field is always present (with its **Your name** line until this browser knows the name), docked at the foot of the Review panel (inline in the card when the layout is 30rem tall or less; the keyboard does not count); typing creates the draft, nothing pauses, and after Post the field stays on screen, empty and not focused (the Review stage takes focus). The bar's Comment button, visible without a menu, opens the composer through the same `open` event, which leaves playback alone; in a folded frame an Editor guest on the phone shell keeps that Comment as an icon-only 44 px button (`sys-player-comment--guest`), while a host's folded bar, and a guest's on a desktop or tablet shell, hides it.

The `StageFrame` adapter (`gui/web/src/stage/frame/`) renders the props-only `StageFrameView`
on every viewport class: header, Stage bar (a bottom tab bar on a phone), stage
content, Player bar and banners. Each stage has a host in `src/stage/hosts/` and
the Edit stage a workspace in `src/stage/edit/`. The adapters retain viewport
effects, commands, focus/presence refs and selection policy. The catalog
composes these views with fictional bounded regions at 360px phone and
desktop/tablet sizes (`Stages/Edit/Frame`, `Stages/<Stage>/`) without mounting
the full DAW runtime. See [shell chrome](design-system.md#shell-chrome) for the
catalog boundary and [the stage specs](design/stages/spec-edit.md) for the design.

On phones, the frame publishes the rendered header's bottom relative to the
frame's top. Portaled bottom sheets use that boundary so wrapped header controls
stay clear at larger text sizes. The measurement already includes the safe area.
The existing keyboard rule still places an open sheet within the visual viewport.
Centered dialogs and the clip Inspector keep their own placement.

The frame rechecks its fit when the Edit action dock changes size, including
when the project loads after the frame. It does not wait for a window resize.

The phone Invite sheet's **Peek** detent stays within the compact 4–7.5rem
content-height range, scaled with the root type size and capped by the available
sheet slot. Its existing body remains the scroll owner, so all Invite links and
status content stay reachable when the compact height overflows. The sheet header
and its Close and resize controls retain their own geometry.

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
| Tablet | `768–1194px` | `data-shell="tablet"` / `.stage-frame` | Stage bar in the header, Edit with the Inspector card beside the selection |
| Desktop | `> 1194px` | `data-shell="desktop"` | Stage bar in the header; Edit shows Timeline, Script and the Inspector card |

iPad 11″ landscape is 1180 CSS px wide on the Air and 1194 on the Pro. The tablet band used to end at 1100px, which put that orientation on the desktop shell and hid the editing tools behind collapsed transport chrome (the transport and the tool strip are gone; the Edit corner holds Select range on touch) (#1632). It then ended at 1180, which still left the Pro on the desktop shell (#1674). `TABLET_MAX_PX` now includes 1194 so both keep the tablet frame.

Hook: [`gui/web/src/hooks/useViewportClass.ts`](../gui/web/src/hooks/useViewportClass.ts) reads a first-render snapshot through the shared media-query subscription in `useMediaQueryStore.ts` (`matchMedia` + `visualViewport` resize). Pointer capability and Storybook docs theme use that subscription too; pointer events still select the last used device. Store mirrors `shellBreakpoint`. `useShellAttributes` writes `data-shell` from the stage frame and from Home, so a Dialog on Home rises as a bottom sheet on a phone too. CSS class stem is `.stage-frame*` (`StageFrame`).

Chrome type/space is rem via theme tokens, and Studio color consumers use semantic `--color-*` roles. Pane density (Stage bar, pipeline, header) follows named `@container` (`app` on `.stage-frame`, `timeline` on `.timeline-area`), not viewport-width `@media`. Short-viewport `@media (max-height: 40rem)` for portaled sheets is a documented exception (`-- user-approved:`). Policy: [.agents/rules/gui-styling.md](../.agents/rules/gui-styling.md).

## Browser chrome, safe areas and Home Screen (#1077)

The native iOS app (Simulator today, [desktop-packaging.md](desktop-packaging.md#ios-app-3810)) loads the same phone shell in a WKWebView, so these rules apply to it too.

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
  rubber-banding, so nothing slides under the drawer (the round-4 rule). The
  timeline scroller keeps `overscroll-behavior: contain`, so a one-finger
  scroll on the lanes scrolls only the lanes.
- **Safe areas.** `index.html` sets `viewport-fit=cover`. The shell pads all
  four sides with `env(safe-area-inset-*)`, so rows clear the notch or Dynamic
  Island side held sideways and the home indicator; the inset bands take
  `--color-bg-base`. Viewport-fixed top-layer panels also set their edges from
  the matching safe-area insets because they escape shell padding. Other pages
  pad the body's left and right. Home has no stage frame, so `.sys-home-column`
  pads its own top by `env(safe-area-inset-top)` (`max(var(--space-8), ...)`
  wide, the bare inset when narrow); without it a full-screen webview such as
  the iOS app draws the header under the status bar (`App.styles.test.ts` pins
  both rules).
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
  quiet), Home shows one 96 px card at the top of Recent from the second visit
  on: the iOS share glyph, "Add to Home Screen for full screen." and a 44 px
  close button. Home counts its visits per device (`localStorage`
  `sharecut.homeVisits`), and the close button is remembered on the device
  (`sharecut.homeScreenHintDismissed`), both read and written through
  `utils/storage.ts`, so blocked storage only means the card never shows.
  The card never shows inside a project: there is no banner in the shell.

Short touch screens (at most 40rem tall with a coarse primary pointer, a phone
held sideways) compact the editor:

- Touch lanes drop from 104px to the 72px compact lane (`LaneFit` `touchShort`
  in `timeline/timelineMetrics.ts`), whatever the saved fixed height, so three
  or more fit. The lane does not follow the stage height, so the drawer opening
  or closing never resizes lanes under a finger; **Fit tracks to window
  height** (palette) still fills the stage. With large text the lane is 3.25rem
  (`shortTouchFloorPx`), so the 2.75rem identity chip and its meter stay whole
  (104px at a 32px root). Track headers switch to the 56px avatar-only form,
  and a sideways pane at least 50rem wide keeps the full 10.5rem header so
  the name still reads beside M and S.
- An empty marker lane gives its quiet row to the tracks; a lane with
  chapters, clips or comments still shows, and so does the clipping row when
  there are clip flags.
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
- **The phone shell's Inspector is the sheet in either orientation (#2294 W3a).** The
  side column of #1696 is gone: `useInspectorColumn`, the column placement of
  the Edit stage's Inspector and its `e2e-compat/inspector-column.spec.ts` are
  deleted (decision `D-inspector-sheet-no-column`). The Edit stage mounts one
  `InspectorHost` (`stage/edit/InspectorHost.tsx`): the Inspector sheet with the
  Action bar as its dock on the phone shell (up to 767 px wide, `PHONE_MAX_PX`)
  held either way, and a card beside the selection on the tablet and desktop
  shells; a wider phone held sideways is the tablet shell and gets the card. A timeline target on the phone opens the Inspector sheet at
  half height with the Action bar as its dock (the peek strip and the compact
  drawer are gone, #2294 W3c2b). `BottomSheet`'s generic `placement="column"` and its frame rule remain
  until the legacy bodies go (W3c).
  At the full detent, the grip hit area starts at the sheet edge and the
  scrolling surface reserves that same target height for it.
- **A volume-envelope point leaves its lane in view (#1694, #1714).** An
  `envelopePoint` selection opens its **Time** and **Level** in the Inspector:
  the card beside the point on the tablet and desktop shells, which does not
  shrink the timeline, and the phone sheet. On the phone the sheet does not
  shrink to leave a lane band; the timeline scrolls the selected point clear
  above it (`useKeepTargetClear`). At most 24rem tall (914×331, and a
  667×375 phone, 23.4rem) the marker rows (chapters, comments, social clips)
  scroll with the lanes in the idle layout, on the tablet and the phone shell
  (`@media (max-height: 24rem)`), so the pinned rows never eat the lanes and a
  touch-only user can tap a lane's name to open its details; 932×430,
  1024×768 and 1194×834 keep them pinned. The **Solo on · Clear solo** chip
  lives in the header column's chrome, so wherever the rows scroll it scrolls
  with them (one scroll up). The point's **Time** and **Level** are two Scrub
  rows with the help text visible, and **Remove** sits below them; Playwright
  asserts both on a short landscape phone and on a tall iPad slot (1194×834,
  1024×768). Each change saves at once as one undo step (`setEnvelopePoint`,
  `commands/envelopes.ts`), so there is no draft to lose when the phone and
  tablet shells swap on rotation. One save per track runs at a time, and the
  fields are read-only while it is in flight. A failed save, including a
  refused stale baseline, stays in the sheet as an alert; a stale one offers
  **Reload points**, and a time already taken offers **Select the point
  there**. The sheet root pads its sides with `env(safe-area-inset-left/right)`
  so nothing sits under the notch or Dynamic Island held sideways; Playwright
  cannot emulate those insets, so only a real iPhone proves them.

Measured in Playwright WebKit with the iPhone 17 Pro Max descriptor, the touch
grammar on and the timeline maximized (px of lanes above the rail or the peek strip, which #2294 W3c2b removed;
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
track sheet's Name, Speaker and Role fields, the Range fields and track checkboxes all hold the 44px floor (`e2e/touch-floor.spec.ts` sweeps phone, tablet and landscape and names the dense-target exceptions); a native `select` takes it
as `block-size` because WebKit ignores `min-block-size` on one. Transcript
**Find and replace** rows wrap their controls on a
coarse pointer so landscape panels do not overflow (#1433). The sheet back buttons
hold the floor too (#1445). Controls
keep their DOM, form and disclosure state. On touch, in a window under 40rem tall
(`@container app`, so large text counts), the Script scrolls as a whole
with the list keeping at least 16rem, so its chrome does not cover the rows beneath
it. `e2e-compat/reachability-sweep.spec.ts` sweeps
the Script and the Prepare stage whole at every cell. The envelope point's Time and Level, the effect on/off switches and the comment composer's
fields and track picks hold the floor too, and the same sweep measures them (a seeded
track for the first two, the Review queue on tablet and desktop, and the Review stage on a phone,
for the last).

In short windows with a fine pointer, Transcript uses less vertical spacing around
its content and hint.

Round 9 (#1181) moved the peek strip above the tool rail after an Undo tap could
nudge a pending edit. Issue #1205 then moved the shared Undo and Redo controls
into the compact inspector header; that drawer is retired (#2294 yf), and Undo
and Redo now stay in the App header, which the phone Inspector sheet never
covers. They use the same authorization, unavailable-action feedback and
`history.undo` / `history.redo` command path as before.

`e2e-compat/phone-chrome.spec.ts` checks three 72px lanes at 932×432, Undo and
Redo on both shells, and a page that never scrolls under the shell, in
Chromium and WebKit. A real iPhone check remains for the
Dynamic Island side in landscape.

Phone chrome is **≤767 CSS px**. DevTools device-mode / CDP viewport override can leave the CSS viewport at tablet width while the OS window is narrower — hard refresh does not clear that; clear the override (or set 390×844) before judging the phone frame.

## Software keyboard and bottom sheets (#1335)

Mobile Safari shrinks only the *visual* viewport when the keyboard opens and scrolls it under fixed elements, so a sheet sized from the layout viewport lost its pinned header, including **Close**, off the top in portrait and after rotation. While any `BottomSheet` is open, `useKeyboardInset` (`gui/web/src/hooks/useKeyboardInset.ts`) reads `visualViewport` and publishes `--keyboard-inset` and `--visual-viewport-top` with `data-keyboard="open"` on `<html>`. `bottom-sheet.css` then fits the sheet slot to the visible area, so the header and **Close** stay on screen and the body scrolls above the keyboard. A pinch zoom (scale above 1) is not a keyboard. When the viewport changes with a field focused inside a sheet, the field is scrolled into view with `focusAndReveal`. On touch input, opening an envelope form focuses its heading rather than a numeric field, so adding a point never raises the keyboard by itself.

**What iOS actually does (#1362, proven with a real software keypad on an iPhone 15, iOS 17.5).** With a field focused, Safari shrinks `innerHeight` along with the visual viewport (659 to 441 px) and then pans the visual viewport by `offsetTop` (218 px) to bring the field above the keypad; the root's `clientHeight` stays 659. A hook that reads `innerHeight - viewport.height - offsetTop` therefore computes a negative inset and never opens. The hook takes the layout height as `max(innerHeight, documentElement.clientHeight)`, calls the keyboard open when the visual viewport leaves at least 80 px of that uncovered (and scale is about 1), and publishes `inset = max(0, covered - offsetTop)`, which covers iOS (pan already hides the top part), Android (`innerHeight` constant, `offsetTop` 0) and the iPad. The non-compact half sheet scrolls as a whole, so with the keyboard open `bottom-sheet.css` pins `.bottom-sheet-chrome` to the sheet's top (`position: sticky`) and `focusAndReveal` reveals fields below it: the scroller's visible bottom is `top + clientTop + clientHeight` of its own box, not the sticky-adjusted top plus its height, and a field keeps a `--space-3` scroll margin above the keyboard. The simulator hides the software keypad when a hardware keyboard is connected; to see it, set `AutomaticMinimizationEnabled` to false for `com.apple.keyboard.preferences` in the device's defaults and relaunch Safari (restore it afterwards). Proof on the PR head: iPhone 15 portrait, light and dark, with Time focused and the keypad up, shows the sheet header and **Close** on screen and the field above the keypad, and tapping **Close** closes the sheet; on iPad Pro 11 (iOS 17.5) the keyboard does not move `innerHeight` or `offsetTop` (`--keyboard-inset` 340 px, `vvTop` 0) and the same fit holds. Landscape on the iPhone simulator is driven with a throwaway XCUITest runner that sets `XCUIDevice.shared.orientation` (the Simulator rotate shortcut needs accessibility access that automation lacks); the landscape keypad proof of the Inspector column, which #2294 W3a replaced with the phone sheet, is below. The landscape envelope sheet (#1694) is proven in Playwright with `--keyboard-inset` and `data-keyboard` set by hand, not with a real keypad: with the keyboard up the sheet fills the visible slot. The Inspector column (#1696) answers the keypad differently: with `data-keyboard="open"` it is `position: fixed` with `grid-area: auto` and takes the visible band, `--visual-viewport-top` down by `--visual-viewport-height` (published by `useKeyboardInset`), on the inline end (`bottom-sheet.css`). **Proven with a real keypad (fix round 1).** On an iPhone 15 Plus (iOS 17.5, 932x430) and an iPhone SE (667x375), held sideways, the keypad shrank `innerHeight` (347 to 131 and 325 to 119) and Safari scrolled the page by the visual viewport's `offsetTop` (216 and 206). The first version set `inset-block` from `--visual-viewport-top` and `--keyboard-inset` and left the shell's `grid-area` on the column: the shell is a size container, so Safari resolved the offsets against the column's grid cell, which put the column at the left edge, 52 px low, and on the Plus collapsed it to about 21 px (visual viewport 122 at `offsetTop` 98, `--keyboard-inset` 127). With `grid-area: auto` and the band from the visual viewport itself, both phones show the column on the inline end at exactly the visible band (Plus rect 575,0,298,122 with Close at 817,8; SE 411,0,256,119 with Close at 611,8), with the title, Close and the focused Source start field above the keypad, and **Close** works with the keypad up. Screenshots and the measured rects: `podcast_mcp-session-state/trails/1696/live/fix1-*`. Playwright pins the same arithmetic with hand-set values, including the shrunk-`innerHeight` shape (`e2e-compat/inspector-column.spec.ts`). **Status strip (fix round 2).** With Safari's chrome collapsed after a rotation to portrait and back, the visual viewport can reach the shell's bottom edge (Plus: `innerHeight` 205, visual viewport 205 at `offsetTop` 142, `--keyboard-inset` 0, shell 347 tall at y -142), and the tablet shell's status strip, which stacks above the column (`--z-shell-chrome` over `--z-sheet`), painted over the lower 49 px of the column and the focused field. The shell now publishes `--column-floor` (the home-indicator inset, plus `--status-height` on the tablet shell, `responsive.css`) and the column's `block-size` is `min(--visual-viewport-height, 100% - --visual-viewport-top - --column-floor)`, so it ends where the strip begins whatever the layout height is. Proven on the same Plus after rotating to portrait and back and tapping Source start with the real keypad: column 575,0,298,156 (the strip starts at 156), Close at 817,8, the field at 592,104,88,44 clear of the strip, and Close works; the SE (667x375, no strip) still takes the whole band, 411,0,256,119. Screenshots and measured rects: `podcast_mcp-session-state/trails/1696/live/fix2-*`. `e2e-compat/inspector-column.spec.ts` pinned the geometry with hand-set values and failed without the clamp; the column and that spec were removed in #2294 W3a. The landscape envelope sheet (#1694) is still proven only with hand-set `--keyboard-inset` values, not a real keypad. Rotating a phone from the column to the sheet inside one shell (SE 667x375 to 375x667) keeps the typed draft and the focused field on a real device; iOS closes the keypad when the field's DOM node moves, so the field keeps focus and its caret but the keypad needs a tap. A rotation that also crosses the phone and tablet shell (Plus 932 to 430) swaps the whole shell and still loses the draft. After a rotation Safari's chrome left the page offset by 50 px for under a second on the SE; a longer offset of 3 to 20 s (83 px on the Plus, 50 px on the SE) was seen later (#1761). `useViewportPan` (`gui/web/src/hooks/useViewportPan.ts`, mounted in `StudioShell`) publishes a pan that no keyboard, pinch zoom or focused field explains as `--viewport-pan-top` and `--viewport-pan-height` with `data-viewport-pan` on `<html>`, and on the touch shells `layout.css` gives the fixed shell that top and height, so it and the fixed children inside it sit in the visible band. Body-ported phone bottom sheets add the pan once to the frame’s measured header inset. Other body portals retain their existing placement. The first touch ends the pan. Safari starts and ends the pan without a `visualViewport` event in some frames, so after a viewport, focus, orientation, visibility or pointer-up event the hook re-reads once a frame while a pan is engaged and for 1.5 s after, writes only when the pan changes, and goes idle after that (#2126). The pan can still show for one frame when the compositor paints the new offset before the page has read it. No transform is used: portaled menus place themselves from `visualViewport.offsetTop` in layout coordinates (`anchoredPlacement.ts`), and a transformed body would count the pan twice. Scrolling the page does not help: `scrollY` stays 0 while Safari holds the offset (measured on the Plus and SE).

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
| **Record** | Launcher with live-take status; the host room state is held in `DawApp`, so a take survives stage switches | Capture |
| **Prepare** | Import, pipeline jobs, vocabulary | Get audio ready |
| **Edit** | Timeline surface (playhead that starts at 0 and holds the center once passed; Ferrite lane gutter; eye popover) and Script surface (transcript), switched by an icon pair | Spatial edit, word fix, suggest cut |
| **Review** | Queue (guests: Comments) | Guest review and comments, approve or reject edits |
| **Deliver** | Export, Listen link | Hand off |

Guests see only the stages their role allows (`stagesForRole`): a Commenter or Viewer link is Review alone and has no Stage bar, and an Editor link has three stages.

The Player bar and the header wrap their controls when one row cannot hold them, which happens at Safari page zoom 200% on a phone and at 200% text. The bar grows with the wrap so the stage content starts below it. Targets stay `--touch-min`. This is not pinch-zoom on the timeline. A physical iPhone Safari 200% Aa zoom remains a Mac-simulator check. Phone menu rows use the 44px touch target and omit keyboard shortcut hints.
**The short fold is a measured fit, not a size threshold (R-short-9).** `useShortFrame` (`gui/web/src/stage/frame/useShortFrame.ts`) folds the frame when its height is less than the full header, the full Player, the tab bar and `--stage-stacked-lanes-min` together (`frameFolds`, pinned in `useShortFrame.test.ts`). The hook lifts the fold, reads the natural heights of `.stage-frame-header`, `.stage-frame-player` and `.stage-frame-tabs` and resolves the lane floor token, then restores the fold in the same task before paint, so the fold tracks text size, header wrapping and the safe area with no `rem` breakpoint. Its only observer is the governed `useResizeObserver`. A folded frame sets `data-frame-short` on `<html>` (system.css and stage-frame.css key on it): the tab bar becomes the header's Stage menu, the Edit rows and the corner (zoom, the eye and, off the phone, the Script toggle) become the header's Tools button and its sheet, and the Player is one touch-height row. The corner folds whenever it would leave the lanes less than their floor (`laneAreaHeight - cornerHeight < lanesMin`), so it never floats over a lane at the floor, as at 844x390. The stacked lanes' floor is capped at the workspace height, so a frame too short even when folded keeps its lanes inside the body, not clipped under the Player.

While `project === null` (progressive load), the frame shows the header and Stage bar with skeleton content and a disabled Player bar ("Loading episode…"). That chrome is not the empty-session Start tiles.

**Commenting (#1338).** Commenting is the job of a Commenter or Editor review link, so the Player carries a comment-at-playhead control (the bar, the guest card on a tablet or desktop, or the Listen dock on a phone Commenter link; a folded bar hides it for a guest off the phone shell) and Review holds the guest's comments in the Queue (`stage/hosts/useReviewComments.tsx`; a phone Commenter reads them in the Comments sheet): the `Composer` above the card (docked at the foot of the panel (inline in the card when the layout is 30rem tall or less; the keyboard does not count) for an Editor on a phone, above the dock for a phone Commenter) and one `CommentCard` per comment, with no Cut, Keep, Find more or Deliver for a Commenter or Viewer. A guest types, taps the arrow, and the time chip that leads the field shows where the comment lands (the draft that C, the Player's comment button or the first keystroke set, else the selected range, else the playhead; see [timeline-comments.md](timeline-comments.md#daw-viewer)). A guest's Composer carries a **Your name** field above the comment field until this browser knows the name; then it says **Posting as** the name with a **Change name** button that brings the field back focused. The host's Composer has no name field. The post is announced in a polite live region ("Comment posted at 0:12") and in the toast, which docks above the Player bar (above the Listen dock on a phone Commenter link). The name (40 code points at most) is remembered in a guest-only `localStorage` key, which the host never reads or writes; a blank name posts under the saved name, else as **Guest**. A reply uses the saved name or Guest without asking. The field is 1rem so iOS does not zoom in on focus. On a touch screen (a coarse pointer, where the soft keyboard has no Shift) Return adds a line and the arrow posts; Cmd or Ctrl+Return still posts. A Viewer link shows no composer. On a phone a Commenter's composer is not on screen until the dock's Comment button, the transcript selection bar's Comment or C opens it (see the phone guest Listen paragraph above).
A share link never opens the Inspector by itself: a stored or remote selection whose target is gone clears silently, and no tab, host or guest, takes on another viewer's selection (see [session-sync.md](session-sync.md)) (#1339).

A timeline or transcript range opens the same sheet with **Range fields** as its body on the phone and the tablet (`Inspector` renders `RangeFields`; the tablet no longer draws them in the bar under the scrim). The range draft opens the Range fields on every shell, and the one shared draft and range `RangeFields` mount in `SelectionSheetBody` (its `always` prop) serves both. A selected range's sheet carries the **In**, **Out** and **Length** Scrub fields and a **Scope** row of track toggles (`RangeFields`, rendered by the range surface and `rangeSection`). Editing a field commits the range it describes as the new selection; at least one track stays on. While **Select range** is armed, the range is drawn by dragging on the lanes, and the sheet opens for the range draft, and when an agent range is waiting it also carries the explicit **Use agent range on selected tracks** action. The agent range is not adopted automatically. The selected target and saved sheet detent do not change. There are no number inputs, Select range or Cancel buttons. The desktop shell keeps them in the inspector aside, not a sheet. Selection opens a non-modal **half → full** [`BottomSheet`](../gui/web/src/ui/BottomSheet.tsx) wrapping the desktop inspector views. It retains `aria-modal="false"`, Escape, focus restoration, and an interactive timeline background. It has no Tab trap. **Expand** and **Collapse** are icon buttons (maximize and restore) with the same accessible names, and change view size only; these actions and **Close** use the sheet-scoped `--touch-min` floor. Only the compact inspector below swipes.

**Split speakers…** is a track-inspector button, so the same sheet carries it on a phone, and the Split prompt on a Source card in Prepare points there. Its dialog is a bottom sheet with **Split speakers**, **Cancel split** or **Undo split** and **Done** pinned in the footer ([communication-philosophy.md](communication-philosophy.md#terminology) names the terms). After a split, the scrollable result lists saved unsure and overlapping stretches with timeline start, length and speaker tracks; repeated timeline placements have separate **Go to** buttons. A stretch removed from the timeline shows recording time and explains why **Go to** is unavailable. Close the sheet to listen with the lane Solo controls, then choose **Review split…** in that track's inspector to return to the list. The review entry is session-scoped and expires after any saved project edit, including a saved mute change; listen-only Solo keeps it available.

A timeline selection on the phone shell opens the **Inspector sheet** (design
system 9a; `InspectorSheet form="phone"` in `stage/edit/InspectorHost.tsx`), a
bottom sheet with three detents: the **dock** (4 rem: the Action bar alone), **half**
(50%) and **full** (92%). It opens at half, or at full where half does not
fit the lanes (a phone held sideways, a small portrait phone at large text);
there the dock is dropped at full so the fields get the room. Where even the full sheet would be under 8.75 rem tall (large text on a phone held sideways), the Inspector takes the whole screen as a dialog with one header row (name, **Undo**, **Redo**, **Done**) instead of a sliver. The dock is the
Action bar: the selected object's icon and short name on the left (96 px at
most), up to five 48 px verb buttons (icon over a 10 px label) and **More**. A
verb that opens fields (Fix text on a chapter, Adjust bounds, Fade, Move to
track) raises a sheet resting on its dock to half and focuses the first field.
The body is the target's own fields as Scrub fields: type a value, drag it, or
step it with the arrow keys; there are no nudge buttons, so the phone has no
one-tap quick nudge. A pending edit's review card sits at the top of the body.

The grip is a 36×5 pill with a 44 px hit area and the role "Sheet height". Drag
it up to half or full; drag it down past the dock to clear the selection and
close the sheet. The sheet follows the finger 1:1 and, on release, coasts on the
finger's speed to the nearest detent (reduced motion lands it without the
slide). A tap on the grip toggles half and dock (full steps down to half); the
arrow keys, Home and End step it from the keyboard or a screen reader. There
are no Expand or Collapse buttons. The timeline scrolls the selection above the
sheet (`useKeepTargetClear`, `--sheet-clearance`). Undo and Redo stay in the App
header, which the sheet never covers; the sheet carries no history controls.
The saved-edit toast docks above the sheet's grip.

An envelope point chosen from the keyboard or added from the create menu while
the track's sheet is open shows its **Level** and **Time** fields in the sheet,
and Inspect opens them; a tap on the timeline, even with that sheet open,
selects as usual. The tablet shell (upright or sideways) and the desktop use the
Inspector card beside the selection, and a touch screen held sideways at 40rem
wide and up keeps the Inspector as a
[column](#browser-chrome-safe-areas-and-home-screen-1077). Decision records:
[touch-editor-decisions.md § Compact inspector](touch-editor-decisions.md#compact-inspector-1051-round-3)
(history; the drawer it describes is retired).

On touch, a direct long press on a fade or trim handle may open Auto precision;
envelope points, pending edges, and chooser chip grabs keep the grammar drag.
**Auto precision** (#1184) then opens a jog pad in the sheet's place when the
target or its neighbour is narrower than a finger, or drags directly on the
timeline when a step is already at least 4 px wide (slower finger motion moves
finer steps). Slide up on the pad to slow the move; **Done** or a tap outside
finishes. A second finger cancels. Detail: [touch-editor-decisions.md § Auto
precision jog pad](touch-editor-decisions.md#decision-auto-precision-jog-pad-on-touch).

The precision controller owns the trim or fade draft until it finishes or
cancels. Losing the arming handle's native pointer capture leaves that draft
available for the jog pad to preview and save. Direct handle cancellation
affects only the pointer that started its draft.

The compact header uses one vertical spacing at every detent. At
667×360 with 32px root text, the full sheet keeps room below its wrapped
history and resize controls for a complete fade field and label. Native Tab
reveals a fitting label with its field below the pinned chrome. Ordinary
sheets retain their existing header spacing.

Ordinary noncompact modifier inspector sheets and range-armed ordinary noncompact sheets use one scroll owner for their content, including sheet chrome, actions, fields, errors, and audition footer. The content has natural height, so enlarged headers cannot compress a separate field scroller. Scroll to the top to reach **Close**. The phone Inspector sheet keeps its Action bar dock (dock, half and full detents; the grip toggles) outside the scrolling body, where feedback and fields share the body scroller. Desktop modifier inspectors also scroll as one aside; their fields and errors flow with the header and footer. Envelope focus transitions reveal the current control within its sheet or inspector without scrolling the page or timeline. The taller half peek applies to ordinary noncompact modifier inspectors and range-armed ordinary noncompact sheets. Sheets remain transient with no stacking. Deferred mutation errors across shell remount, Firefox layout CI, and overlapping Approve remain in [ROADMAP.md § Follow-up](../ROADMAP.md#follow-up).

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
invalidate Mix, and so does Export options, which the Mix sheet yields to. Committed writes continue through the shared
mix queue after closing. A swipe overlay remains deferred.

`e2e-compat/phone-mix.spec.ts` checks pointer opening after Commands and shortcuts has
keyboard focus, the initial Close focus, restoration after Close, Escape, or
scrim dismissal, and keyboard navigation away from and back to More. These
focus scenarios run in the existing core flow alongside its native mix edit
and touch geometry checks.

Inspector sheets keep the timeline interactive behind them: their background scrim is decorative and pointer-transparent, so a phone user can drag a pending edge or tap the ruler without closing the inspector. A blank ruler tap seeks and clears the current selection. Confirmation sheets (such as Find more again) keep a dismissible outside scrim; Close and Escape remain available for both sheet types.

Pending timeline edits use the same lane-wide region on phones. A selected region shows 44px start/end touch targets only when its drawn width is at least 44px and the lane leaves room for both targets. For a narrow region or compact lane, the edge handles stay hidden on touch; the selected action card offers **Edit timing**, which focuses the existing Source start field in the inspector. Outside compact-inspector mode, the card floats below or above the lane without covering the region or adding horizontal timeline scroll; while the tablet's regular inspector sheet is open it stays out of the canvas, and the sheet's own **Approve** and **Reject** carry the review. Whenever the compact inspector is open, the same card moves to the top of its body, so **Approve** and **Reject** stay visible there and the Start and End fields sit under it. Undo and Redo stay in the App header; the sheet's grip toggles between its dock and half detents. Long recovery messages scroll inside the card. Dense unselected cuts reveal a floating label on hover or keyboard focus, and labels follow zoom and responsive layout changes. The Review Queue lists the pending edits that need review, and its Cut all is limited to review-required edits.

Coarse-pointer timeline lanes keep a minimum height of 104 canvas pixels, matching the compact header floor already used by the phone timeline. A short screen (a phone held sideways) is the exception: lanes drop to 72px so three fit (see [Browser chrome](#browser-chrome-safe-areas-and-home-screen-1077)), and the hit router's crowded-target chooser resolves the tighter targets. The Seam diamond sits in the top gutter and is the one roll target; its hit box is 44 px square and a long press arms the roll.

On phones, Pipeline step parameters open in the shared modal Dialog. Escape and
Close dismiss it and return focus to the selected step; Tab stays inside the
dialog. Tablet and desktop keep the parameter form inline. An open modal dialog
holds every app shortcut (`ui/modalGate.ts`), as the native `confirm()` did:
Escape closes the dialog and does not also clear the selection, and Mod+Z,
Space or Delete do nothing behind it, so an in-app confirm over the Inspector
neither undoes nor removes anything while it asks. An open Inspector sheet also
holds Escape: `overlayOpen()` skips keymap `edit.clearSelection`. Every `Dialog` is a bottom sheet on phone and tablet (a tablet sheet keeps a
42rem measure) with its primary pinned in the footer; the People list on the
phone More sheet is a `Menu` behind a "People · n" button.
Inspector dismiss still clears the clip selection. A remounted Inspector
sheet stays under a still-open non-modal and does not steal focus from
a docked Cut anyway button. A new sheet still takes Close after deferred
first-entry focus.
Typing, Tab and Enter inside
the dialog stay native. A modal can hand on named shortcuts; the Record room
hands on C for a live marker. On close, focus returns to the control that
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

The app toast (`feedback/FeedbackToast`) has one message, optional guarded Undo
("Undo all" when folded edits share the toast), and explicit Dismiss. Compact composition puts its host first inside the same
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
ordinary floating host. The same `Toast` card keeps its six-second timer (ten
seconds when it offers Undo),
focus and hover pause, disabled-Undo pause, Dismiss and history freshness.
A presentation-boundary intersection observer pauses expiry whenever the card
is clipped by its actual ancestors. Toast retains the remaining visible time
through every pause and host move. An oversized card stays paused while the
user scrolls through its message and actions. Host changes do not restart the
timer or remount Undo. Closing the phone Inspector
sheet returns feedback to the floating host, which docks above the sheet's grip while it is open.
An intentionally focused Undo or Dismiss keeps its native identity when the
phone and tablet inspector hosts remount. Sheet entry focus yields to that action. Dismissing it, or this tab's own
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

On phones the dock measures bottom chrome (the tab bar, or the Player, which is
the Listen dock on a phone Viewer or Commenter link), the latest pressed control
and the comment composer. When a clear position fits, the card moves above the
pressed control (Play, say), or below when there is no room above, on a short phone such as 320x460 where the
dock spot would land on Play (#1960). Its full-sheet fallback can cover scrolling
content in those other workflows. Desktop and ordinary tablet feedback rests
above the status bar.

On every shell, visible parts of the comment composer, the
guest name field take protection priority when
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
complete saved arrays through Undo and Redo. The no-feedback drawer retains the
ordinary lane measurements.

### One selection surface table

`gui/web/src/inspector/selectionSurface.tsx` holds `SELECTION_SURFACES`, a table keyed by every selection kind (`range`, `transcriptRange`, `clip`, `pending`, `applied`, `track`, `chapter`, `social`, `comment`, `envelope`, `envelopePoint`). Each entry supplies the inspector `body`, and the screens where the selection opens the sheet (`screens`). A tapped word is a one-word `transcriptRange`. `Inspector` (the desktop aside) and `SelectionSheetBody` (the sheet on the phone and the tablet) both render from it, and `useInspectorOpen` (`stage/edit/useInspectorOpen.ts`) holds the one open rule: the phone and the tablet each name the screen they show (the phone's mode, the tablet's layout) and open on Inspect (I, the Inspect verb or a double-click on a clip: `inspectorKey` in the store, derived from the selection so a new selection, Esc or Close shuts it) for a selection whose kind lists that screen, or on an armed **Select range** with its draft on every shell; the desktop's card follows the same Inspect rule. Selecting alone opens nothing: the Action bar (`stage/edit/EditActionBar.tsx`) carries the verbs, floating on the tablet and the desktop and docked above the Player on the phone. A new selection kind that is missing from the table fails to compile.

The sheet body is the same on both touch shells: the Range fields (In, Out, Length, Scope) once a range or a range draft exists (the draft opens on every shell; the `always` prop on the shared `RangeFields` mount in `SelectionSheetBody` serves the draft and the range), then the selection's inspector. On the tablet, a session region keeps the **Range fields** in the sheet for every selection kind that does not already contain a selected range. The controls remain in the sheet at every detent, above the inspector. The transport bar keeps one copy only on the desktop shell. This keeps the agent's range out from behind the sheet scrim, where the tool rail cannot arm **Select range** (Ledger on #1445). `selectionSurface.test.tsx` covers each selection kind and checks whether agent-range adoption applies. `e2e-compat/selection-sheet-zones.spec.ts` checks that the sheet shows its rows and leaves the commands to the Action bar. `e2e-compat/reachability-sweep.spec.ts` measures every interactive element at the boundary sizes and text scales (see [testing.md](testing.md)).

### Selection sheet: inspector and Action bar

A selection sheet holds the selection's inspector and nothing else. Its commands live on the Action bar, docked under the sheet on the phone:

- A single transcript word offers Copy in the bar's More, including on a view-only share link, and a clip offers Cut as a bar verb. Transcript and timeline ranges use the shared Play/Cut/Mute/Comment/Export sheet, with capability reasons on disabled actions.
- A track offers Remove on the bar and, in More, Move track up and Move track down. A direction that does not exist stays in the list, disabled, with the reason "This track is already first." or "This track is already last.". Remove runs at once and the toast offers Undo.
- View-only guests do not see edit actions.

Example: Clip selected gives Cut on the bar and its clip rows in More. Fades and Ripple delete remain clip-inspector controls, and Seek join and Play across join are rows under the sheet's More section.

In Timeline, **Select range** arms touch selection on clip bodies and empty
lanes. The In, Out and Length Scrub fields with the Scope toggles offer precision without dragging.
Trim/fade/join/envelope handles retain priority. Editors apply range edits and Commenters create
pending range proposals; Viewers keep the five actions visible with disabled reasons.

### Feature → home map

| Old home | Phone home now |
|----------|----------------|
| Listen hero (play, time, scrub) | Player bar on every stage but Record, swipe up for the Player sheet; a phone Viewer or Commenter link has the Listen dock instead, which does not expand. A Viewer or Commenter guest and passive listening land in Review (an Editor guest lands in Edit) |
| Mode nav (Listen, Timeline, Text, More) | Stage tab bar: Record, Prepare, Edit, Review, Deliver (`stage.*`, Mod+1 to Mod+5). Edit holds the Timeline and Script surfaces behind a waveform and text icon switch; selection and playhead carry across |
| Comment / Fit | Comment at the playhead in the Player (the bar, or the dock on a phone Commenter link); Fit in the Edit corner |
| Track headers (Mute, Solo) | Lane gutter tap (the whole 56px rail; the avatar is the affordance) → track sheet (**M**/**S** toggles and the saved **Volume** fader; drag the Volume envelope layer for envelopes). The mix sheet adjusts all tracks without changing selection. The phone rail shows the avatar only (its ring shows the playing level); there is no touch drag to reorder, so reorder with the track sheet's Move up and Move down. On a tablet with a coarse pointer the header's **M** and **S** are 44px touch targets like the track sheet's (#1028) |
| Timeline overlays (layer chips) | Eye popover in the Edit corner |
| Inspector | Selection sheet |
| Transcript tab | Edit → Script surface |
| Comments | Review queue (comments are queue items), and the comment field (above the card for a host, docked at the foot for an Editor on a phone (inline in the card when the layout is 30rem tall or less; the keyboard does not count), opened from the dock's Comment button or the selection bar's, above the dock, for a phone Commenter) |
| History | Edit → History sheet (right-click the header's Undo, or the palette) |
| Queue / Tighten | Review queue |
| Pipeline | Prepare |
| Command palette (`?`) | Header search button, or `?` and `/`; opens as a bottom sheet with Search focused |
| Theme | Project menu → Appearance (guests: an Appearance button in the header, or in the Stage menu when the header is narrow) |
| Status bar chips | Stage bar badges (Review count, Prepare running or needs you, Record live, Deliver ready); **Mix out of date** is the Player bar mix ring (**No mix yet** when nothing is rendered), and a new empty project stays fresh |
### Gestures

Touch gestures for common actions, listed in the **Gestures** group of **Commands and shortcuts** (touch pointer, inside a project; not on Home). Each gesture is a non-interactive row, not a command: it is skipped by the arrow keys and Enter does nothing. Two-finger Undo is an optional ShareCut shortcut, not an iOS system convention; the app header has visible Undo and Redo, and the Edit stage has the History sheet. Pinch zoom remains available, and it never edits: a second finger on the timeline cancels any one-finger drag or press in progress without saving it and puts the selection back ([decision](touch-editor-decisions.md#pinch-never-edits-1051-round-4)). Timeline editing follows the [touch input grammar](touch-editor-decisions.md#decision-one-touch-input-grammar-for-timeline-editing): one finger moving scrolls and never edits, a tap selects, a long press arms a target (the chooser when targets crowd) and only an armed target drags, along its own axes, with a brief detent at each soft boundary; a long press on a movable clip's body, away from its handles, arms the clip, which then moves in time within its lane and bumps at the session start; a long press on empty timeline space opens the create menu (split here, comment here, add chapter here, record here on the host, add volume point on a lane, and paste when the clipboard has audio), with each row the link cannot run left out ([round 4b](touch-editor-decisions.md#touch-grammar-round-4b-1051)). Every timeline target kind's touch, drag and key behaviour comes from one contract, `gui/web/src/timeline/inputContract.ts`. Visible command routes remain available for the shipped gesture shortcuts; the Gestures group lists only shipped gestures. Remaining non-drag edit alternatives are tracked in [the touch-editor decision record](touch-editor-decisions.md). Gesture thresholds (hold time, touch slop, click-versus-drag distances, drag detent, drawer swipe and flick, ghost-click window, double-tap gap, swipe distances and drag cap) live in one module, `gui/web/src/hooks/gestureConstants.ts`, which every gesture reads. The hold is 500 ms and a held finger may drift 10 px, after iOS's long-press defaults (0.5 s, 10 pt) and inside Android's (400–500 ms, 8 dp touch slop); the module cites the platform sources. Long-press selection varies by target (clip, comment, or transcript word), so it is explicitly exempt from a single command ID; each target keeps its existing selection or correction action.

- **Long-press** on a Script word: a hold followed by a drag selects a word range (one finger moving before the hold scrolls, a second finger cancels), and a double tap opens Fix text. The selection handles at both ends of the range, and Shift+Arrow, extend or shrink it by a word, so the gesture is never the only route. The Action bar's More row Mute (Restore ignored words once the range is ignored) ignores the range's words for a host; an editor's Mute mutes the range instead. A timeline touch selects a clip only on a tap and never while scrolling (see [touch-editor-decisions.md](touch-editor-decisions.md#touch-target-chooser-1051)), so clips have no separate recognizer and a hold never reselects or collapses a multi-selection. Movement, cancellation, and a second finger (even on an element that stops propagation) abort it. It fires on release and consumes the synthesized click; a press whose click never arrives is flushed by the next pointerdown rather than dropped. On coarse pointers, transcript words set `user-select: none` / `-webkit-touch-callout: none`, and the native context menu is suppressed while a press is armed, so the OS selection UI does not claim the hold. Physical iOS/Android verification is still required; CDP touch in CI does not trigger native selection.
- **Double-tap word**: the first tap seeks immediately (no added latency); a second tap on the same word within the double-tap gap opens Fix text (the first tap still seeks; on desktop a double-click only keeps the word selected and a triple-click selects its sentence). The Script body sets `touch-action: manipulation` so browser double-tap zoom cannot eat the second tap. Both paths submit through `submitWordCorrection` (`gui/web/src/transcript/wordCorrection.ts`), so they cannot drift.
- **Word correction from a gesture is scoped to that gesture**: it opens Fix text inline in the Script pane (no sheet); a selected range survives it. Gestures only open Fix text for hosts with hydrated words — guests and unhydrated transcripts keep tap-to-select.
- **Resolving a comment** is the **Resolve** verb in the Review queue (host only): the action-bar button, or on a phone a swipe right on the queue row, which runs the same verb. A swipe left does nothing on a comment. The Comments panel's own swipe-to-resolve is gone. Resolving shows an Undo toast (`Resolved comment at <time>`, shown through the shared feedback toast and spoken once by the shell's status region, 10 s auto-dismiss like every Undo toast, paused while a mouse or pen hovers it, while focus is inside it, or while Undo is disabled by another pending comment change; touch contact does not pause it). Only the latest resolve has a toast: resolving another comment replaces it. **Undo** reopens the comment and moves keyboard focus to the Review stage (including when the browser blurs Undo to the page body while it is disabled during the reopen request); reopening from the card's **Reopen** button still works after the toast is gone or was replaced.
- In the **Review** queue, selecting a comment shows its thread on the card. Open in Edit on a pending edit selects it on the Edit stage; Inspect (I or the bar's Inspect) opens the Inspector.

The Review stage panel owns its scroll area so the Undo toast stays reachable while
the queue scrolls. Closing a focused toast returns focus to the panel with
`preventScroll`. Browser regressions cover desktop and phone in both themes,
plus one Chromium and WebKit phone flow. They measure Dismiss separately from
Undo because removing or restoring a row can change list layout. Physical iPhone
and iPad Safari checks remain pending.

Two-finger Undo is active only while a project is loaded and the shared Undo command is available. Its recognizer yields to timeline pinch/rotation and rejects delayed, moving, or cancelled contacts so zooming does not also undo an edit.

| Gesture | Command | Status |
|---------|---------|--------|
| Two-finger tap | Optional ShareCut Undo shortcut | Available when project Undo is available |
| Long-press | Hold on a Script word, then drag to select a word range | Available |
| Pinch | Zoom in/out on timeline | Available |
| Swipe right on a comment card (Review queue, phone) | Resolve (Undo toast follows); left does nothing | Available |
| Double-tap word | Fix text (hosts); first tap selects the word | Available |

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
### Phone guest — Listen (Viewer and Commenter links)

```
┌─ Project title            ◉ ☾ ⌕ ┐
│ reference  0:02                   │
│ my uncle was delighted for …      │
├───────────────────────────────────┤
│ ▢ 15  Claude · 0:03 Cut candidate… ⌃│  ← comments row (Comments list)
├───────────────────────────────────┤
│ ▁▂▅▇▅▂▁▂▅▇▅▂▁  overview strip      │
│ 0:05   Cold open   1:00           │
│ ☰   ↺15   ▶   ↻15   [▢ Comment]   │  ← Listen dock
└───────────────────────────────────┘
```

### Phone — Timeline (fixed playhead)

```
┌─ Play  12:34 / 58:39  [Fit] [⋯] ──┐
│ (layers and scale: the eye popover)            │
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

Lane identity is a sticky gutter beside the waveforms (same scroller; `headerSlot` into `TimelineView`), identity first, following praised mobile editors (BandLab, GarageBand, Ferrite): in the narrow rail each lane shows the track's avatar (28 px, in the lane color, with a ring that follows its live level), the lane color on the rail edge, and speaker-first clip labels with readable durations (for example, "Avery · 17m 26s", falling back to the track name when no speaker is set). The whole rail opens the track sheet. **Mute/Solo** and the saved **Volume** fader live in that sheet (same commands as the desktop header and inspector); envelopes stay on **Volume envelope** (drag a point, then edit time/value in the inspector). Do not put a mixer strip in the 3.5rem gutter.

**Arrange density** follows the timeline pane via `@container timeline` on `.timeline-area` (Every Layout Container escape hatch), not `window.innerWidth`:

| Pane inline-size | `--header-width` | Header chrome |
|------------------|------------------|---------------|
| `< 30rem`, and the phone shell | `3.5rem` | Avatar-only header: the 28 px avatar with its level ring and the lane color; the name stays the select button's accessible name; speaker or track identity moves onto clip labels; no grip (Menu → Move track up/down) |
| else | `10.5rem` (root token) | Default header: avatar, name, Mute and Solo icons and the Scrub field for the saved volume (hidden under a coarse pointer and in a lane shorter than 4rem; the level is then in the Mix sheet) |

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
│ Headers │ Timeline (moving playhead) │ Script ┊ │ Inspector card    │
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

The transport bar, status bar and tool rail are gone (#2292), and the Edit tool strip followed in #2294 (W1a): touch has no Alt, so touch splits with the action bar's visible Split button, the S key and the create menu's Split here. Alt-click Split is mouse only. Their jobs moved
to three places, on every shell; there is no narrow or collapsed variant to
test any more.

| Piece | Where | Holds |
|-------|-------|-------|
| App header | Top, 48px (phone: 44px under the safe area) | Project menu (Rename project, All projects, Settings, Connect agent, Help, Appearance; guests get an Appearance button instead (in the Stage menu when the header is narrow)), save indicator, Undo and Redo (right-click Undo opens History), people (`AvatarStack`: 24 px faces that each open a Follow and Go to menu, then a count and the Following pill; phone: one face plus a count), Invite for hosts, search; the Stage bar sits centered on desktop and tablet |
| Stage bar | Header (desktop, tablet) or the bottom tab bar (phone, 56px plus safe area) | Record, Prepare, Edit, Review, Deliver with badges, on Mod+1 to Mod+5 |
| Player bar | Above the tab bar, 56px, every stage but Record (a phone Viewer or Commenter link has the Listen dock instead, with no tab bar) | Play and Pause, time, edited length, the Player's status, comment-at-playhead (not on a Viewer link), and for the host only **Hear original** and the Solo chip |
| Edit corner | Timeline corner (`EditCorner`) | Range arm (touch only, 44 px; the Select/Blade tools, Comment mode and Cut at playhead buttons are gone, #2294), Fit, Zoom out and Zoom in, the Script toggle, and the eye (View options), which opens the View popover (a 240 px non-modal panel anchored to the eye on every shell, in the top layer, flipping above or below by room: chips for host-only Prosody, Silence shading, Volume envelope and Waveforms post-fader at 44 px on touch, the Waveform scale segments Auto, Linear and Log, and the Waveform amplitude scrub field, ×1 to ×16). Escape and an outside press close it; Escape inside the Tools sheet closes the popover alone |

- **Hear menu.** Long-press (touch) or right-click the Hear original button for Full mix (default), Without mix processing and Original. Guests get the mix only. `render.refreshMix` is in the palette and Deliver.
- **Zoom (#1028).** Zoom out and Zoom in (in the corner) run `view.zoomOut` and `view.zoomIn` on the command bus, the same steps as `-` and `=`. At a limit the button is `aria-disabled` with its reason, not `disabled`, so a finger can still tap it and focus stays. Zoom shows for everyone who can open the timeline.
- **Touch targets.** The corner packs its controls into the 48px chrome; buttons are 28px there, below the 44px floor. This is a known limit; the Player bar and tab bar keep `var(--touch-min)`.
- **The phone sheet never covers the header row** (R-short-8). At every detent its slot starts at the header's bottom edge (`bottom-sheet.css`, `--app-header-height-phone` plus the top safe area), so the Stage menu and Tools button stay reachable while a selection is open, including at 200% text. The clearance tokens then count only the rows under the header (`--sheet-header-clearance` is 0 on the phone).
- **Split** cuts at once on touch with no confirm; the toast carries Undo. Sheets rest above the tab bar and Player (`--frame-bottom-chrome`).
- **Undo and Redo** live in the app header on every shell. The phone Inspector sheet does not repeat them.
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
The avatar's ring follows each track's live playback level, and a clipped track
shows a danger ring and badge on the avatar in every header form. **Clear clip
light** lives in the track details, not on the header. The narrow identity
rail shows that passive clipping indicator; open track details to use the labeled
**Clear clip light** action with its shared touch-target floor. The identity target
remains free of the meter's reset hit area. Reduced motion keeps the bar and peak
marker still while the clip light can latch. Pause and Stop
retain that light until cleared.
Phone lanes have a 104px minimum in both fixed and fit modes, leaving separate
touch targets for opening track details and clearing clipping. On a short
screen the minimum is 72px, or 3.25rem with large text (#1077). The saved track
height still applies when it is larger than that minimum.

- Project menu Appearance row (theme) and eye popover (prosody, silence, levels, waveform scale and amplitude; add chapter at the playhead is `edit.addChapter` in the **+** menu)
- Script toggle (`T`, `view.toggleScript`) and Script focus (`Shift+T`, `view.scriptFocus`) instead of layout presets
- Wider invisible hit targets for fades/envelopes
- Status that opens its panel: the Player bar mix ring and Review/Prepare badges on the Stage bar
- Capability-aware chrome for guests
- Pinch-to-zoom on timeline (all shells; spatial claim on `.timeline-scroll` + shared `applyAnchoredZoom` with keys; browser page-zoom does not fight); **the phone-only playhead that holds the center once passed (#1707)**
- Follow: tablet slaves viewport like desktop (People in the header). Phone is listen-along — the Following pill sits in the header beside the faces (glyph and stop button only on a phone), the followed face's ring thickens and the Play button wears their color; the Player keeps a pill only to say why a follow is partial; scrubbing the Player unfollows; Timeline colors the phone needle and still draws other ghosts (never the local guest, whose share WS id is `guest-{token}-…`). Touch floors are `var(--touch-min)` in rem via `@container app` (sheets) and `@container transport` (Project menu rows), not `@media` viewport queries.
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
- gui/web/e2e-compat/compact-feedback-detents.spec.ts::saved feedback stays clear of the sheet's dock and grip at half and full
-->

Host offline command attention occupies its own shell row on phone, tablet, and desktop; queued host edits stay visible while reconnect/replay is pending, and conflict rows can be dismissed. While a compact inspector is open, the one native Details disclosure moves into its existing feedback body header, below the pinned inspector controls. Its explanation and recovery actions use the inspector body scroller; the header actions keep their own space at every detent. In compact half and full detents, the existing Pending review toolbar also starts the scrolling body, so it does not consume the pinned header budget. Regular inspector placement stays unchanged, and the same toolbar keeps its callbacks, review draft and focus across those moves. Otherwise, Details opens a bounded dropdown below the shell row. The shell slot keeps its compact footprint and inspector detents stay unchanged. A stable local portal container preserves native open state and focused recovery controls when the existing host closes, stows, or returns. Switching projects resets the disclosure. Outside the inspector, the dropdown height subtracts its measured row bottom and the bottom safe-area inset. Removing attention or unmounting removes the portal container and cancels position updates. The Role chip remains guest-only.

## Testing
- Vitest: `useViewportClass`, `BottomSheet`, `stage/frame/StageFrame.test.tsx` (phone tab bar, Script and Timeline surfaces, guest stages), follow live region, `stage/hosts/paletteCoverage.test.tsx` (every command that lived in the removed menus is still a catalog command, or its new home is rendered and runs it)
- Playwright: phone viewport (`390×844`) asserts `.stage-frame--phone` and the Stage tab bar (`e2e/stage-shell.spec.ts`); `e2e/overlay-viewport.spec.ts` Project menu and dialog reachability at `1280×715` and `390×844`; `e2e/presence-follow.spec.ts` two-client follow at 390 / 820 / 1440; `e2e-compat/timeline-scroll-end.spec.ts` checks the desktop horizontal end with short lanes and classic scrollbars on Chromium and WebKit. Specs reach chrome only through `e2e/stageNav.ts` ([testing-e2e.md](testing-e2e.md#stage-navigation-helpers))
- Playwright compat: `e2e-compat/phone-chrome.spec.ts` (#1077) checks three 72px lanes sideways at 932×432, the Edit corner, and a page that never scrolls under the frame, in Chromium and WebKit with touch emulation
- Manual / guest parity: [`gui/web/e2e/PARITY.md`](../gui/web/e2e/PARITY.md)
- Manual / guest parity: [`gui/web/e2e/PARITY.md`](../gui/web/e2e/PARITY.md)

See [`gui/web/README.md`](../gui/web/README.md) and [gui-integration.md](gui-integration.md) § Responsive shells.

### Transcript speaker editing

Tap a speaker label to rename or reassign every turn on that track. The editor wraps its input, scope hint, and Save and Cancel controls within the Script. On coarse pointers, speaker labels and the name input use the shared `--touch-min` target size. Hosts and guests with the `edit` capability can save speaker names.

### Transcript find and replace

The Script's Find button exposes **Find and replace** on every shell. On desktop and tablet, the command palette action reveals the Script through the same tab-jump policy. It restores the default layout from timeline or review, retains the transcript layout, and clears timeline key focus when leaving timeline. Revealing a collapsed drawer clears its saved collapsed preference, keeps its previous height, and leaves the panels visible after reload.

The native labeled inputs and preview list wrap within the panel and scroll without replacing the transcript list. Hosts review source-keyed changes and apply the complete set as one Undo action. Different word counts show the source-span timing warning before apply. Shared guests retain the existing text-correction restrictions. See [daw-editing.md](daw-editing.md#transcript-find-and-replace).

### Crossfade length on Timeline

Select a Seam diamond to set its length in the seam sheet: the **Length** Scrub field (from 0 up to what the two clips leave). On a phone the sheet docks above the bar; a drag shows the draft overlap on the timeline and release saves one coupled join change. Canceling restores the saved overlap. Stored unequal fades stay until an intentional edit sets both edges equally.

Moving a clip without dragging, and the panel size controls, are described in [daw-editing.md § Move clips without dragging](daw-editing.md#move-clips-without-dragging).

## Lock screen and background playback on share links (#3785)

A guest who plays an episode from a share link can lock the phone and keep listening, with the lock screen (iPhone) or notification (Android) showing the episode title, the real duration and a moving position, and sending Play, Pause, skip back and forward by seconds, and scrubbing to the page. Host pages do not register any of this yet.

**What the OS adopts as the Now Playing source.**

| Platform | Before | Now |
| --- | --- | --- |
| iPhone Safari | The Web Audio context. It cannot seek, so iOS drops skip and seek and draws track arrows; its lock-screen commands go to the context and never reach the page. | The keep-alive `<audio>` element. It is seekable and routes commands to the page's Media Session handlers. |
| Android Chrome | Nothing. Chromium builds a media session only from media elements longer than 5 s. | The same element. |

**One owner.** `useOsMediaSession` (mounted once in `TransportEngine`) is the only code that writes `navigator.mediaSession`. `projectOsMediaSession` (`audio/osMediaSession.ts`) maps the transport store to metadata, `playbackState`, a position state and a handler switch. It is off, with no metadata, state `none` and null handlers, until playback has started once on a share link's project in this page; it then stays declared through pauses, so a lock-screen Play can resume, until the project changes or the page unmounts. The title is the project name; there is no artist, album or artwork line. The projection is applied again only when `osDiscontinuityKey` changes (play or pause, seek, rate, duration, preview), never per frame: the OS advances the position from the declared rate. State is written before position so Blink and WebKit extrapolate from the fresh value, and the position is written again on every apply because WebKit extrapolates from the time of the last write.

**Handlers.** `play`, `pause`, `seekbackward` and `seekforward` (`SKIP_SEC` unless `details.seekOffset` is a positive finite number) and `seekto` (a missing or non-finite `seekTime` is ignored; `fastSeek` is not special-cased) call the Player's own commands: `transport.togglePlay` through the pointer path, `skipListen` and `seekTransport`. A lock-screen action therefore breaks a Follow like the Player buttons do. `previoustrack` and `nexttrack` are set to `null`: listeners get second skips, not track buttons. `stop` is not registered, because Chrome pauses the element on Stop anyway and the element's `pause` event keeps the listener's place. A locked page paints no frames, so the store playhead is stale: the `pause` handler first copies `livePlayheadSec()` (the audio clock while playing) into the store, and `skipListen` starts from it. What `play` and `pause` do by state:

| State | Lock-screen Play | Lock-screen Pause |
| --- | --- | --- |
| No preview, episode paused | `transport.togglePlay` | nothing |
| No preview, episode playing | nothing | the live clock is copied into the store, then `transport.togglePlay` |
| A source preview is playing | nothing | the preview stops and the episode stays off; a Follow breaks |
| A source preview has ended on its own, `isPlaying` either way | the preview is released to a paused episode, then `transport.togglePlay` plays it; the OS is never told paused in between | as for a playing preview |

The OS shows Pause only while something is audible, so Play after an ended preview plays the episode whatever `isPlaying` says, and runs the same command with the same Follow break, availability guard, rate reset and blocked-proxy retry as the Player's Play. A second Play does nothing. The keep-alive element has its own path (`handleSystemPlay` in `useProxyTransport.ts`): an OS Play that arrives on the element itself, with no handler involved, is honoured only when the Player would honour it and no preview is held, a playing or an ended one; otherwise the element is paused again.

**The keep-alive** (`audio/playbackSession.ts`). One silent 8 kHz 16-bit mono WAV of `KEEP_ALIVE_SEC = 6` s from a `blob:` URL, looped, never muted, created and given its `src` on the first Play so that opening a link never takes over the lock screen from the listener's own music. The contract is fixed by the engines: it must load (the page CSP allows `blob:`, not `data:`), last more than 5 s (Chromium treats less as transient and never controllable) and stay unmuted (WebKit excludes muted elements). `navigator.audioSession.type` is set to `"playback"` on enter and never reset. `ProxyEngine.play` and `pause` still enter and leave the session, and `pause` still suspends the context.

**Two stop paths for the OS stopping the sound.** Both end in `pauseFromSystem(engine.pause())`, which writes through the setters so it does not end a Follow. (1) The keep-alive's `pause` event, counted only while the app is entered and the element is paused. (2) A guarded `statechange` on the audio context, acted on only while the engine plays and its `resume()` has settled and the state is not `running`; the engine sets `playing = false` before any internal suspend. If the OS resumes the keep-alive after the app left (a call or Siri ended), `onSystemPlay` resumes the episode; if it does not, the episode stays paused. The end of the episode takes the same path.

**What only a device proves.** The Playwright specs (`e2e/guest-os-media-session.spec.ts` on the Pixel 7 and iPhone 15 Pro descriptors, `e2e-compat/guest-keep-alive.spec.ts` in Chromium and WebKit) prove what the page registers, that each action drives the real transport and that the blob loads under the real CSP. They do not prove the iOS or Android UI. Device checklist (force-quit Safari first, so the engine cold-starts; note the iOS and Chrome versions):

1. Before Play, open the link while your own music app plays: it keeps the lock screen.
2. iPhone: Play, lock. Expect the title, back 15 and forward 15 (not track arrows), the real duration and a moving position.
3. Pause from the lock screen, wait 30 s, press Play: sound resumes at the same place; unlock and the app agrees.
4. Skip back and forward, and drag the scrubber: audio and the app follow.
5. Play locked for 5 minutes untouched: sound continues (needs the #3788 scheduler).
6. Take a call or invoke Siri while locked and end it: the lock screen and the app agree, never "Pause" over silence.
7. AirPods click toggles; the Control Centre player matches the lock screen; the silent switch does not mute playback.
8. Android: Play, pull the shade, lock. Expect the title, seek back and forward, no previous or next, the real duration. Pause, Play, seek and drag the bar from the notification; take a call; dismiss the notification (paused, place kept).
9. iPhone, cold Safari: Play, lock, flip the silent switch. Sound continues, and a music app that was playing before you opened the link is not displaced until you press Play in the page.
10. Locked: skip, then drag the scrubber. The lock screen position follows the new place at once, not the old one.
11. Phone call, Siri, headphone unplug, Bluetooth disconnect: iPhone stays paused, Android resumes after the interruption, and the app agrees with the lock screen.
12. Android: Play, notification Pause, locked for 10+ minutes, then notification Play: sound resumes at the same place.
13. After the end, Play from the lock screen reads 0 and starts again. On a cold iPhone, a quick Play, Pause, Play ends playing, not paused.
14. Music app playing, open the link, press a headphone Play before the first in-page Play: the page claims nothing and the music keeps going.

If the lock-screen Play shows Pause over silence, move the `isPlaying` to element mirror onto a synchronous store subscription. If sound stops at lock on an iOS version with the background audio-context regression (WebKit bug 261554, fixed in iOS 17.5), route the context into a `MediaStreamAudioDestinationNode` and play that from the element. Neither ships until a device shows the failure.
