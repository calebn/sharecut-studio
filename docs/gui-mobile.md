# Sharecut Studio mobile & responsive UX

> **Non-technical overview:** [ux/pages/mobile.md](../ux/pages/mobile.md) — what mobile does and why, for partners and users.

Phone- and tablet-first shells for Sharecut Studio, plus desktop polish shared with those patterns. Desktop keeps the Reaper-style grid; phone does **not** shrink that grid.

Canonical strategy and feature map for agents/contributors. Implementation lives under `gui/web/`.

## Breakpoints

| Shell | Width | Root class | Layout |
|-------|-------|------------|--------|
| Phone | `< 768px` | `data-shell="phone"` / `.daw-shell--phone` | Four modes + selection sheet |
| Tablet | `768–1100px` | `data-shell="tablet"` / `.daw-shell--tablet` | Timeline + peek inspector sheet (portrait); side inspector when wide enough |
| Desktop | `> 1100px` | `data-shell="desktop"` | Reaper four-pane grid + optional focus modes |

Hook: [`gui/web/src/hooks/useViewportClass.ts`](../gui/web/src/hooks/useViewportClass.ts) (`matchMedia` + `visualViewport` resize). Store mirrors `shellBreakpoint`. CSS class stem `.daw-shell*` is frozen BEM (`StudioShell` / `MobileShell`); do not rename it in lockstep with the TypeScript component.

Chrome type/space is rem via theme tokens. Pane density (status chips, pipeline, header rail) follows named `@container` (`app` on `.daw-shell`, `timeline` on `.timeline-area`), not viewport-width `@media`. Short-viewport `@media (max-height: 40rem)` for portaled sheets is a documented exception (`-- user-approved:`). Policy: [.agents/rules/gui-styling.md](../.agents/rules/gui-styling.md).

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
| **More** | Hub → Comments, History, Impact, Tighten, Pipeline, settings | Long-lived panels |

While `project === null` (progressive load), Listen keeps its single body transport with disabled play and a “Loading episode…” well; the shell header row is absent. Timeline shows skeleton lanes below its compact header transport and gutter grid. That chrome is not the ingest empty-session coach.

