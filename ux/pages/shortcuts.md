# Keyboard shortcuts

ShareCut Studio shortcut reference for hosts and UX partners.

> **Google Docs:** use **Copy Markdown** on this UX site, then paste into Docs. Keep this page as the source of truth — it regenerates from the product keymap.

Live product cheatsheet: press **?** in ShareCut Studio.

Host capability matrix (GUI / MCP / CLI / skills): [docs.sharecut.studio/#/capabilities](https://docs.sharecut.studio/#/capabilities).

<!-- keymap-cheatsheet:generated -->

> **Auto-generated** from [`gui/web/src/keymap/registry.ts`](https://github.com/calebn/sharecut-studio/blob/main/gui/web/src/keymap/registry.ts) and [`gui/web/src/commands/catalog.ts`](https://github.com/calebn/sharecut-studio/blob/main/gui/web/src/commands/catalog.ts). Do not edit by hand — run `make cheatsheet`.

Shortcuts dispatch through the ShareCut Studio command bus (`execute(id)`). Character keys (letters, digits, Space) are scoped by context (WCAG 2.1.4). **Mod** = ⌘ on macOS / Ctrl elsewhere.

Open the in-app cheatsheet with **?** while ShareCut Studio is focused.

## transport

| Shortcut | Command | When | Notes |
|----------|---------|------|-------|
| `Space` | Play / pause (`transport.togglePlay`) | Timeline or transcript focused | When timeline or transcript is focused; Shift+Space is Hear |
| `K` | Stop playback (`transport.stop`) | Always (when not typing in an input) | K alone stops playback; Mod+K splits at the playhead |
| `Mod+B` | Refresh mix (`render.refreshMix`) | Refresh mix allowed | Mod+B: rebuild stems/premix when host or Docs Editor |

## navigation

| Shortcut | Command | When | Notes |
|----------|---------|------|-------|
| `Mod+1` | Go to Record (`stage.record`) | Project loaded | Mod+1; a browser tab may keep Mod+1–5 for tab switching, so use the Stage bar there (desktop app unaffected) |
| `Mod+2` | Go to Prepare (`stage.prepare`) | Project loaded | Mod+2; a browser tab may keep Mod+1–5 for tab switching, so use the Stage bar there (desktop app unaffected) |
| `Mod+3` | Go to Edit (`stage.edit`) | Project loaded | Mod+3; a browser tab may keep Mod+1–5 for tab switching, so use the Stage bar there (desktop app unaffected) |
| `Mod+4` | Go to Review (`stage.review`) | Project loaded | Mod+4; a browser tab may keep Mod+1–5 for tab switching, so use the Stage bar there (desktop app unaffected) |
| `Mod+5` | Go to Deliver (`stage.deliver`) | Project loaded | Mod+5; a browser tab may keep Mod+1–5 for tab switching, so use the Stage bar there (desktop app unaffected) |
| `ArrowLeft` | Nudge playhead back (`navigation.nudgePlayheadBack`) | Always (when not typing in an input) | Shift for 5 seconds |
| `ArrowRight` | Nudge playhead forward (`navigation.nudgePlayheadForward`) | Always (when not typing in an input) | Shift for 5 seconds |
| `Mod+ArrowLeft` | Go to start (`navigation.goToStart`) | Always (when not typing in an input) | Mod+ArrowLeft: Home alias for laptops |
| `Home` | Go to start (`navigation.goToStart`) | Always (when not typing in an input) | Also Mod+ArrowLeft (laptops without Home) |
| `Mod+ArrowRight` | Go to end (`navigation.goToEnd`) | Always (when not typing in an input) | Mod+ArrowRight: End alias for laptops |
| `End` | Go to end (`navigation.goToEnd`) | Always (when not typing in an input) | Also Mod+ArrowRight (laptops without End) |

## review

| Shortcut | Command | When | Notes |
|----------|---------|------|-------|
| `Enter` | Apply tighten hit (`tighten.applyHit`) | tightenPanelOpen | Enter: selected tighten hit |
| `Backspace` | Skip tighten hit (`tighten.skipHit`) | tightenPanelOpen | Backspace: selected tighten hit |
| `Mod+Shift+Enter` | Apply suggested actions (`tighten.applySuggested`) | tightenPanelOpen | Mod+Shift+Enter: every listed sound gets its own suggested action |
| `P` | Preview tighten hit (`tighten.previewHit`) | tightenPanelOpen | P: rendered Suggested preview when possible |
| `C` | Add comment (`comment.draftAt`) | Host or a link that can comment | C: comment on the selection, else at the playhead; Mod+C is Copy |

## history

| Shortcut | Command | When | Notes |
|----------|---------|------|-------|
| `Mod+Z` | Undo (`history.undo`) | Something to undo | Mod+Z |
| `Mod+Shift+Z` | Redo (`history.redo`) | Something to redo | Mod+Shift+Z |

## edit

| Shortcut | Command | When | Notes |
|----------|---------|------|-------|
| `F2` | Edit focused transcript word (`transcript.editWordInline`) | Loaded host project | F2: focused word in Navigate mode |
| `Escape` | Clear selection (`edit.clearSelection`) | hasInspectorSelection | Closes the Inspector first, then clears the selection and track targeting |
| `ArrowLeft` | Set clip fade (`edit.setClipFade`) | focusedFadeHandle | Left/Right 1 ms; Shift 10 ms. Release to save; Escape cancels. |
| `ArrowLeft` | Trim clip edge (`edit.trimClipEdge`) | focusedTrimHandle | Left/Right 10 ms; Shift 100 ms. Release to save; Escape cancels. |
| `Mod+C` | Copy (`edit.copy`) | editStage | Mod+C |
| `Mod+X` | Cut (`edit.cut`) | editStagePass12 | Mod+X |
| `Mod+V` | Paste (`edit.paste`) | editStagePass12 | Mod+V: same-track at playhead |
| `Backspace` | Remove track (`track.remove`) | editStageTrackInspector | Before edit.delete: inspector track selection only |
| `ArrowUp` | Move track up (`track.moveUp`) | editStageMoveSelectedTrackUp | Inspector track selected |
| `ArrowDown` | Move track down (`track.moveDown`) | editStageMoveSelectedTrackDown | Inspector track selected |
| `Shift+F10` | Create here (`create.menu`) | Timeline focused | Shift+F10: create menu at the focused target or the playhead; the Menu key too |
| `Backspace` | Cut selection (`edit.delete`) | editStageStructural |  |
| `Mod+Backspace` | Ripple delete clip (`edit.rippleDelete`) | editStageStructural | Mod+Backspace |
| `Mod+K` | Split at playhead (`edit.bladeCut`) | editStageStructural | Mod+K: split at the playhead — Mod+K splits; K alone stops playback |
| `Mod+A` | Select all tracks (`track.selectAll`) | Timeline focused | Mod+A: Logic-style track targeting |
| `Mod+Shift+A` | Deselect all tracks (`track.deselectAll`) | Timeline focused | Mod+Shift+A: Logic-style; empty targeting |
| `M` | Mute (`edit.mute`) | Project loaded | M mutes what is selected (words, a range, a clip), else the targeted track; on the Record stage, M drops a marker instead |
| `Shift+S` | Toggle track solo (`track.soloToggle`) | Project loaded | Shift+S: S is Split |
| `S` | Split (`edit.split`) | editStageStructural | S: split at the playhead, or at both edges of the selected words or range, as one undo step — S splits; Shift+S solos the targeted track; Mod+K splits at the playhead |
| `Space` | Hear (`edit.hear`) | editStage | Shift+Space: hear the selection |
| `A` | Hear before (`edit.hearBefore`) | editStage | A: the suggestion as it is now |
| `B` | Hear after (`edit.hearAfter`) | editStage | B: the suggestion applied |
| `X` | Keep (`edit.keep`) | editStage | X: keep what is cut or reject the selected suggestion; Mod+X is Cut to the clipboard |
| `I` | Inspect (`edit.inspect`) | editStage | I: open or close the Inspector for the selection; Mod+I is Import |
| `.` | More (`edit.more`) | editStage | .: open the Action bar's More menu |
| `Shift+C` | Add chapter at playhead (`edit.addChapter`) | Loaded host project | Shift+C: add a chapter at the playhead |
| `Mod+Shift+T` | New track (`track.add`) | editStageIngest | Mod+Shift+T (Shift avoids browser New Tab; Reaper uses Mod+T) |
| `Mod+I` | Import audio… (`media.import`) | Media ingest allowed | Mod+I: Menu or drop on arrange |

## view

| Shortcut | Command | When | Notes |
|----------|---------|------|-------|
| `=` | Zoom in (`view.zoomIn`) | Timeline focused | Timeline focused; also numpad + |
| `-` | Zoom out (`view.zoomOut`) | Timeline focused | Timeline focused; also numpad - |
| `\` | Fit session width (`view.fit`) | Timeline focused | Timeline focused |
| `T` | Show or hide Script (`view.toggleScript`) | Project loaded | Edit stage; Mod+Shift+T is New track |
| `Shift+T` | Script focus (`view.scriptFocus`) | Project loaded | Shift+T: Edit stage |
| `Shift+ArrowUp` | Waveform amplitude zoom in (`view.waveformZoomIn`) | Timeline focused | Shift+ArrowUp: timeline focused |
| `Shift+ArrowDown` | Waveform amplitude zoom out (`view.waveformZoomOut`) | Timeline focused | Shift+ArrowDown: timeline focused |
| `Alt+=` | Increase track height (`view.trackHeightIncrease`) | Timeline focused | Alt+=: timeline focused; 72 / 104 / 144 / 192 / 240 px |
| `Alt+-` | Decrease track height (`view.trackHeightDecrease`) | Timeline focused | Alt+-: timeline focused |

## ui

| Shortcut | Command | When | Notes |
|----------|---------|------|-------|
| `M` | Record marker (`record.marker`) | recordStageActive | M: live marker on the Record stage; on any other stage, M still mutes — M drops a marker only on the Record stage; otherwise M mutes |
| `?` | Commands and shortcuts (`ui.toggleCommandPalette`) | Always (when not typing in an input) | Also Shift+/ |
| `Mod+Shift+B` | Bounce… (`export.bounce`) | Loaded host project | Mod+Shift+B: bounce dialog (export/bounces/) |
| `Mod+Shift+E` | Export deliverables… (`export.deliverables`) | Loaded host project | Mod+Shift+E: mastered export/ via PipelineService |
| `Mod+N` | New project… (`project.new`) | Host project management | Mod+N |
| `Mod+O` | All projects (`project.home`) | Host project management | Mod+O: Home. Open project… is in the palette and on Home |

## presence

| Shortcut | Command | When | Notes |
|----------|---------|------|-------|
| `Escape` | Stop following (`presence.unfollow`) | While following another client | After the selection: Esc clears what is selected, then stops following |

## Commands without default keys

Available via toolbar / `execute`; some also appear in the in-app palette. Commands that need caller-provided arguments, such as `comment.resolve`, or a timeline/transcript target are omitted from the palette's runnable Actions. Argument-taking commands can run through `execute` with their input; contextual actions run from their owning controls, which may use gesture or API paths. The palette flag changes visibility, not permissions. Agents use session/document APIs — not these ids.

| Command | Id | When | Notes |
|---------|----|------|-------|
| Restore original audio | `edit.restoreClipBleed` | Loaded host project | Restore the selected automatic region in this clip. Host only. |
| Seek playhead | `transport.seek` | Always (when not typing in an input) | Args: { sec: number } |
| Audition Full mix / Edited stems / Original | `transport.audition` | Project loaded | Args: { mode: mix \| fx \| raw } |
| Follow | `presence.follow` | Always (when not typing in an input) | Args: { clientId: string } |
| Resolve comment | `comment.resolve` | Loaded host project | Args: { commentId: string, resolved: boolean, by: string } — host only; use a comment's Resolve/Reopen control |
| Open history | `edit.history` | Project loaded | Opens the History sheet, which stays reachable when Undo and Redo are both empty. Host or Editor. |
| Play range | `range.play` | Project loaded |  |
| Cut selected range | `range.cut` | Project loaded |  |
| Mute selected range | `range.mute` | Project loaded |  |
| Fill range with room tone | `range.fillRoomTone` | Project loaded |  |
| Move to speaker | `range.moveSpeakerLane` | Project loaded | Args: { toLaneId }. Range actions show Move to {speaker} on one split lane |
| Comment on range | `range.comment` | Project loaded |  |
| Bounce selected range | `range.bounce` | Project loaded |  |
| Select a range | `range.arm` | Project loaded |  |
| Toggle track mute | `track.muteToggle` | Project loaded | M: saved mix mute (SetTrackMute) for the host and editors; listen-only mute for other guests (Args: { trackId? }) |
| Set track volume | `track.setVolume` | Host or shared edit mode | Args: { trackId?, db }: SetTrackFader, the saved volume on top of staging gain (-60 to +12 dB) |
| Clear solo | `track.clearSolo` | Project loaded | Unsolo every track: the Solo on chip above the track headers, phone status row and Mix sheet (listen-only, no key) |
| Fit tracks to window height | `view.fitTracksHeight` | Always (when not typing in an input) | Toggle: fill the stage height, or a fixed track height |
| Share… | `share.manage` | Loaded host project | Open host share dialog: live links, create, revoke |
| Create record room | `record.createRoom` | Loaded host project | Mint guest + producer links in place and copy the guest link |
| Copy guest link | `record.copyGuestLink` | Loaded host project | Copy the open record room's guest link |
| Start recording | `record.start` | Host project management |  |
| Capture room tone | `record.roomTone` | Host project management | Ask every recorded device to capture 3 s of room tone (lobby or stopped) |
| Set session target | `record.setTarget` | Host project management | Choose where this session lands (before the first take): the start or the end of the episode, or staged as an insert or replace |
| Pause recording | `record.pause` | Host project management |  |
| Resume recording | `record.resume` | Host project management |  |
| Stop recording | `record.stop` | Host project management |  |
| Land recording on timeline | `record.land` | Host project management |  |
| Connect agent… | `mcp.connect` | Host project management | Copy local Streamable HTTP MCP URL for Cursor/Claude |
| Export diagnostics… | `help.diagnosticsBundle` | Host project management | Host-only sanitized diagnostics zip for bug reports |
| Manage models… | `models.open` | Host project management | Host-only dialog listing every model with its state, size and a download |
| Open project… | `project.open` | Host project management | No key (Mod+O is project.home); OS dialog via local engine; Home's Open other… path field when there is none |
| Split speakers… | `track.splitSpeakers` | editStageSplitSpeakers | Opens Prepare at the split prompt for the inspector track (args { trackId? }); the split runs as a job and is one undo step |
| Reorder track | `track.reorder` | editStageIngest | Args: { trackId?, index }: ReorderTrack; drag headers use skipWhen |
| Annotate transcript | `view.transcriptAnnotate` | Always (when not typing in an input) |  |
| Adjust word timing | `transcript.adjustTiming` | Loaded host project | Source-clock boundaries for the selected transcript word |
| Find and replace transcript | `transcript.findReplace` | Loaded host project |  |
| Correct transcript | `transcript.correctIntent` | Project loaded |  |
| Select transcript range | `transcript.selectIntent` | Project loaded |  |
| Extend transcript range | `transcript.extendRange` | Project loaded | Args: { edge: 'start' \| 'end', by: 1 \| -1 }: moves one edge of the selected word range by one word; a selection change only (#1029) |
| Ignore / restore transcript words | `transcript.ignoreWords` | Project loaded | Args: { trackId?, startWordIndex?, endWordIndex?, ignored? }: struck through and muted at render, no cut (#633); host-only |
| Next low-confidence word | `transcript.nextLowConfidence` | Project loaded | Seek + scroll to the next word under 0.7 ASR confidence, wrapping; turns Annotate on; Correct mode selects it (#634) |
| Previous low-confidence word | `transcript.prevLowConfidence` | Project loaded | Seek + scroll to the previous word under 0.7 ASR confidence, wrapping; turns Annotate on; Correct mode selects it (#634) |
| Show cut away | `view.showCutAway` | Always (when not typing in an input) |  |
| Roll clip join | `edit.rollClipJoin` | Host or shared edit mode | Join diamond + transcript boundary roll both edges |
| Set clip join | `edit.setClipJoin` | Host or shared edit mode | Join glyph popover on the timeline; Incoming transition select and Apply transition length in the clip inspector |
| Move clips | `edit.moveClips` | Host or shared edit mode | Args: { clips: non-empty list } — Clip inspector Apply move or pointer body drag; one clip or a multi-selection. Inspector placementToken is rechecked inside the mutation queue. |
| Add envelope point | `envelope.addPoint` | Host or shared edit mode | Args: { trackId: string, atTime: number } → visible volume layer required; SetEnvelope with a point at the envelope's current level there; the touch create menu |
| Change an applied sound | `tighten.reviseSuggested` | tightenPanelOpen | Args: { id: string, action: cut \| shorten \| lower \| leave }: ApplySuggestedActions revise of the latest batch |
| Go to tighten hit | `tighten.goToHit` | tightenPanelOpen | Args: { id?: string }: seek + select pending |

## Governance

- New shortcuts: add a `KEYMAP_COMMANDS` row + `commands/` handler; call `execute` from buttons.
- Never add a second window `keydown` listener — see `gui/web/src/commands/governance.test.ts`.
- Regenerate this page: `make cheatsheet`. CI/pre-commit: `make cheatsheet-check`.
<!-- /keymap-cheatsheet:generated -->

## Related

- [Screen inventory](#/screens)
- Capabilities catalog: [docs.sharecut.studio/#/capabilities](https://docs.sharecut.studio/#/capabilities)
- Engineer doc: [docs/daw-shortcuts.md](https://github.com/calebn/sharecut-studio/blob/main/docs/daw-shortcuts.md)
- Command bus: [docs/daw-editing.md](https://github.com/calebn/sharecut-studio/blob/main/docs/daw-editing.md)
