# Sharecut Studio keyboard shortcuts

Engineer reference for Sharecut Studio shortcuts and the command bus.

Partner-facing copy (UX site / Google Docs): [ux/pages/shortcuts.md](../ux/pages/shortcuts.md) — live at [ux.sharecut.studio/#/shortcuts](https://ux.sharecut.studio/#/shortcuts) (**Copy Markdown** → paste into Google Docs).

Full host surface matrix (command / MCP / CLI / skill): [docs.sharecut.studio/#/capabilities](https://docs.sharecut.studio/#/capabilities).

<!-- keymap-cheatsheet:generated -->

> **Auto-generated** from [`gui/web/src/keymap/registry.ts`](../gui/web/src/keymap/registry.ts) and [`gui/web/src/commands/catalog.ts`](../gui/web/src/commands/catalog.ts). Do not edit by hand — run `make cheatsheet`.

Shortcuts dispatch through the Sharecut Studio command bus (`execute(id)`). Character keys (letters, digits, Space) are scoped by context (WCAG 2.1.4). **Mod** = ⌘ on macOS / Ctrl elsewhere.

Open the in-app cheatsheet with **?** while Sharecut Studio is focused.

## transport

| Shortcut | Command | When | Notes |
|----------|---------|------|-------|
| `Space` | Play / pause (`transport.togglePlay`) | Timeline or transcript focused | When timeline or transcript is focused |
| `K` | Stop playback (`transport.stop`) | Always (when not typing in an input) |  |
| `Mod+B` | Refresh mix (`render.refreshMix`) | Refresh mix allowed | Mod+B — rebuild stems/premix when host or Docs Editor |

## tools

| Shortcut | Command | When | Notes |
|----------|---------|------|-------|
| `V` | Select tool (`tool.select`) | Timeline focused + structural edits allowed | When timeline is focused |
| `C` | Blade tool (`tool.blade`) | Timeline focused + structural edits allowed | When timeline is focused |

## focus

| Shortcut | Command | When | Notes |
|----------|---------|------|-------|
| `1` | Focus: default layout (`focus.default`) | Timeline or transcript focused |  |
| `2` | Focus: timeline (`focus.timeline`) | Timeline or transcript focused |  |
| `3` | Focus: text (`focus.text`) | Timeline or transcript focused |  |
| `4` | Focus: review (`focus.review`) | Timeline or transcript focused |  |

## navigation

| Shortcut | Command | When | Notes |
|----------|---------|------|-------|
| `ArrowLeft` | Nudge playhead back (`navigation.nudgePlayheadBack`) | Always (when not typing in an input) | Shift for 5 seconds |
| `ArrowRight` | Nudge playhead forward (`navigation.nudgePlayheadForward`) | Always (when not typing in an input) | Shift for 5 seconds |
| `Mod+ArrowLeft` | Go to start (`navigation.goToStart`) | Always (when not typing in an input) | Mod+ArrowLeft — Home alias for laptops |
| `Home` | Go to start (`navigation.goToStart`) | Always (when not typing in an input) | Also Mod+ArrowLeft (laptops without Home) |
| `Mod+ArrowRight` | Go to end (`navigation.goToEnd`) | Always (when not typing in an input) | Mod+ArrowRight — End alias for laptops |
| `End` | Go to end (`navigation.goToEnd`) | Always (when not typing in an input) | Also Mod+ArrowRight (laptops without End) |

## review

| Shortcut | Command | When | Notes |
|----------|---------|------|-------|
| `Escape` | Exit comment mode (`review.exitCommentMode`) | Comment mode on |  |
| `Mod+Shift+C` | Toggle comment mode (`review.toggleCommentMode`) | Always (when not typing in an input) | Mod+Shift+C |
| `Enter` | Apply tighten hit (`tighten.applyHit`) | tightenPanelOpen | Enter — selected tighten hit |
| `Backspace` | Skip tighten hit (`tighten.skipHit`) | tightenPanelOpen | Backspace — selected tighten hit |
| `Mod+Shift+Enter` | Apply eligible tighten hits (`tighten.applyAllSafe`) | tightenPanelOpen | Mod+Shift+Enter — skip harsh when Avoid harsh cuts is on |
| `P` | Preview tighten hit (`tighten.previewHit`) | tightenPanelOpen | P — Suggested skip when possible |

## history

| Shortcut | Command | When | Notes |
|----------|---------|------|-------|
| `Mod+Z` | Undo (`history.undo`) | Project loaded | Mod+Z |
| `Mod+Shift+Z` | Redo (`history.redo`) | Project loaded | Mod+Shift+Z |

## edit

| Shortcut | Command | When | Notes |
|----------|---------|------|-------|
| `Escape` | Clear selection (`edit.clearSelection`) | hasInspectorSelection | After exitCommentMode; does not clear track targeting |
| `Mod+C` | Copy (`edit.copy`) | Project loaded | Mod+C |
| `Mod+X` | Cut (`edit.cut`) | Host or shared edit mode | Mod+X |
| `Mod+V` | Paste (`edit.paste`) | Host or shared edit mode | Mod+V — same-track at playhead |
| `Backspace` | Remove track (`track.remove`) | trackInspectorSelected | Before edit.delete — inspector track selection only |
| `ArrowUp` | Move track up (`track.moveUp`) | canMoveSelectedTrackUp | Inspector track selected |
| `ArrowDown` | Move track down (`track.moveDown`) | canMoveSelectedTrackDown | Inspector track selected |
| `Backspace` | Delete clip (`edit.delete`) | Structural edits allowed |  |
| `Mod+Backspace` | Ripple delete clip (`edit.rippleDelete`) | Structural edits allowed | Mod+Backspace |
| `Mod+K` | Blade cut at playhead (`edit.bladeCut`) | Structural edits allowed | Mod+K — cut at playhead |
| `Mod+A` | Select all tracks (`track.selectAll`) | Timeline focused | Mod+A — Logic-style track targeting |
| `Mod+Shift+A` | Deselect all tracks (`track.deselectAll`) | Timeline focused | Mod+Shift+A — Logic-style; empty targeting |
| `M` | Toggle track mute (`track.muteToggle`) | Project loaded |  |
| `S` | Toggle track solo (`track.soloToggle`) | Project loaded |  |
| `Mod+Shift+T` | New track (`track.add`) | Media ingest allowed | Mod+Shift+T (Shift avoids browser New Tab; Reaper uses Mod+T) |
| `Mod+I` | Import audio (`media.import`) | Media ingest allowed | Mod+I — Menu or drop on arrange |

## view

| Shortcut | Command | When | Notes |
|----------|---------|------|-------|
| `=` | Zoom in (`view.zoomIn`) | Timeline focused | Timeline focused; also numpad + |
| `-` | Zoom out (`view.zoomOut`) | Timeline focused | Timeline focused; also numpad - |
| `\` | Fit session in view (`view.fit`) | Timeline focused | Timeline focused |
| `Shift+ArrowUp` | Waveform amplitude zoom in (`view.waveformZoomIn`) | Timeline focused | Shift+ArrowUp — timeline focused |
| `Shift+ArrowDown` | Waveform amplitude zoom out (`view.waveformZoomOut`) | Timeline focused | Shift+ArrowDown — timeline focused |

## ui

| Shortcut | Command | When | Notes |
|----------|---------|------|-------|
| `M` | Record marker (`record.marker`) | recordPanelOpen | M — live marker while the record panel is open; with the panel closed, M still mutes the targeted track |
| `?` | Command cheatsheet (`ui.toggleCommandPalette`) | Always (when not typing in an input) | Also Shift+/ |
| `Mod+Shift+B` | Bounce… (`export.bounce`) | Loaded host project | Mod+Shift+B — bounce dialog (export/bounces/) |
| `Mod+Shift+E` | Export deliverables (`export.deliverables`) | Host project management | Mod+Shift+E — mastered export/ via PipelineService |
| `Mod+N` | New project (`project.new`) | Host project management | Mod+N |
| `Mod+O` | Open project (`project.open`) | Host project management | Mod+O — OS dialog via local engine; paste path fallback |

## presence

| Shortcut | Command | When | Notes |
|----------|---------|------|-------|
| `Escape` | Stop following (`presence.unfollow`) | While following another client |  |

## Commands without default keys

Available via toolbar / `execute` (and the in-app palette). Agents use session/document APIs — not these ids.

| Command | Id | When | Notes |
|---------|----|------|-------|
| Seek playhead | `transport.seek` | Always (when not typing in an input) | Args: { sec: number } |
| Audition Mix / FX / Raw | `transport.audition` | Project loaded | Args: { mode: mix \| fx \| raw } |
| Follow | `presence.follow` | Always (when not typing in an input) | Args: { clientId: string } |
| Cycle focus mode | `focus.cycle` | Always (when not typing in an input) |  |
| Confirm blade cut | `edit.bladeCut.confirm` | Structural edits allowed |  |
| Cancel blade cut | `edit.bladeCut.cancel` | Always (when not typing in an input) |  |
| Share… | `share.manage` | Host project management | Open host share dialog — live links, create, revoke |
| Start recording | `record.start` | Host project management |  |
| Pause recording | `record.pause` | Host project management |  |
| Resume recording | `record.resume` | Host project management |  |
| Stop recording | `record.stop` | Host project management |  |
| Land recording on timeline | `record.land` | Host project management |  |
| Record panel | `record.openPanel` | Host project management |  |
| Connect agent… | `mcp.connect` | Host project management | Copy local Streamable HTTP MCP URL for Cursor/Claude |
| Help… | `help.diagnosticsBundle` | Host project management | Host-only sanitized diagnostics zip for bug reports |
| Reorder track | `track.reorder` | Media ingest allowed | Args: { trackId?, index } — ReorderTrack; drag headers use skipWhen |
| Annotate transcript | `view.transcriptAnnotate` | Always (when not typing in an input) |  |
| Correct transcript | `transcript.correctIntent` | Project loaded |  |
| Select transcript range | `transcript.selectIntent` | Project loaded |  |
| Show cut away | `view.showCutAway` | Always (when not typing in an input) |  |
| Trim clip edge | `edit.trimClipEdge` | Host or shared edit mode | Pointer trim handles on clip blocks (start / end) |
| Roll clip join | `edit.rollClipJoin` | Host or shared edit mode | Join diamond + transcript boundary roll both edges |
| Set clip fade | `edit.setClipFade` | Host or shared edit mode | Pointer fade handles on clip blocks |
| Move clips | `edit.moveClips` | Host or shared edit mode | Pointer body drag on clip blocks (one clip or a multi-selection; not MoveSegment) |
| Focus edit boundary | `view.focusEditBoundary` | Project loaded |  |
| Focus cut-away word | `view.focusCutAwayWord` | Project loaded |  |
| Switch editor tab | `view.setTab` | Project loaded | Args: { tab: DawTab } |
| Switch phone mode | `view.setMobileMode` | Project loaded | Args: { mode: MobileMode, destination?: MoreDestination } |
| Go to tighten hit | `tighten.goToHit` | tightenPanelOpen | Args: { id?: string } — seek + select pending |

## Governance

- New shortcuts: add a `KEYMAP_COMMANDS` row + `commands/` handler; call `execute` from buttons.
- Never add a second window `keydown` listener — see `gui/web/src/commands/governance.test.ts`.
- Regenerate this page: `make cheatsheet`. CI/pre-commit: `make cheatsheet-check`.
<!-- /keymap-cheatsheet:generated -->