Selection opens a non-modal **half → full** [`BottomSheet`](../gui/web/src/ui/BottomSheet.tsx) wrapping the same inspector views as desktop (`aria-modal="false"`, Escape + focus restore, no chrome `inert` / Tab trap). Modifier sheets (pending, clip, track, chapter — any `.modifier-inspector`) pin the mutation error and audition footer; long Ask threads scroll in the body; long mutation errors scroll inside a capped error slot. The taller half peek (`:has(.modifier-inspector)`) applies to every modifier, not only pending. Sheets are transient: visible Close, no stacking (drill to a More destination instead). Deferred: mutation error across shell remount, Firefox layout CI, overlapping Approve — [ROADMAP.md § Follow-up](../ROADMAP.md#follow-up).

### Selection sheet: three zones

Every selection sheet follows the same three-zone layout for consistency:

1. **Primary actions** — the inspector content itself (2-3 most common actions, large targets)
2. **Related commands** ("You might also want…") — supported next actions for this selection, currently Copy for clips and single selected transcript words. Transcript ranges stay in Text; contextual range Copy is deferred under #32, while keyboard Copy remains available.
3. **More** — a distinct overflow below Related. It currently truthfully reports when no additional safe action exists; unavailable, duplicate, and inspector-owned mutations are omitted. A functional context-filtered command list remains open in issue #32. Both zones live in `RelatedCommands` (`gui/web/src/inspector/RelatedCommands.tsx`), with typed mappings in `relatedCommandDescriptors.ts`.

Example: Clip selected → Related shows Copy; More reports no additional action because fade/delete are clip-inspector controls and seeking is already in its footer.

### Feature → home map

| Desktop region | Phone home |
|----------------|------------|
| Transport play/time/audition | Listen body transport; compact header transport on Timeline, Text, and More; audition/zoom in Menu |
| Comment / Fit | Header primary **icons** outside Listen; Fit is available on Timeline and in the non-Listen Menu |
| Track headers M/S/FX | Lane gutter tap (whole row + ›) → track sheet (**M**/**S** toggles + gain readout; drag Levels for envelopes). Header mixer chrome hidden when the timeline pane is narrow |
| Timeline overlays | Timeline mode + layer chips |
| Inspector | Selection sheet |
| Transcript tab | Text mode |
| Comments | Listen list + More → Comments |
| History / Impact / Tighten / Pipeline | More hub |
| Status bar | Actionable chips (tap → panel) except **Activity** (`kind=agent`), which is status-only until the activity-history drawer; Listen **Pending** selects first review-required pending and opens Timeline; **Stale render** uses the shared render-status breakdown, so a new empty project stays fresh; **Pipeline** chip shows truncated headline, elapsed, and pulse (not `●`) and opens Pipeline; **Activity** chip uses the same chrome plus a count badge when more than one job is live |

### Gestures

Touch gestures for common actions, documented in the **Gestures** cheatsheet (More hub → Gestures). It is an app-level modal (outside inert app chrome) and can switch directly to **Keyboard shortcuts**; that dialog links back to Gestures without stacking. Executable gesture actions reference the shared command catalog, while unimplemented proposals are explicitly marked planned.

Two-finger Undo is active only while a project is loaded and the shared Undo command is available. Its recognizer yields to timeline pinch/rotation and rejects delayed, moving, or cancelled contacts so zooming does not also undo an edit.

| Gesture | Command | Status |
|---------|---------|--------|
| Two-finger tap | Undo | Available |
| Long-press | Context actions (selection sheet) | Planned (Soon) |
| Pinch | Zoom in/out on timeline | Available |
| Swipe left on comment | Resolve | Planned (Soon) |
| Double-tap word | Correct word | Planned (Soon) |

## Wireframes (ASCII)

### Phone — Listen

```
┌─ Play  Stop  12:34 / 58:39 ───────┐
│ ══════════●═══════════════════    │  ← coarse scrub
│ ±15s                              │
│ Pending: 3  ·  Stale render       │  ← chips (Pending → Timeline + first review-required)
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
│ Edits Levels Markers Comments     │  ← chips
│ ┌─ref│░░░░░░░░░░░░░░░░░░░░░░░░░░ │ │
│ │gue│░░░░░░░░░░░░░░░░░░░▼░░░░░░ │ │  ← slim sticky gutter + CapCut ▼
│ └────┴───────────────────────────┘ │
│         drag timeline to scrub    │
├─ Listen | Timeline | Text | More ─┤
│ ┌ sheet: track / Pending cut ─ X ┐ │
│ │ M · S · gain readout / Approve │ │
│ └───────────────────────────────┘ │
```

Lane identity is a **Ferrite-style sticky gutter** beside the waveforms (same scroller; `headerSlot` into `TimelineView`). A trailing **›** disclosure marks that the whole row opens the track sheet. **Mute/Solo** live in that sheet (same commands as the desktop header); gain is a readout there — envelopes stay on **Levels** (drag a point, then edit time/value in the inspector). Do not put a mixer strip in the 4rem gutter.

**Arrange density** follows the timeline pane via `@container timeline` on `.timeline-area` (Every Layout Container escape hatch), not `window.innerWidth`:

| Pane inline-size | `--header-width` | Header chrome |
|------------------|------------------|---------------|
| `< 30rem` | `4rem` | Gutter: color bar + truncated name + › disclosure |
| `< 68.75rem` | `8.75rem` | Mid mixer rail |
| else | `11.25rem` (root token) | Full desktop headers |

Headers stay `flex-wrap: nowrap` beside the time Reel — Sidebar’s wrap-when-narrow would stack identity above lanes (the bug we avoid). Shell mount (phone four-mode vs tablet/desktop) still uses `useViewportClass`; only rail width and mixer chrome follow the container.

A wide phone landscape pane can show the mid rail; a narrow desktop pane (inspector eating space) can show the gutter. That is intentional.

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

### Desktop — focus modes

| Mode | Effect |
|------|--------|
| `default` | Full grid |
| `timeline` | Collapse bottom tabs (more lane height) |
| `text` | Expand transcript; shrink timeline; dock Correct word editor when a word is selected |
| `review` | Comments tab + mix-oriented chrome |

Keyboard: `1` default, `2` timeline, `3` text, `4` review (when timeline focused, not in inputs). Pane **Focus** toggles on timeline chrome, transcript toolbar, and Comments tab call the same `focus.*` commands.

## Interaction principles

1. One job per phone screen (no timeline + full transcript + inspector).
2. ≥44×44pt targets; fade/envelope hit areas ≥2× visual width.
3. Sheets: Close + dismiss; never stack.
4. Dialog overlays cap to `90dvh` with a single `.command-palette-body` scroller. Menus cap to `min(90dvh, var(--menu-available-height))`, where `--menu-available-height` is remaining space under the trigger (above phone `.mobile-nav` when present), and scroll internally so every item stays reachable on short viewports.
5. Snap only to on-screen anchors.
6. Listen-first: every edit surface keeps Play around / seek footer.
7. Progressive complexity via `shareMode` capabilities.

## Transport chrome (narrow)

When the transport is **collapsed** (tablet/phone, or bar width ≤720px via ResizeObserver):

| Tier | Controls |
|------|----------|
| Primary (always visible) | Play/Stop, compact playhead timecode, **Comment** icon, **Fit** (except Listen), Menu icon |
| Menu → People | Live roster (follow / unfollow) when the bar is collapsed. Rows are `var(--touch-min)` (`2.75rem`) via `@container transport`. |
| Menu → Project (host) | New / Open, **Connect agent…**, Bounce…, **Share…** (collaboration extension), Export deliverables. Home also has **Connect agent…** |
| Menu (secondary) | Audition Mix/FX/Raw, layers, zoom, theme, focus, **Refresh mix** when render is stale, Fit if omitted from bar |

### Editing tool rail (phone / tablet Timeline)

Ferrite-style bottom rail (`EditingToolRail`): **Select | Blade** icon toggle (structural guests), **Cut at playhead**, and a confirm sheet for blade cuts (tracks + timecode). **Comment** stays on the collapsed transport so Listen/More still have it (compact `ToolModeToggle` omits Comment to avoid a duplicate). Desktop uses the expanded transport toggle (**V** / **C** when timeline-focused; same `execute` command bus as the rail — see `gui/web/src/keymap/` + `gui/web/src/commands/`); in blade mode a pointer-following cut preview marks target lanes, and click on **clip / empty-lane / ruler** splits immediately (no confirm sheet). Multi-track selection: Shift/Cmd-click track headers; blade with no selection targets all dialogue tracks.

Labeled audition/pills do not stay in the bar when collapsed — that was clipping Comment/Fit/Menu off-screen. The **Stale render** pill is wide-bar only; collapsed transport keeps timecode pinned (`flex: 0 0 auto`) and moves refresh into Menu so digits cannot paint over status.

## Desktop / tablet back-apply

Keep the Reaper grid. Shared polish:

- Transport overflow (theme, layers, zoom, + Chapter secondary)
- Focus modes (above)
- Wider invisible hit targets for fades/envelopes
- Actionable status chips → Impact / Pipeline / Comments
- Capability-aware chrome for guests
- Pinch-to-zoom on timeline (all shells; spatial claim on `.timeline-scroll` + shared `applyAnchoredZoom` with keys; browser page-zoom does not fight); **fixed-center playhead is phone-only**
- Follow: tablet slaves viewport like desktop (People in Menu). Phone is listen-along — banner is its own grid row (`daw-shell--following`); Listen scrub/±15s unfollows; Timeline colors the center needle and still draws other ghosts (never the local guest, whose share WS id is `guest-{token}-…`). Touch floors are `var(--touch-min)` in rem via `@container app` (banner, More hub) and `@container transport` (Menu rows), not `@media` viewport queries.
- Track headers lock vertically with lanes inside one scroller (sticky on inline-start). Density (gutter vs mixer rail) follows `@container timeline` on `.timeline-area`. Zoom hit-tests the time column, not mute/solo.

Do **not** bring phone bottom-nav or CapCut fixed playhead to desktop.

Host offline command attention occupies its own shell row on phone, tablet, and desktop; queued host edits stay visible while reconnect/replay is pending, and conflict rows can be dismissed. The share-mode label remains guest-only.

## Testing

- Vitest: `useViewportClass`, `BottomSheet`, mobile shell smoke, follow live region + Listen unfollow, focus mode CSS classes
- Playwright: phone viewport (`390×844`) asserts `.daw-shell--phone` + mode nav; `e2e/overlay-viewport.spec.ts` Menu + Share dialog reachability at `1280×715` and `390×844`; `e2e/presence-follow.spec.ts` two-client follow at 390 / 820 / 1440; desktop smoke unchanged
- Manual / guest parity: [`gui/web/e2e/PARITY.md`](../gui/web/e2e/PARITY.md)

See [`gui/web/README.md`](../gui/web/README.md) and [gui-integration.md](gui-integration.md) § Responsive shells.
