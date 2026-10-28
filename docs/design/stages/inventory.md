# ShareCut Studio: UI surface inventory (code-derived)

Derived from `gui/web/src` on 2026-10-25, cross-checked against `ux/pages/screen-inventory.md`, `ux/pages/mobile.md`, `docs/design-system.md`, `docs/editor-interactions.md` and the Playwright specs in `gui/web/e2e`. Where the prose docs disagree with code, code won (see "Doc drift" at the end).

All paths are relative to `gui/web/src/` unless they start with `/` or a repo folder. `S:` means a story. Story files are `*.stories.tsx` next to the component.

**Legend**
- **Story column.** The story file plus its exported story names, or NONE.
- **View split.** `View` = a props-only `FooView.tsx` already exists (easy story). `Props` = the component takes props only, no store. `Store` = reads the Zustand store (`useDaw`/`useDawStore`), so a story must hydrate the store (the pattern in `inspector/views/ClipInspector.stories.tsx`: `useDawStore.getState().hydrate(...)` with `test/fixtures.ts` `minimalProject`/`sampleTrack`). `Hook` = reads another context (for example `useModels`, `ModelsProvider`) or calls `api.ts` directly.
- **Coverage.** yes = a story renders the production surface in its main states. partial = only a piece, a fixture stand-in, or some states. no = nothing.

**Shells and breakpoints.** Phone < 768 px, tablet 768 to 1180 px, desktop > 1180 px (`hooks/useViewportClass.ts`, `layout/useEffectiveLayout.ts`). Roots are `.daw-shell--phone`, `.daw-shell--tablet` (inspector in a sheet or column), `.daw-shell--desktop`; guest adds `.daw-shell-guest`.

**Routing (`App.tsx`, `shareRoute.ts`).** `/` with no `?project=` is Home. `/?project=<abs path to episode.project.json>` is the host editor (`dawApp.tsx` then `layout/StudioShell.tsx`, which swaps in `layout/MobileShell.tsx` on phone). `/r/<token>` (or `?review=<token>`) is guest review. `/rec/<token>` is the record room (guest or producer). `/?home=1` forces Home when a project is pinned.

---

## Counts

| Kind | Count |
|---|---|
| Screens (SCR-) | 38 |
| Dialogs, sheets and popovers (DLG- 15, SHEET- 3, POP- 4) | 22 |
| Panels and inspector variants (PNL- 6, INS- 14) | 20 |
| Menus (MENU-) | 4 |
| Components, overlays, banners, toasts, status items, empty states (CMP- 48, OVL- 11, BAN- 6, TOAST/STAT/EMPTY/CHIP 4) | 69 |
| Interactions (INT-) | 46 |
| Total catalogued items | 199 |
| Story files / exported stories | 89 files / 446 stories |

Of the 153 non-interaction items: 65 have a story (yes), 33 partial, 55 none (counted from the Story column of the tables). Of the 46 interactions: 18 have a frozen-state story, 15 partial, 13 none. The per-surface table is section 14.

---

## 1. Home and onboarding

| ID | Surface | Reach | Files | Story | View split | Purpose |
|---|---|---|---|---|---|---|
| SCR-HOME | Host home: wordmark, Help and More (Models, Connect agent), the Import audio and Record tiles, the Setup card when models are missing, Recent episode cards (empty line when none), Open other…, the Add to Home Screen hint | Open `/` with no project, or `/?home=1`, or Menu > New project in the editor | `stages/home/HomeScreen.tsx`, `stages/home/HomeView.tsx`, `stages/home/homeModel.ts`, `system/ProjectCard.tsx`, `system/StartTile.tsx` | `stages/home/HomeView.stories.tsx` (Empty, WithRecents, SetupNeeded, SetupDownloading, FolderMoved, DropHover, Phone, PhoneEmpty) | View (`HomeView`) + Hook (`HomeScreen`: recents, models, picker) | Entry point for continuing or starting an episode |
| SCR-HOME-NEW | Removed: no New project form. The Import audio and Record tiles create the episode in the default folder (`~/ShareCut/<name>`) | Home > Import audio, Record, or drop audio on Home | `stages/home/HomeScreen.tsx` | `stages/home/HomeView.stories.tsx` | Hook | Create a workspace and open it, with no form |
| SCR-HOME-OPEN | Home, Open other…: the OS folder picker, or a popover with one path field (Enter submits) in a browser with none | Home > Open other…; the in-project Open project… sends a browser with no picker here | `stages/home/OpenOther.tsx`, `stages/home/HomeScreen.tsx` | `stages/home/OpenOther.stories.tsx` (Picker, PathFallback, PathError) | View + Hook | Open an existing episode |
| SCR-HOME-ERROR | Home inline errors in plain words with a fix: under the path field (no episode in that folder), and a line under the Recent heading (switch blocked, episode did not open) | Submit a bad path in Open other…; open a card that fails | `stages/home/OpenOther.tsx`, `stages/home/HomeView.tsx` | `stages/home/OpenOther.stories.tsx` (PathError) | View | Explain why open failed |
| SCR-SETUP | First-run Setup card on Home (Get ready, Choose…, Not now): one download for the required and recommended models | Open Home with a fresh profile (no `sharecut.bootstrap.skip` in localStorage) and models not installed | `stages/home/SetupCard.tsx`, `stages/home/homeModel.ts`, `models/ModelRow.tsx` | `stages/home/SetupCard.stories.tsx` (Needed, Downloading, Failed, CheckError, Phone); rows: `models/ModelRow.stories.tsx` | View + Hook (useModels) | Download the models the product needs |
| SCR-SETUP-CHECKING | Setup card, status unreadable ("Couldn't check what's installed.", Try again); nothing shows while the first status is pending | Same, while `/api/bootstrap/status` fails | `stages/home/SetupCard.tsx` | `stages/home/SetupCard.stories.tsx` (CheckError) | View | Load-error state of the card |
| SCR-SETUP-DOWNLOAD | Setup card, downloading (one bar, "420 MB of 1.6 GB", Cancel) and failed ("The download didn't finish.", Try again) | Get ready on the card | `stages/home/SetupCard.tsx`, `models/ModelProgress.tsx` | `stages/home/SetupCard.stories.tsx` (Downloading, Failed) | View | Progress while models download |
| SCR-LOADING | Loading cover ("Loading project…", "Loading studio…", "Loading episode…") | Any route while features or the project bootstrap | `ui/LoadingScreen.tsx` | `ui/LoadingScreen.stories.tsx` (Default, ProjectLabel) | Props | Wait state before a route resolves |
| SCR-ERROR | Error cover (share routes unavailable; "This link does not open the project."; invalid or ended recording link; bootstrap error) | `/r/<bad>`; `/rec/<bad>`; online extension not loaded | `ui/ErrorScreen.tsx`, `App.tsx` | `ui/ErrorScreen.stories.tsx` (Default, WithNextStep) | Props | Dead-end with a next step |
| SCR-COVER | Generic cover shell (used by the guest Covers: full, invalid, access ended) | via the screens that use it | `ui/CoverScreen.tsx` | `ui/CoverScreen.stories.tsx` (WithHeading, StatusOnly) | Props | Shared centered card layout |
| SCR-RECOVERY | "This project isn't served by this server" page (Open X, Choose a different project…) | Server-rendered when a stale project URL is opened with Accept: text/html | `/src/podcast_mcp/gui/server.py` (HTML), `/recovery.css` | NONE (outside the React app) | n/a | Recover from a stale link; Choose a different project goes to `/?home=1` |

Dialogs launched from Home are listed in section 7: DLG-MCP, DLG-MODELS, DLG-HELP.

---

## 2. Editor shell and transport

| ID | Surface | Reach | Files | Story | View split | Purpose |
|---|---|---|---|---|---|---|
| SCR-SHELL-DESKTOP | Desktop four-pane grid: transport, tool rail + track headers + timeline, bottom tabs, inspector column, status bar | `/?project=…` at width > 1180 | `layout/StudioShell.tsx`, `layout/StudioShellView.tsx` | `layout/StudioShellView.stories.tsx` (Desktop, DesktopInspector, GuestFollowing, Loading, EmptyIngest). Uses `layout/shellStoryFixtures.tsx` stand-ins, not the real panels | View | The main editing workspace |
| SCR-SHELL-TABLET | Tablet shell: tool rail, inspector as a bottom sheet or side column | same, width 768 to 1180 | `layout/StudioShellView.tsx`, `layout/useSelectionSheet.tsx`, `layout/useInspectorColumn.ts` | `layout/StudioShellView.stories.tsx` (Tablet, TabletInspector) | View | Editing on tablets |
| SCR-SHELL-LOADING | Shell while the project loads (skeleton headers, "Loading episode…") | Open the project URL, throttle `/api/project` | `layout/StudioShell.tsx` (workspace kind `loading`) | `layout/StudioShellView.stories.tsx` Loading; `layout/StatusBarView.stories.tsx` Loading | View | Loading skeleton |
| SCR-SHELL-INGEST | Empty-session drop target ("Drop audio files here, or Import Audio (⌘I)", drop stems, one file per speaker, coach text) | Open a project with zero tracks | `layout/StudioShellView.tsx`, `ingest/ingestFiles.ts`, `ingest/dropLabels.ts` | `layout/StudioShellView.stories.tsx` EmptyIngest | View | First-run empty state, import by drop or click |
| SCR-LAYOUT-TIMELINE | Layout "Maximize timeline" (drawer collapsed, handle to reopen) | View menu > Layout > Timeline, or ⌘⇧2 | `layout/layoutModes.ts`, `layout/CollapsedDrawerHandle.tsx`, `state/layoutPresentation.ts` | NONE (`layout/BottomTabsSplitterView.stories.tsx` covers the splitter) | Store | Give the timeline all vertical space |
| SCR-LAYOUT-TEXT | Layout "Maximize transcript" | View menu > Layout > Text, or ⌘⇧3 | same | NONE | Store | Give the transcript all space |
| SCR-LAYOUT-REVIEW | Layout "Review" | View menu > Layout > Review, or ⌘⇧4 | same | NONE | Store | Review-focused arrangement |
| CMP-TRANSPORT | Transport bar: project title h1, play controls, timecode, audition modes (Full mix / Edited stems / Original), mix pill, layout chip, History, Zoom, Blade cut, Fit, Fit height, People, View, Menu | Always at top (wide); collapsed on phone/tablet | `layout/TransportBar.tsx`, `layout/TransportFrame.tsx`, `layout/TransportPlayControls.tsx`, `layout/TransportTimecode.tsx` | `layout/TransportFrame.stories.tsx` (Wide, Playing, StaleRender, Collapsed); `layout/TransportPlayControls.stories.tsx` (Ready, Playing, EmptyProject, CompactPhone, PausedEmptyProject). The live bar is store-bound and not storied | View for frame and play controls; Store for the bar | Play, audition, mix status and project-level commands |
| CMP-TRANSPORT-PILLS | Mix status pill (Stale / Refresh mix / Updating mix… / fresh), Importing… pill, audio-error pill, agent Region pill | Transport end zone | `layout/TransportBar.tsx`, `ui/Pill.tsx` | `ui/Pill.stories.tsx` (Ok, Warning, AllTones); `layout/TransportFrame.stories.tsx` StaleRender | Store | Status at a glance |
| MENU-MAIN | Menu (hamburger): Timeline tools, Project, Media, Markers, Selection, Audition and Mix status (collapsed), Session, View sections (collapsed), Help | Click "Menu" in transport | `layout/TransportBar.tsx`, `ui/Menu.tsx`, `ui/CommandMenuItem.tsx` | Atom only: `ui/Menu.stories.tsx` (Default, Open, WithShortcuts) | Store | Project and media commands that do not earn a toolbar button |
| MENU-VIEW | View menu: Layers (overlay legend), Waveform scale and amplitude, Zoom +/-, track height +/-, Fit tracks, Fit, Layout radios, Theme radios | Click "View" in transport (wide bar only) | `layout/TransportBar.tsx`, `layout/OverlayLegend.tsx`, `layout/WaveformViewSections.tsx` | Part: `layout/OverlayLegendView.stories.tsx` (Desktop, ViewMenu, PhoneWidth) | Partial View | View preferences |
| MENU-PEOPLE | People menu and avatar stack (follow someone, overflow "More people", followers badge) | Click an avatar or "People" | `layout/AvatarStack.tsx`, `layout/AvatarStackView.tsx` | `layout/AvatarStackView.stories.tsx` (Inline, Following, Overflow, PeopleMenu, PhoneWidth) | View | Presence and Follow |
| CMP-LAYOUT-CHIP | "Maximized · Restore" chip and layout toggle | Appears when layout is not default | `layout/LayoutControls.tsx` | NONE | Store | Escape hatch from a maximized layout |
| CMP-TOOLRAIL | Edit corner (the tool rail and its Select/Blade/Comment modes were removed in #2294): Range select (touch only), Fit, Zoom, Script toggle, eye | Corner above the track headers | `stage/edit/EditCorner.tsx`, `stage/edit/EditCornerView.tsx` | `stage/edit/EditCornerView.stories.tsx` (Default, TouchWithRange, RangeArmed, RangeUnavailable, Phone) | View | Range arm and zoom |
| CMP-SPLITTER | Bottom-panel splitter with Shorter/Taller/Reset buttons, keyboard resize | Between timeline and bottom tabs | `layout/BottomTabsSplitter.tsx`, `layout/BottomTabsSplitterView.tsx` | `layout/BottomTabsSplitterView.stories.tsx` (Default, CustomHeight, KeyboardResize, KeyboardResizeCustomMax, PhoneWidth, PointerButtons, OversizedPreference) | View | Resize the bottom panel |
| CMP-DRAWER-HANDLE | "Show editor panels" handle (tap or swipe up) | Timeline layout, drawer collapsed | `layout/CollapsedDrawerHandle.tsx` | NONE | Store | Reopen the drawer |
| CMP-TABS | Bottom tab list "Editor panels": Transcript, Comments, History, Tighten, Pipeline (host only for the last three) | Always on desktop and tablet | `layout/StudioShellView.tsx`, `ui/Tabs.tsx`, `layout/tabLabels.ts` | NONE for the tab strip itself (`layout/StudioShellView.stories.tsx` renders it with stand-in panels) | View | Switch bottom panels |
| CMP-STATUSBAR | Status bar: presence, save dot, pending-edits chip, unmapped chip, "Cut X of Y", social clips, Transcript needs sync, pipeline chip, Open comments | Footer | `layout/StatusBar.tsx`, `layout/StatusBarView.tsx`, `layout/statusBarSummary.ts` | `layout/StatusBarView.stories.tsx` (Desktop, StaleRender, GuestActivity, Loading, Announcement, PhoneWidth) | View | Ambient project state with shortcuts to panels |
| CMP-SAVEDOT | Save-state dot (Saved, Saving, Waiting to send, Unreadable, Project unavailable) | Status bar; phone header | `layout/SaveStateDot.tsx`, `layout/SaveStateDotView.tsx` | `layout/SaveStateDotView.stories.tsx` (Saved, Saving, WaitingToSend, Unreadable, ProjectUnavailable) | View | Reassure edits are saved |
| CMP-PIPELINE-CHIP | Pipeline/job status chip (Running, Multiple, Stalled, Completed, Failed) | Status bar; phone Listen chips | `layout/PipelineStatusChip.tsx`, `models/gate/JobModelDownload.tsx` | `layout/PipelineStatusChip.stories.tsx` (Running, MultipleActivities, Stalled, Completed, Failed, ReadOnly, CompactPhone); JobModelDownload NONE | Props / Hook | Background job visibility |

---

## 3. Timeline and tracks

| ID | Surface | Reach | Files | Story | View split | Purpose |
|---|---|---|---|---|---|---|
| CMP-TIMELINE | Timeline canvas: lanes, ruler, marker lane, playhead, scrollers, fixed-playhead variant on phone | Center of the shell | `timeline/TimelineView.tsx`, `timeline/TrackLane.tsx`, `timeline/WaveformLayer.tsx`, `timeline/Playhead.tsx`, `timeline/PlayheadNeedle.tsx`, `timeline/FixedPlayheadNeedle.tsx` | NONE for the whole canvas. Pieces: `timeline/TimelineRange.stories.tsx`; `timeline/timelineLaneStoryDecorator.tsx` gives pieces a real lane shell | Store (needle is prop-only) | The editing surface |
| CMP-RULER | Time ruler with comment anchors, click-to-seek, ticks | Top of timeline | `timeline/TimeRuler.tsx`, `timeline/TimeRulerView.tsx` | `timeline/TimeRuler.stories.tsx` (Desktop, PhoneWidth, CommentAnchor) | View | Seek, zoom reference |
| CMP-MARKERS | Marker lane: chapters, social clips, comment pins, pending/applied rows | Under the ruler | `timeline/MarkerLane.tsx`, `timeline/MarkerLaneView.tsx` | `timeline/MarkerLane.stories.tsx` (AllRows, SelectedComment, ReadOnly, Empty, PhoneWidth) | View | Navigate to markers |
| CMP-CLIP | Clip block: waveform, trim handles, fade corners, join markers, selection state | In each lane | `timeline/ClipBlock.tsx`, `timeline/ClipBlockView.tsx`, `timeline/FadeCurves.tsx`, `timeline/DetentMark.tsx` | `timeline/ClipBlock.stories.tsx` (Editable, SelectedCrossfadeJoin, TrimPreview, FadeReadout, ReadOnly, PhoneWidth) | View | Direct manipulation of clips |
| POP-JOIN | Join popover (Cut / Fade / Crossfade, length, blocked reason) | Click a join marker | `timeline/JoinPopover.tsx`, `timeline/JoinPopoverView.tsx`, `timeline/JoinEditor.tsx`, `timeline/JoinBlend.tsx`, `timeline/useJoinEdit.ts` | `timeline/JoinPopoverView.stories.tsx` (Fade, Crossfade, Cut, BlockedCrossfade, ReadOnly, BusyWithError). JoinEditor (crossfade endpoint drag) NONE | View | Edit a join in place |
| OVL-PENDING | Pending-edit regions with label, edge handles, Approve/Reject card, refine recovery | Lane overlay when edits are pending | `timeline/PendingEditOverlay.tsx`, `timeline/PendingEditOverlayView.tsx`, `timeline/RippleArrow.tsx`, `timeline/pendingEdgeDrag.ts` | `timeline/PendingEditOverlay.stories.tsx` (Kinds, Selected, DragEndHandle, PhoneWidth, FilteredTrack) | View | Review agent or guest proposals |
| OVL-APPLIED | Applied-edit ticks | Lane overlay (Layers > Pending edits) | `timeline/AppliedEditOverlay.tsx` | `timeline/AppliedEditOverlay.stories.tsx` (Visible, Selected, DenseSeams, PhoneFiltered, PhoneEmpty, Unmapped) | Props | Show where cuts landed |
| OVL-EDITMARKERS | Edit marker layer (cut, ripple, blade glyphs, label, chip) | Lane overlay | `timeline/editMarkers/EditMarkerLayer.tsx` | `timeline/editMarkers/EditMarkerLayer.stories.tsx` (AllTypes, NarrowOverlap, MiddleOverlap, WideOverlap, LabelRoom, Chip, PhoneChip) | Props | Mark every edit kind consistently |
| OVL-STALE | Stale-render invalidation bands | Lane overlay when mix is behind | `timeline/StaleInvalidationOverlay.tsx` | `timeline/StaleInvalidationOverlay.stories.tsx` (RegionalCut, BriefChange, OverlappingCauses, PhoneRightEdge, PhoneFiltered, PhoneEmpty) | Props | Show what is out of date |
| OVL-PRESENCE | Remote playheads, cursors, selections | Lane overlay with collaborators | `timeline/PresenceOverlay.tsx`, `timeline/PresenceOverlayView.tsx`, `presence/PresenceGhostLayer.tsx` | `timeline/PresenceOverlayView.stories.tsx` (PlayheadAndCursor, RemoteSelections, FollowedPlayheadHidden, PhoneWidth, PhoneStaleClient); ghost layer NONE | View | Co-presence |
| OVL-ENVELOPE | Volume envelope line and points | Track inspector > Show/Edit volume envelope | `timeline/EnvelopeOverlay.tsx`, `timeline/EnvelopeOverlayView.tsx` | `timeline/EnvelopeOverlayView.stories.tsx` (Editable, Selected, ReadOnly, PhoneWidth, PhoneEmpty) | View | Gain automation on the lane |
| OVL-BLEED | Automatic-reduction (bleed) regions | Layers; Clip inspector | `timeline/BleedAttenuationOverlay.tsx` | `timeline/BleedAttenuationOverlay.stories.tsx` (SelectableRegions, BriefRegion, Empty, PhoneWidth) | Props | Inspect auto-ducked regions |
| OVL-PROSODY | Prosody overlay (host-only layer) | Layers > Prosody | `timeline/ProsodyOverlay.tsx`, `timeline/ProsodyOverlayView.tsx` | NONE | View | Pitch and pace hints |
| OVL-RECORDING | Provisional take band and needle | While a take records | `timeline/RecordingOverlay.tsx` | NONE | Props | Show live take span |
| OVL-RANGE | Audition range and comment span/pin overlays | Select a range; select a comment | `timeline/AuditionOverlay.tsx`, `timeline/CommentSelectionOverlay.tsx`, `timeline/TimelineRange.tsx` | `timeline/TimelineRange.stories.tsx` (AuditionRange, SelectedCommentSpan, SelectedCommentPin) | Props | Show the selected time range |
| OVL-COMMENT-BUBBLE | Comment bubble that follows playback | Playing past a comment | `timeline/CommentPlaybackBubble.tsx`, `timeline/CommentPlaybackBubbleView.tsx` | `timeline/CommentPlaybackBubbleView.stories.tsx` (Playing, LongBody, PhoneWidth, NoActiveComment) | View | Surface comments in context |
| CMP-RANGE-ACTIONS | Range actions bar: Play range, Cut, Mute, Fill with room tone, Move to speaker, Comment, Bounce, numeric In/Out, lane checkboxes, word controls | Select a range (drag empty lane, Shift-drag clip, Select range tool, or transcript Select) | `stage/edit/EditActionBar.tsx`, `commands/editVerbs.ts`, `timeline/RangeFields.tsx`, `transcript/WordRangeControls.tsx`, `commands/rangeActions.ts` | NONE | Store | Act on a time selection |
| MENU-CREATE | "Create here" menu (Add envelope point, Blade cut, Add chapter, Add comment) | Right-click, Shift+F10 / F10 / ContextMenu key on the timeline, long-press | `timeline/CreateMenu.tsx`, `commands/createMenuHost.ts` | NONE | Store | Context actions at a time/lane point |
| POP-CHOOSER | Touch target chooser: fan of 44 px chips when a finger covers several targets | Press and hold over overlapping targets on touch | `timeline/TargetChooser.tsx`, `timeline/hitRouting.ts`, `timeline/chooserLayout.ts` | NONE | Store | Disambiguate overlapping targets |
| CMP-TRACK-HEADERS | Track header column: initials/open-details, reorder handle, mute, solo, fader, playback meter, stem-stale chip, fx badge, speaker label | Left of lanes | `tracks/TrackHeadersColumn.tsx`, `tracks/TrackHeader.tsx`, `tracks/TrackHeaderView.tsx`, `tracks/TrackMuteSoloButtons*.tsx`, `tracks/TrackPlaybackMeter.tsx` | `tracks/TrackHeaderView.stories.tsx` (Default, Selected, SavedMute, ListenMuteAndSolo, Soloed, ImpliedMute, StaleStem, EmptyTrack, ReorderTarget, SpeakerMatchesName, PhoneWidth); TrackPlaybackMeter, TrackHeadersColumn NONE | View | Per-track controls |
| CMP-TRACK-FADER | Track volume fader with reset | Track header or Mix | `tracks/TrackFader.tsx`, `tracks/TrackFaderView.tsx` | `tracks/TrackFaderView.stories.tsx` (Detailed, ReadOnly, StaleBalance, NonDialogue, PhoneWidth) | View | Set track level |
| CMP-SOLO-CHIP | Solo chip (clear solo) | Phone header when something is soloed | `tracks/SoloChip.tsx` | NONE | Store | Escape from solo |
| CMP-LEGEND | Layers legend (checkboxes for Pending edits, Volume envelope, Markers, Comments, Silence, Snap points, Prosody) | View menu; phone More | `layout/OverlayLegend.tsx`, `layout/OverlayLegendView.tsx` | `layout/OverlayLegendView.stories.tsx` (Desktop, ViewMenu, PhoneWidth) | View | Toggle overlay layers |
| CMP-TRACK-MIX | Phone Mix sheet: all tracks with faders, mute, solo | Phone More > Mix | `tracks/TrackMix.tsx`, `tracks/TrackMixView.tsx` | `tracks/TrackMixView.stories.tsx` (Phone360, ReadOnly, SavedAndImplied, LongNames, ManyTracks, Empty, Loading) | View | Mixing on a phone |

---

## 4. Transcript

| ID | Surface | Reach | Files | Story | View split | Purpose |
|---|---|---|---|---|---|---|
| PNL-TRANSCRIPT | Transcript panel: toolbar (Annotate, Show cut away, low-confidence prev/next with count, Navigate/Correct/Select intents, Ignore/Restore, Find and replace, Follow playhead), turns, speaker headers, ignored-word restore | Bottom tab "Transcript" (default); phone Text tab | `panels/TranscriptPanel.tsx`, `transcript/TranscriptTurnView.tsx`, `inspector/TranscriptRefineRecovery.tsx` | Turn only: `transcript/TranscriptTurnView.stories.tsx` (Mapped, ActiveSelected, SuppressedLowConfidence, UnmappedCutAway, MobileLongTurn) | Store for the panel (1752 lines, 15 store reads); View for the turn | Read, navigate, correct and select speech |
| CMP-TURN | One speaker turn with word spans, cut-away rendering, low-confidence styling | inside PNL-TRANSCRIPT | `transcript/TranscriptTurnView.tsx` | `transcript/TranscriptTurnView.stories.tsx` | View | The transcript's core row |
| CMP-GHOST | Restored ("ghost") word chips | Inside a turn after a cut | `transcript/GhostWordChips.tsx` | `transcript/GhostWordChips.stories.tsx` (RestoredWords, NoRestoredWords, MobileRestoredWords) | Props | Restore cut words |
| CMP-EDITBOUNDARY | Edit boundary mark (roll join, trim edge, host-only precision edit) with drag preview | Between turns at a cut | `transcript/EditBoundaryMark.tsx`, `transcript/EditBoundaryMarkView.tsx` | `transcript/EditBoundaryMark.stories.tsx` (RollJoin, RollDragPreview, TrimEdge, HostOnlyPrecisionEdit, PhoneWidth, LongFailure). The Precision dialog is not opened in any story | View | Adjust a cut from the text |
| POP-WORD-EDIT | Inline word correction field ("Correct word “x”") | Correct intent + click word, double-click word (touch: double-tap), or F2 on a focused word | `transcript/InlineWordEditor.tsx` | NONE | Props | Fix a word in place |
| POP-SPEAKER | Speaker change popover ("Change speaker for X", Speaker name field) | Click the speaker header button in a turn | `transcript/TranscriptSpeakerEditor.tsx` | NONE | Props | Rename or reassign a speaker for the track |
| CMP-FINDREPLACE | Find and replace region (Find, Replace with, counts, preview list, Replace all) | Transcript toolbar "Find and replace transcript" | `transcript/TranscriptFindReplace.tsx` | NONE | Store | Bulk text fixes |
| CMP-WORDBAR | Word timing bar: draggable start/end handles, neighbor words, numeric seconds, Apply timing, Cancel draft, Preview, Reload timing | Transcript word selected > inspector (Adjust word timing) | `transcript/TranscriptWordbar.tsx` | NONE | Store | Fine-tune word boundaries |
| CMP-WORDRANGE | Words-in-range controls (add or drop a word at either end) | Range actions with a word range | `transcript/WordRangeControls.tsx` | NONE | Store | Adjust a text selection |
| CMP-REFINE | Transcript refine recovery notice and action | Shown in the Review queue, Pending inspector, pending overlay, guest attention banner | `inspector/TranscriptRefineRecovery.tsx` | partial via `layout/GuestAttentionBannerView.stories.tsx` | Props | Unblock edits needing word-level timing |
| CMP-VOCAB | Hint words for the transcriber, with Re-transcribe when they change after a run | Prepare stage, Ready column | `stages/prepare/Vocabulary.tsx`, `stages/prepare/useVocabulary.ts` | `stages/prepare/Vocabulary.stories.tsx` | Props + hook | Hint words for the transcriber |

---

## 5. Review, comments, history and pipeline panels

| ID | Surface | Reach | Files | Story | View split | Purpose |
|---|---|---|---|---|---|---|
| PNL-COMMENTS | Comments panel: filter (open/resolved/all), list, compose, guest name step, EmptyState | Tab "Comments"; phone More > Comments or Listen "Open all"; status bar "Open comments" | `panels/CommentsPanel.tsx`, `comments/CommentCard.tsx`, `comments/CommentCompose.tsx`, `comments/GuestNameStep.tsx`, `comments/InlineEditInput.tsx`, `comments/CommentAnchorChip.tsx`, `comments/CommentTimeChip.tsx`, `comments/CommentAuthorLine.tsx` | Parts: `comments/CommentCard.stories.tsx` (Open, Resolved, ResolveAndReopen, ActionsAndReplies, Busy, ReadOnly, MobileLongThread); `comments/CommentCompose.stories.tsx` (Empty, DraftAndPost, Posting). Panel and GuestNameStep NONE | Props for the pieces; Store for the panel | Discuss and resolve feedback |
| CMP-GUEST-NAME | "Your name" step before a guest's first comment | Guest posts a comment with no stored name | `comments/GuestNameStep.tsx`, `comments/useGuestName.ts` | NONE | Props | Identify the guest |
| PNL-HISTORY | History panel: Undo, Redo, grouped steps, diff view with raw toggle, Loading history… | Tab "History" (host); phone More > History | `panels/HistoryPanel.tsx`, `layout/useHistoryControls.ts` | NONE | Store | Browse and restore past states |
| PNL-REVIEW-QUEUE | Removed in #2293: the Impact tab is now the Review Queue (`stage/hosts/ReviewHost.tsx`, `review/ReviewStage.tsx`). Totals, per-track seconds, the Applied edits list and all-kinds Approve all / Reject all are gone; unplaced edits are the last row of their group | Review > Queue (host); status bar pending chip | `stage/hosts/useReviewQueue.ts`, `panels/BulkReviewWorking.tsx`, `utils/pendingReviewPass.ts` | NONE | Store | Decide pending suggestions one at a time or by group |
| PNL-TIGHTEN | Tighten panel: search hits, Class filter, Track, Intensity, hit list with Apply/Skip/Preview/Go to, Apply suggested, applied-sounds list, model gate | Tab "Tighten" (host); phone More > Tighten | `panels/TightenPanel.tsx`, `panels/AppliedSoundsList.tsx`, `commands/tighten.ts` | NONE | Store | Find and remove fillers, silences and breaths |
| PNL-PIPELINE | Getting ready list and the Advanced sheet: the run progress rows with Get/Try again/keep-my-fixes actions, and the four steps that can be tuned (switch, parameters, Run from here, Cancel) | Prepare stage; Advanced… on the Ready column | `stages/prepare/ReadyList.tsx`, `stages/prepare/AdvancedSteps.tsx`, `stages/prepare/usePrepareRun.ts`, `stages/prepare/advancedModel.ts` | `stages/prepare/ReadyList.stories.tsx`, `stages/prepare/AdvancedSteps.stories.tsx` | Props + hooks | Run the editing pipeline and tune its steps |
| DLG-STEP-PARAMS | Step parameters in the Advanced sheet (a pane beside the list on desktop, a drill-in on phone) | Prepare > Advanced… > a step | `stages/prepare/AdvancedSteps.tsx` | `stages/prepare/AdvancedSteps.stories.tsx` | Props | Edit step parameters |

---

## 6. Inspector (per selection type)

`Selection` (`types/project.ts`) kinds map through `inspector/selectionSurface.tsx` to bodies. Desktop shows `Inspector` in the right column, tablet in a column or `BottomSheet`, phone in the compact inspector sheet (peek, half, full detents, `inspector/InspectorPeek.tsx`). The footer is `ui/InspectorSeekFooter*.tsx`.

| ID | Surface | Reach | Files | Story | View split | Purpose |
|---|---|---|---|---|---|---|
| INS-CLIP | Clip: timeline start/end, Source in/out with nudges, Fade in/out ms with nudges, Incoming transition + length, Automatic audio reduction, Mute regions, placement controls (Move clip: track + start), Delete clip | Click a clip | `inspector/views/ClipInspector.tsx`, `inspector/views/ClipPlacementControls.tsx`, `inspector/views/ClipBleedHost.tsx` | `inspector/views/ClipInspector.stories.tsx` (EnlargedTextShortLandscape, PointerPlacement, PlacementInputError, PlacementViewer) | Store (story hydrates) | Precise clip editing |
| INS-CLIP-MULTI | Multi-clip selection | Modifier-click clips | `inspector/views/ClipInspector.tsx` (`ids`) | NONE | Store | Edit several clips |
| INS-PENDING | Pending edit/split/exact range: Approve/Reject pinned header, type, timeline islands, cut time, tracks, source start/end with nudges, join fade, boundary, confidence, Suggested bounds, preview footer (Current/Suggested/A/B), Ask thread, refine recovery | Click a pending region; Review queue; Listen status chip | `inspector/views/PendingEditInspector.tsx`, `inspector/PendingPreviewFooter.tsx`, `inspector/useQueuedReviewNotice.tsx` | NONE (`ui/InspectorSeekFooterView.stories.tsx` covers the footer) | Store | Decide on a proposed edit |
| INS-APPLIED | Applied edit record: operation, reason, time, source, timeline, restore, boundary, params | Click an applied tick | `inspector/views/AppliedEditInspector.tsx` | NONE | Store | Inspect and restore an applied edit |
| INS-TRACK | Track: label, speaker, role, stem status, media, effects with Bypass, Show/Edit/Add volume envelope, Track actions menu (Smooth all joins), Split speakers…, Import/Replace audio, Remove track, Clear clip light, multi-track | Click a track header | `inspector/views/TrackInspector.tsx` | NONE | Store | Track-level properties and actions |
| INS-CHAPTER | Chapter: Title, Time, Delete | Click a chapter marker | `inspector/views/ChapterInspector.tsx` | NONE | Store | Edit a chapter |
| INS-SOCIAL | Social clip: title, track, start/end, score, approved, review | Click a social clip marker | `inspector/views/SocialClipInspector.tsx` | NONE | Store | Edit a suggested clip |
| INS-COMMENT | Comment: time (seek), author, status, tracks, action items, replies, Reply field, linked pending edit | Click a comment pin or card | `inspector/views/CommentInspector.tsx` | NONE | Store | Read and reply |
| INS-WORD | Transcript range / word: text and correction (Corrected text, End word index), confidence, suppressed, ignored, Return to automatic, word timing bar | Click or select words | `inspector/views/TranscriptWordInspector.tsx`, `inspector/OneWordEditor.tsx` | NONE | Store | Correct and retime words |
| INS-RANGE | Exact range selection: Range actions in the sheet | Make a timeline or text range | `timeline/RangeFields.tsx` via `inspector/selectionSurface.tsx` | NONE | Store | See CMP-RANGE-ACTIONS |
| INS-ENVELOPE | Volume envelope workspace (track) and point editor (Time, Value, Apply, conflicts, saving) | Track inspector > Edit volume envelope; click a point | `inspector/views/EnvelopeWorkspace.tsx`, `inspector/views/EnvelopeWorkspaceView.tsx` | `inspector/views/EnvelopeWorkspaceView.stories.tsx` (Empty, FirstPoint, Phone, CoincidentPoints, Conflict, Saving, ReadOnly, EnlargedTextShortLandscape) | View | Gain automation with exact values |
| INS-BLEED | Automatic reduction (bleed attenuation) inspector | Click a bleed region | `inspector/views/BleedAttenuationInspector.tsx` | `inspector/views/BleedAttenuationInspector.stories.tsx` (PartialSavedChoice, StaleTarget, SavedWithUndo, DisabledLatePlan, UnavailableEvidence, ChangedRecording, Loading, Empty, FailedLoad, Saving, Guest, Permission) | Props | Inspect and override auto-ducking |
| INS-PEEK | Peek strip: summary of the selection plus Related and More commands | Phone/tablet compact inspector | `inspector/InspectorPeek.tsx`, `inspector/peekBuilders.ts`, `inspector/RelatedCommands.tsx`, `inspector/ModifierInspector.tsx` | NONE | Store | Quick actions without opening the full sheet |
| SHEET-INSPECTOR | Inspector bottom sheet (tablet and phone) with detents | Select anything on tablet or phone | `layout/useSelectionSheet.tsx`, `inspector/SelectionSheetBody.tsx`, `ui/BottomSheet.tsx` | `ui/BottomSheet.stories.tsx` (Default, DismissOutside, Untitled, ControlledResizeWithNativeControls, InspectorEnlargedTextShortLandscape); `layout/MobileShellView.stories.tsx` OpenInspector | Props | Selection details in a sheet |
| CMP-SEEK-FOOTER | Inspector footer: Seek, Play, Join A/B, Current/Suggested/A-B preview, Skip | Bottom of modifier inspectors | `ui/InspectorSeekFooter.tsx`, `ui/InspectorSeekFooterView.tsx` | `ui/InspectorSeekFooterView.stories.tsx` (Default, JoinButtons, SeekOnly, PreviewModes, SkipUnavailable, PhoneWidth) | View | Audition before committing |

---

## 7. Dialogs, sheets and popovers

All use `ui/Dialog.tsx` (phone renders as a bottom sheet) unless noted. Export deliverables and Bounce are not dialogs any more: they are the Episode file and Bounce sections of the Deliver stage (`stages/deliver/EpisodeFile.tsx`, `stages/deliver/BounceSection.tsx`, host `stage/hosts/DeliverStage.tsx`, run by `stage/hosts/exportFlow.tsx` and `stage/hosts/bounceFlow.tsx`). Stories for dialogs open the dialog by launcher (`test/storyDialog.ts`).

| ID | Surface | Reach | Files | Story | View split | Purpose |
|---|---|---|---|---|---|---|
| DLG-SHARE | "Share": review links (role, create, copy, Stop sharing confirm), record rooms (guest/producer links, End room confirm), online sharing/tunnel status, MCP URL | Menu > Project > Share… | `layout/ShareDialog.tsx`, `layout/ShareDialogView.tsx`, `layout/TunnelStatusLine.tsx`, `layout/shareCopyKey.ts` | `layout/ShareDialogView.stories.tsx` (Empty, LiveLinks, RecordRoom, MissingProducer, Busy, JustCreated, ClipboardError, OnlineSharingOn, OnlineSharingReconnecting, OnlineSharingNotReachable, OnlineSharingOff, Phone) | View | Invite reviewers and recorders |
| DLG-MCP | "Connect agent": MCP URL and Cursor snippet, copy buttons, no-episode warning | Home > Connect agent…; Menu > Project > Connect agent… | `layout/HostMcpDialog.tsx`, `layout/hostMcp.ts` | `layout/HostMcpDialog.stories.tsx` (Ready, NoEpisode, Phone) | Props | Wire an AI agent to the project |
| DLG-HELP | "Help": create diagnostics bundle, description, consent checkbox, Submit report, publication status, Open support | Home > Help; Menu > Help > Export diagnostics… | `home/HelpDialog.tsx` | NONE | Hook (api) | Report a problem with a sanitized bundle |
| DLG-MODELS | "Models": every model with Download, Update, Retry, Cancel; tool status | Home > Models; command palette "Manage models…" | `models/ModelsDialog.tsx`, `models/ModelRow.tsx`, `models/VariantPicker.tsx` | Row only (`models/ModelRow.stories.tsx`) | Hook (useModels) | Manage local models |
| DLG-MODEL-GATE | "Download model?" prompt shown before a feature that needs a model (Primary: Download / Downloading… / Retry / Continue; Cancel download) | Run Export, Bounce, Tighten, or a stale job's model chip without the model | `models/gate/ModelGate.tsx`, `models/gate/useModelGate.ts`, `models/gate/JobModelDownload.tsx` | partial: `stages/deliver/EpisodeFile.stories.tsx` ModelGatePrompt (gate embedded) | Props (`ModelGate` object) | Just-in-time model download |
| DLG-WHISPER | "Get the transcription model" row (size, progress, failure); the run continues once it is installed | Prepare > Getting ready, when the model is missing | `stages/prepare/ReadyList.tsx`, `stages/prepare/usePrepareRun.ts` | `stages/prepare/ReadyList.stories.tsx` | Props + hook | Confirm a large download |
| DLG-SPLIT | Split prompt on a Source card: Number of voices, progress with Cancel, a card per voice to name, Undo toast, failure with Try again | Prepare stage; Track inspector > Split speakers… and command `track.splitSpeakers` open Prepare at that card | `stages/prepare/SplitSpeakers.tsx`, `stages/prepare/usePrepareSources.ts`, `utils/speakerSplit.ts` | `stages/prepare/SplitSpeakers.stories.tsx` | Props + hook | Turn one recording into per-speaker tracks |
| DLG-PALETTE | "Commands and shortcuts": search, category groups, shortcuts, remaps, Gestures handoff | `?` key, Menu > Help > Commands and shortcuts, phone More > search row | `layout/CommandPalette.tsx`, `layout/CommandPaletteView.tsx`, `layout/commandPaletteRows.ts`, `layout/paletteSearch.ts` | `layout/CommandPaletteView.stories.tsx` (Browse, Search, NoMatch, ShowRemaps, GesturesHandoff, Phone) | View | Discover and run commands |
| DLG-GESTURES | "Gestures" cheatsheet (two-finger tap, long-press, pinch, swipe left on comment, hold-drag word, double-tap word) | Phone More > Gestures; palette link | `ui/GesturesSheet.tsx`, `commands/gestures.ts`, `layout/CheatsheetDialogs.tsx` | `ui/GesturesSheet.stories.tsx` (Open, KeyboardShortcutsHandoff, Phone) | Props | Teach touch gestures |
| DLG-PRECISION | "Precision boundary": exact offset, fine adjustment, Listen current/proposed, Apply, Cancel; queued-for-sync state | Edit boundary mark > precision edit (host only) | `transcript/PrecisionBoundaryDialog.tsx` (768 lines) | NONE (`transcript/EditBoundaryMark.stories.tsx` shows the mark only) | Store | Exact boundary edits with audition |
| DLG-RECORD | Removed: the Record room dialog became the Record stage (`stage/hosts/RecordStage.tsx`); there is no Menu entry. Create room, Start/Pause/Resume/Stop, Land on timeline, mute, markers, roster, upload status, live comments and mic notices live in the stage and its More sheet; room tone is in the Devices sheet | Stage bar > Record; Share > Open Record stage | `stage/hosts/RecordStage.tsx`, `stage/hosts/RecordStageView.tsx`, `stage/hosts/RecordMoreSheet.tsx` | `stage/hosts/RecordStage.stories.tsx` | Store + Hook | Host recording control |
| DLG-ASK-CONFIRM | Confirm dialogs via `askConfirm`: "Remove the X track?" (Keep track / Remove track), "Cut at 0:12?" (phone and tablet blade; Don't cut / Cut), "Replace audio on X?", bulk Approve/Reject all, Apply suggested tighten | Remove track; blade on touch; import onto a track with audio; Review group verbs; Tighten apply suggested | `feedback/AskDialog.tsx`, `feedback/AskDialogView.tsx`, `feedback/ask.ts`, `utils/pendingReviewPass.ts` | `feedback/AskDialogView.stories.tsx` (Confirm) | View | Safety check before a risky action |
| DLG-ASK-TEXT | Removed (#2295): the "Open project" path prompt. With no OS picker, Open project… goes to Home, which shows the Open other… path field | Menu > Open project… when the OS file picker is unavailable | `stages/home/OpenOther.tsx` | `stages/home/OpenOther.stories.tsx` (PathFallback) | View | Ask for an episode folder |
| CMP-INLINE-CONFIRM | Inline confirm (Keep first and focused, then action) inside Share and Record stop | Stop sharing; End room; Stop take | `ui/InlineConfirm.tsx` | `ui/InlineConfirm.stories.tsx` (Default, Busy) | Props | Cheap confirm inside a dialog |

Modal primitives: `ui/Dialog.tsx` (`ui/Dialog.stories.tsx` Default, Danger), `ui/BottomSheet.tsx`, `ui/Field.tsx`, `ui/Menu.tsx`.

---

## 8. Phone shell (`layout/MobileShell.tsx`, `layout/MobileShellView.tsx`)

Bottom nav `navigation "Primary"` with four toggle buttons: Listen, Timeline, Text, More. Mobile mode lives in the store (`mobileMode`, `view.setMobileMode`).

| ID | Surface | Reach | Files | Story | View split | Purpose |
|---|---|---|---|---|---|---|
| SCR-PHONE-LISTEN | Listen: ListenHero (menu, transport, large play/skip ±, timecode, scrubber), status chips (pending edits, stale mix, pipeline, model download), comment list ("Open all"), comment dock | Phone nav > Listen (default) | `layout/MobileShell.tsx` (ListenMode), `layout/ListenHero.tsx`, `layout/ListenPlayhead.tsx`, `layout/listenSeek.ts`, `layout/ListenCommentComposer.tsx` | `layout/ListenHero.stories.tsx` (Default, Playing); `layout/MobileShellView.stories.tsx` Phone360 | Partial View (hero yes; body is Store) | Passive review: listen and comment |
| SCR-PHONE-TIMELINE | Timeline: fixed-playhead timeline with headers, tool rail beneath, selection sheet | Phone nav > Timeline | `layout/MobileShell.tsx`, `timeline/TimelineView.tsx` (`fixedPlayhead`), `timeline/useFixedPlayheadScroll.ts` | `layout/MobileShellView.stories.tsx` Timeline | Partial | Direct editing on phone |
| SCR-PHONE-TEXT | Text: TranscriptPanel full screen | Phone nav > Text | `layout/MobileShell.tsx`, `panels/TranscriptPanel.tsx` | `layout/MobileShellView.stories.tsx` Text | Partial | Edit by text on phone |
| SCR-PHONE-MORE | More hub: command search row, Mix, Comments, History, Tighten, Pipeline (● when running), Import audio / New track + empty-session hint, Layers legend, Add chapter, Gestures, home-screen hint, People | Phone nav > More | `layout/MobileShell.tsx` (MoreHub), `layout/HomeScreenHint.tsx` | `layout/MobileShellView.stories.tsx` MoreComments, MoreMix; MoreHub itself not extracted | Partial | Everything not in the three main modes |
| SCR-PHONE-MORE-PANEL | A More destination (Comments, History, Tighten, Pipeline) with "← More" back | More > item | `layout/MobileShell.tsx`, panels in section 5 | `layout/MobileShellView.stories.tsx` MoreComments only | Partial | Panel on phone |
| SHEET-PHONE-MIX | Mix sheet (title "Mix") | More > Mix | `tracks/TrackMix.tsx` | `layout/MobileShellView.stories.tsx` MoreMix; `tracks/TrackMixView.stories.tsx` | View | See CMP-TRACK-MIX |
| SHEET-PHONE-INSPECTOR | Inspector sheet over Timeline/Text | Tap a clip, word or comment; long-press | see SHEET-INSPECTOR | `layout/MobileShellView.stories.tsx` OpenInspector | Partial | See SHEET-INSPECTOR |
| BAN-HOME-SCREEN-HINT | "Full screen" iPhone add-to-home-screen hint | iOS Safari, More hub | `layout/HomeScreenHint.tsx` | NONE | Props | Nudge to install as a web app |

---

## 9. Guest review (`/r/<token>`)

Guest mode comes from `guest_mode` in the review bootstrap: Viewer `view`, Commenter `comment`, Editor `edit` (`shareMode.ts`). Same shell as the host with fewer controls: no History/Tighten/Pipeline tabs, no Project menu, no Share, banners for role and version.

| ID | Surface | Reach | Files | Story | View split | Purpose |
|---|---|---|---|---|---|---|
| SCR-GUEST-VIEWER | Guest shell, Viewer: banner "Shared view…", listen/mix only, no comment tool | `/r/<viewer token>` | `layout/StudioShell.tsx` (`guestShare`), `shareMode.ts` | `layout/StudioShellView.stories.tsx` GuestFollowing (chrome); `layout/ToolModeToggleView.stories.tsx` CommentOnlyGuest | View | Read-only review |
| SCR-GUEST-COMMENTER | Guest shell, Commenter: "You can comment and suggest edits", Blade as suggestion, pending suggestions | `/r/<commenter token>` | same | partial (same stories) | View | Review with comments and suggestions |
| SCR-GUEST-EDITOR | Guest shell, Editor: "You can add tracks and audio", Import, approve/reject range proposals | `/r/<editor token>` | same | partial | View | Delegated editing |
| SCR-GUEST-MOBILE | Guest on phone: Listen with comment composer, More without host-only tabs | `/r/<token>` at 390 px | `layout/MobileShell.tsx`, `layout/ListenCommentComposer.tsx` | `layout/MobileShellView.stories.tsx` GuestFollowing | Partial | Mobile reviewer |
| SCR-GUEST-LINK-INVALID | "This link does not open the project." | `/r/<token without view>` | `App.tsx` + `ui/ErrorScreen.tsx` | `ui/ErrorScreen.stories.tsx` WithNextStep | Props | Dead link |
| SCR-GUEST-OFFLINE | Cached snapshot when the host is unreachable | `/r/<token>` with bootstrap failing and a stored offline snapshot | `App.tsx`, `services/offlineQueue/offlineStore.ts`, `layout/GuestAttentionBannerView.tsx` | `layout/GuestAttentionBannerView.stories.tsx` (PendingHostEdits, Conflicts, PendingAndConflict, PhoneManyConflicts) | View | Keep working offline, show conflicts |
| BAN-GUEST-ROLE | Guest role banner (`guestShareBannerLabel`) | Top of guest shell | `layout/StudioShell.tsx`, `shareMode.ts` | NONE | Props | State what this link allows |
| BAN-GUEST-VERSION | Guest "newer version available" notice | Host republishes while the guest is open | `layout/GuestVersionNotice.tsx`, `layout/GuestVersionNoticeView.tsx` | NONE | View | Prompt refresh |
| BAN-GUEST-ATTENTION | Offline / pending host edits / conflicts attention banner | Guest with queued or conflicting edits | `layout/GuestAttentionBanner.tsx`, `layout/GuestAttentionBannerView.tsx` | `layout/GuestAttentionBannerView.stories.tsx` | View | Surface sync state |
| BAN-FOLLOW | "Following X" banner (host, guest, agent leader; host-only-tab notice; Esc to stop) | Click an avatar > Follow | `layout/FollowBanner.tsx`, `layout/FollowBannerView.tsx` | `layout/FollowBannerView.stories.tsx` (Following, AgentLeader, GuestHostOnlyTab, HostMirrorsAudition, PhoneLongName) | View | Follow someone else's view |
| CMP-GUEST-COMMENT | Guest comment compose and name step | Comments tab or Listen composer | `comments/CommentCompose.tsx`, `comments/GuestNameStep.tsx`, `layout/ListenCommentComposer.tsx` | CommentCompose yes; name step and Listen composer NONE | Props | Leave feedback |

Guest-specific interactions: INT-COMMENT-MODE, INT-COMMENT-RESOLVE (host only), INT-FOLLOW, INT-PENDING-SUGGEST (Commenter blade or select-range proposes edits for host review).

---

## 10. Record room (`/rec/<token>`; the host side is the Record stage, see the removed DLG-RECORD)

`record/GuestRoomApp.tsx` renders the shared `system/RoomView` page with the Join sheet over it; a Cover (`record/GuestCovers.tsx`) replaces the room for invalid, full and ended links. A producer joins listen-only.

| ID | Surface | Reach | Files | Story | View split | Purpose |
|---|---|---|---|---|---|---|
| SCR-REC-LOADING | "Loading studio…" | `/rec/<token>` before bootstrap | `ui/LoadingScreen.tsx` | `ui/LoadingScreen.stories.tsx` | Props | Wait |
| SCR-REC-INVALID | "This recording link is invalid or has ended." | `/rec/<bad token>` | `ui/ErrorScreen.tsx` | `ui/ErrorScreen.stories.tsx` | Props | Dead link |
| SCR-REC-ACCESS-ENDED | "Recording access ended" / "Invite link closed", Recover or Download full-quality recording | Host closes invite or ends access | `record/GuestCovers.tsx`, `system/Cover.tsx` | `system/Cover.stories.tsx` (InviteClosed, InviteClosedWithLocalRecording, Ended, EndedWithLocalRecording, EndedBusy, EndedDownloaded) | Props | Rescue a local recording |
| SCR-REC-FULL | "Room full" with the occupants, Try again | Join a full room | `record/GuestCovers.tsx`, `system/Cover.tsx` | `system/Cover.stories.tsx` (Full, FullPhone, RoomFull) | Props | Dead end with a retry |
| SCR-REC-DECLINED | Declined scrim over the room ("Join recording" to rejoin) | Decline from the Join sheet, or Not now | `system/DeclinedScrim.tsx`, `system/RoomView.tsx` | `system/RoomView.stories.tsx` (GuestDeclinedDuringTake, GuestDeclinedCanRejoin, GuestDeclinedPhone) | Props | Rejoin without a reload |
| SCR-REC-LOBBY-GUEST | Join sheet over the room: name, microphone, headphones, storage notes, Join and record | `/rec/<guest token>` | `record/GuestRoomApp.tsx`, `system/JoinSheet.tsx`, `record/StorageHeadroomWarning.tsx` | `system/JoinSheet.stories.tsx` (GuestPreMic, GuestPrompting, GuestDenied, GuestInputLost, GuestReady, GuestClippedDuringCheck, GuestLowStorage, GuestStorageBlocked, GuestStaleInput, GuestRejoin, GuestJoining, GuestPhone, GuestPhoneReady) | Props | Prepare to be recorded |
| SCR-REC-LOBBY-PRODUCER | Join sheet for a producer: name and Join to listen | `/rec/<producer token>` | `system/JoinSheet.tsx` | `system/JoinSheet.stories.tsx` (Producer, ProducerPhone) | Props | Listen-only entry |
| CMP-REC-DEVICE | Microphone check: the Join sheet's mic row, then the Device sheet from your own tile or More ▸ Devices (input picker, level meter, headphones, Record room tone; denied/lost/no-input/too-loud states) | inside the Join sheet; Device sheet over the room | `system/MicRow.tsx`, `system/JoinSheet.tsx`, `system/DeviceSheet.tsx`, `record/deviceSheet.ts`, `record/useMicPermission.ts` | `system/JoinSheet.stories.tsx` (GuestPreMic, GuestPrompting, GuestDenied, GuestInputLost, GuestStaleInput), `system/DeviceSheet.stories.tsx` (Ready, Denied, InputLost, NoInput, RoomToneTooLoud, Phone) | Props | Mic setup |
| CMP-REC-CONSENT | Consent: the Join and record button (joining is consent) and Not now | inside the Join sheet | `system/JoinSheet.tsx` | `system/JoinSheet.stories.tsx` (GuestReady, GuestJoining) | Props | Informed consent |
| SCR-REC-ROOM-GUEST | The shared room, guest seat: status pill, people tiles, alerts, Mute, Leave, notes rail, dock | Joined | `record/GuestRoomApp.tsx`, `system/RoomView.tsx` | `system/RoomView.stories.tsx` (GuestWaiting, GuestLive, GuestLiveMuted, GuestMicLost, GuestHostOffline, GuestPaused, GuestLiveFourPeople, GuestSaving, GuestNotesClosed, GuestSameName, GuestWaitingPhone, GuestLivePhone, GuestLivePhoneNotesSheet, GuestLandscape) | Props | In-session experience |
| SCR-REC-ROOM-PRODUCER | The shared room, producer seat: listening only | Producer joined | `record/GuestRoomApp.tsx`, `system/RoomView.tsx` | `system/RoomView.stories.tsx` (ProducerWaiting, ProducerLive, ProducerPhone) | Props | Monitor the session |
| CMP-REC-INDICATOR | Room status pill (waiting, countdown, live, paused, saving, saved, reconnecting) | Room and host stage | `system/RoomStatusPill.tsx` | `system/RoomStatusPill.stories.tsx` (Waiting, Countdown, Live, Paused, Saving, Saved, Reconnecting, Compact) | Props | Capture state |
| CMP-REC-ROSTER | Participant tiles (joining, live, speaking, muted, weak, lost, saving, saved, declined, left) | Room and host stage | `system/RoomTile.tsx`, `ui/ParticipantMeter.tsx` | `system/RoomTile.stories.tsx` (Joining, Live, Speaking, Muted, Weak, Lost, Saving, Saved, Failed, Declined, Left, Self, FourPeopleGrid, PhoneWidth); `ui/ParticipantMeter.stories.tsx` | Props | Who is here |
| CMP-REC-LIVECOMMENTS | Notes rail (marker, note draft, paused, private to host) | Room and host stage | `system/NotesRail.tsx`, `record/useRecordLiveComments.ts` | `system/NotesRail.stories.tsx` (Empty, WithNotesAndMarkers, Drafting, Paused, PrivateToHost, Phone, PhoneSheetHalf) | Props | Mark moments live |
| CMP-REC-UPLOAD | Upload status and recovery | Room, lobby recovery, host Record stage More sheet | `record/UploadStatus.tsx` | `record/UploadStatus.stories.tsx` (Uploading, WaitingToLand, Landed, LandFailed, UploadFailed, PartialKeeper, RecoveryBusy, RecoveryFailed, ReclaimFailed, FingerprintMismatch) | Props | Show local-to-host upload |
| CMP-REC-CLIPPING | Clipping badge on a person tile | Room and host stage | `system/RoomTile.tsx`, `system/RoomAlert.tsx` | `system/RoomTile.stories.tsx` (Clipping); `system/RoomAlert.stories.tsx` (Clipping) | Props | Warn about clipped audio |
| CMP-REC-NOTICES | Room alerts (mic lost, no audio, storage failed, saving failed, recovery, host offline) and the storage headroom warning; save announcer | Room, Join sheet | `system/RoomAlert.tsx`, `record/StorageHeadroomWarning.tsx`, `record/SaveAnnouncer.tsx` | `system/RoomAlert.stories.tsx`; `record/RecordNotices.stories.tsx` (StorageLow, StorageUnknown) | Props | Fail loudly and recoverably |
| CMP-REC-HOSTROSTER | Removed: the host upload roster is no longer a component; per-person saving state shows on the Record stage room | none | none | none | n/a | Host sees every upload |
| CMP-REC-STOP | Removed: the Stop take inline confirm is no longer a component; Stop is the dock Record button, labelled "Stop take" while a take runs (hold it), with a confirm prompt; the More sheet also has a "Stop take" button with the same confirm step | none | none | none | n/a | Prevent accidental stop |
| CHIP-REC-TRANSPORT | Removed: the recording chip in the transport (the Record stage status replaces it) | none | none | none | n/a | Persistent recording status |

---

## 11. Feedback and system surfaces

| ID | Surface | Reach | Files | Story | View split | Purpose |
|---|---|---|---|---|---|---|
| TOAST-MAIN | Feedback toast: success/error/info, Undo, Dismiss, gesture toasts, docks above sheets and tool rail | After edits, failures, copy actions | `feedback/FeedbackToast.tsx`, `feedback/toastDock.ts`, `ui/Toast.tsx`, `state/uiSlice.ts` (`announceStatus`) | `ui/Toast.stories.tsx` (Shown, UndoAndDismiss, UndoUnavailable, UndoReadyAfterSave, Phone, WithoutUndo); the dock is not storied | Props for Toast; Store for the host | Confirm and undo |
| STAT-LIVE | Screen-reader status live region | Silent | `ui/StatusLiveRegion.tsx` | NONE | Props | Accessibility |
| BAN-LOADFAIL | "Could not load transcript and history. Retry" / "Still loading…" banner | Bootstrap failure | `layout/LoadFailureBanner.tsx` | NONE | Props | Recoverable load error |
| EMPTY-STATES | Empty states: comments none, tighten no hits, pipeline "Analyze to load the pipeline steps", history loading, empty session drop, inspector empty, mix empty | various | `ui/EmptyState.tsx` | `ui/EmptyState.stories.tsx` (Default, BesideAField, WithAction) | Props | Teach the next action |
| CMP-INLINE-ERROR | Inline error | many | `ui/InlineError.tsx` | `ui/InlineError.stories.tsx` (Default, Empty, Inline) | Props | Show errors in place |
| CMP-TUNNEL | Online sharing / tunnel status line | Share dialog | `layout/TunnelStatusLine.tsx`, `layout/tunnelStatusCopy.ts`, `layout/useTunnelStatus.ts` | `layout/ShareDialogView.stories.tsx` OnlineSharing* | Props | Is the host reachable |
| CMP-PRESENCE-STATUS | Presence summary in status bar | Status bar | `layout/PresenceStatus.tsx`, `layout/PresenceStatusView.tsx` | `layout/StatusBarView.stories.tsx` GuestActivity | View | Who is here |
| CMP-RAIL-PEEK | Rail label peek tooltip on first use | Tool rail hover/focus | `layout/RailLabelPeek.tsx` | NONE | Props | Name a tool |
| CMP-DESKTOP-GUARD | Desktop wrapper close guard (not a React surface) | Closing the Electron window during recording | `desktop/useDesktopCloseGuard.ts` | NONE | n/a | Prevent data loss |

Design primitives with stories: Avatar, BrandMark, Button, ClipLed, CloseButton, DefinitionList, Dialog, EmptyState, Field, FieldRow, FocusPull, Icon, InlineConfirm, InlineError, LevelMeter, Menu, ParticipantMeter, Pill, SegmentedControl, SurfaceLadder, Timecode, ToggleButton. Without stories: `ui/Tabs.tsx`, `ui/CommandButton.tsx`, `ui/CommandMenuItem.tsx` (adapters; docs say they need none), `ui/GapMark.tsx`, `ui/RippleMark.tsx`, `ui/StatusLiveRegion.tsx`, `ui/sheetHost.tsx`.

---

## 12. Interactions

Shortcuts are from `keymap/registry.ts` (Mod = ⌘ on macOS, Ctrl elsewhere); touch gestures from `commands/gestures.ts`. Full table: `ux/pages/shortcuts.md`. "Static states" means a story can show the before/during/after as frozen states; the live gesture needs Playwright.

| ID | Interaction | Trigger | Surfaces involved | Shortcut / gesture | Story coverage |
|---|---|---|---|---|---|
| INT-PLAY | Play, pause, stop, seek, nudge, go to start/end | Space; K; arrows; Home/End; click ruler; Listen scrubber | CMP-TRANSPORT, CMP-RULER, SCR-PHONE-LISTEN | Space, K, ←/→ (Shift = 5 s), Home/End (or Mod+←/→) | partial (play controls, ruler) |
| INT-AUDITION | Audition mode (Full mix / Edited stems / Original) | Segmented control or Menu > Audition | CMP-TRANSPORT, MENU-MAIN | none | partial |
| INT-SCRUB | Scrub / seek by ruler tap or phone scrubber | Click or tap ruler; drag Listen scrubber | CMP-RULER, SCR-PHONE-LISTEN | none (double-click ruler fits) | partial |
| INT-SELECT | Select clip, extend with modifier, select track, select all tracks | Click clip or header; modifier-click; Mod+A | CMP-CLIP, CMP-TRACK-HEADERS, INS-CLIP, INS-TRACK | Mod+A / Mod+Shift+A | partial |
| INT-MOVE | Move clips between times and tracks (drag, or Move clip form) | Drag clip body; Clip inspector Move clip | CMP-CLIP, INS-CLIP | none | partial (inspector placement yes) |
| INT-TRIM | Trim clip edge (drag, arrows, exact fields) | Drag thin edge strip; focus handle then ←/→ (10 ms, Shift 100 ms) | CMP-CLIP, INS-CLIP | arrows | yes static (TrimPreview) |
| INT-FADE | Set fade in/out; coupled crossfade | Drag corner; focus fade handle and ←/→ (1 ms, Shift 10 ms) | CMP-CLIP, POP-JOIN, INS-CLIP | arrows | yes static (FadeReadout) |
| INT-JOIN | Choose Cut / Fade / Crossfade and length at a join | Click join marker; tap join count to zoom | POP-JOIN, CMP-CLIP | none | yes |
| INT-ROLL | Roll a seam (move boundary between clips); transcript boundary roll | Drag seam or edit-boundary mark | CMP-EDITBOUNDARY, DLG-PRECISION | none | yes static (RollDragPreview) |
| INT-SPLIT | Split at the playhead or at the pointer | Alt-click a lane or clip (mouse); Alt shows a guide; palette Blade cut | CMP-TIMELINE, DLG-ASK-CONFIRM (touch) | Mod+K (Blade cut) | confirm yes |
| INT-DELETE | Delete clip, ripple delete | Delete key; Clip inspector Delete clip | INS-CLIP | Backspace/Delete; Mod+Backspace (ripple) | partial |
| INT-RIPPLE | Ripple on cut or delete (RippleArrow) | Cut or delete with ripple | OVL-PENDING, CMP-CLIP | Mod+Backspace | partial |
| INT-RANGE | Select a time range; act on it (Play, Cut, Mute, Room tone, Move to speaker, Comment, Bounce) | Drag empty lane; Shift-drag clip; Select range tool; phone Select range | CMP-RANGE-ACTIONS, OVL-RANGE | none | NONE for actions |
| INT-COMMENT-MODE | Removed in #2294: the ruler no longer anchors a comment; compose from the Comments panel or the Player bar | none | PNL-COMMENTS | none | n/a |
| INT-COMMENT-RESOLVE | Resolve/reopen, reply, edit a comment | Comment card actions; swipe left on touch | CMP-COMMENT-CARD, INS-COMMENT | swipe left | yes |
| INT-WORD-SELECT | Select words by click, Shift-click, drag, hold-then-drag on touch | Transcript Select intent | PNL-TRANSCRIPT, CMP-RANGE-ACTIONS | long-press then drag | partial (Active/Selected turn) |
| INT-WORD-CUT | Cut or mute selected words/range | Range actions on a text selection | CMP-RANGE-ACTIONS, CMP-WORDRANGE | none (Mod+X is Cut when `canApplyPass12`) | NONE |
| INT-WORD-CORRECT | Correct a word | Correct intent, F2, double-click or double-tap | POP-WORD-EDIT, INS-WORD | F2 | NONE |
| INT-WORD-TIMING | Adjust word timing | Wordbar handles or numeric fields | CMP-WORDBAR | none | NONE |
| INT-WORD-IGNORE | Ignore or restore words | Transcript toolbar | PNL-TRANSCRIPT | none | NONE |
| INT-LOWCONF | Step through low-confidence words | Prev/Next in toolbar | PNL-TRANSCRIPT | none | partial |
| INT-FINDREPLACE | Find and replace in transcript | Toolbar button | CMP-FINDREPLACE | none | NONE |
| INT-SPEAKER | Change speaker for a track | Speaker header button | POP-SPEAKER | none | NONE |
| INT-SPLIT-SPEAKERS | Split one recording into speakers | Track inspector | DLG-SPLIT | none | yes |
| INT-APPROVE | Approve or reject a pending edit; bulk approve/reject | Inspector buttons; Review queue; overlay card | INS-PENDING, PNL-REVIEW-QUEUE, OVL-PENDING, DLG-ASK-CONFIRM | none | partial |
| INT-PENDING-EDGE | Drag a pending edit's start/end handle; nudge source; Suggested bounds | Pending overlay handle; inspector nudges | OVL-PENDING, INS-PENDING | arrows | yes static (DragEndHandle) |
| INT-TIGHTEN | Apply, skip, preview, go to a tighten hit; apply suggested | Tighten panel | PNL-TIGHTEN | Enter, Backspace, P, Mod+Enter | NONE |
| INT-ENVELOPE | Add, drag, set exact envelope points | Create here > Add envelope point; drag point; Apply | OVL-ENVELOPE, INS-ENVELOPE | Enter/Space on point | yes |
| INT-MUTE-SOLO | Mute and solo tracks, clear solo | Header buttons; M / S | CMP-TRACK-HEADERS, CMP-SOLO-CHIP, CMP-TRACK-MIX | M, S | yes (header) |
| INT-FADER | Set track volume; reset to 0 dB | Fader; double-click reset | CMP-TRACK-FADER | none | yes |
| INT-REORDER | Reorder tracks by drag or menu | Drag the reorder handle; Menu > Media Move up/down | CMP-TRACK-HEADERS | Shift+↑/↓ | yes static (ReorderTarget) |
| INT-ZOOM | Zoom in/out, fit session, fit track height, track height, waveform amplitude | Zoom buttons; View menu; Ctrl/Meta wheel; pinch | CMP-TOOLRAIL, MENU-VIEW | =, -, \\, Alt+=, Alt+-, Shift+↑/↓ | partial |
| INT-PINCH | Pinch to zoom keeps time under fingers | Two-touch pinch on timeline | CMP-TIMELINE | pinch | NONE |
| INT-PAN | Pan timeline | Wheel, drag scrollbar; phone: swipe | CMP-TIMELINE | none | NONE |
| INT-LAYERS | Toggle overlay layers | View > Layers; phone More > Layers | CMP-LEGEND | none | yes |
| INT-LAYOUT | Switch layout; resize bottom panel | View > Layout; splitter drag/keys; Restore chip | MENU-VIEW, CMP-SPLITTER, CMP-LAYOUT-CHIP | Mod+Shift+1..4 | partial (splitter yes) |
| INT-FOLLOW | Follow another person; Esc stops | Avatar > Follow | MENU-PEOPLE, BAN-FOLLOW | Esc | yes |
| INT-UNDO | Undo and redo | Rail buttons; Mod+Z; two-finger tap; toast Undo | CMP-TOOLRAIL, TOAST-MAIN | Mod+Z, Mod+Shift+Z, two-finger tap | yes |
| INT-CLIPBOARD | Copy, cut, paste | Edit shortcuts | CMP-TIMELINE | Mod+C / X / V | NONE |
| INT-IMPORT | Import audio by dialog, drop onto empty session or lane, or Replace audio | Menu > Media > Import audio…; drop files | SCR-SHELL-INGEST, MENU-MAIN, DLG-ASK-CONFIRM | Mod+I | partial |
| INT-CREATE | Create-here context menu | Right-click, F10, long-press | MENU-CREATE | F10 / ContextMenu | NONE |
| INT-TOUCH-CHOOSE | Resolve overlapping touch targets | Hold finger over several targets | POP-CHOOSER | long-press | NONE |
| INT-INSPECT-LONGPRESS | Open inspector by long-press; compact inspector detents | Long-press on touch | SHEET-INSPECTOR | long-press | partial |
| INT-PALETTE | Open command palette, search, run, remap | `?` | DLG-PALETTE | ? | yes |
| INT-RECORD | Create room, start, pause, resume, stop, land; marker | Record stage | Record stage (`stage/hosts/RecordStage.tsx`), CMP-REC-* | M (marker while the Record stage is active) | partial |
| INT-SHARE | Create and copy review or record links; stop sharing | Share dialog | DLG-SHARE | none | yes |

---

## 13. Playwright reach recipes

Run the app: `uv run --extra gui podcast gui --host 127.0.0.1 --port <p> --no-open` (see `gui/web/e2e/guiCommand.ts`), then `npm --prefix gui/web run build` once. Tests start it through `npm --prefix gui/web run test:e2e -- <spec>`. Storybook: `npm --prefix gui/web run storybook` (6006). Story ids come from the title, for example `Templates/ShareDialog` + story `Empty` = `templates-sharedialog--empty`; use `e2e-storybook/storyUrl.ts`.

**Common setup**
- **R-HOST.** `page.goto('/?project=' + encodeURIComponent('<abs>/tests/fixtures/sharecut_ux_demo/episode.project.json'))`. The title h1 reads "ShareCut Studio UX demo", the total timecode reads `01:00.000`, tracks `reference` and `guest` appear as `.lane-row[data-track-id="reference"]`. Wait for `getByRole('button', {name:'Play', exact:true})` enabled. Fixture `tests/fixtures/aligned_dialogue/episode.project.json` is the e2e default and has words for the transcript.
- **Viewports.** Desktop 1440x900 (`.daw-shell--desktop`), tablet 820x1024 (`.daw-shell--tablet`), phone 360x800 or 390x844 (`.daw-shell--phone`).
- **Fresh state.** `localStorage` keys that matter: `sharecut.bootstrap.skip`, `sharecut.compactInspector` (peek, half, full), the auto-mix pref (`hooks/autoMixPref.ts`; the config sets it to off so no history entry is written).
- **Host panel tabs.** Desktop/tablet: `page.getByLabel('Editor panels').getByRole('tab', {name:'Comments'|'History'|'Tighten'|'Pipeline'|'Transcript', exact:true})`. Phone: `getByRole('navigation',{name:'Primary'}).getByRole('button',{name:'More',exact:true})`, press "← More" if shown, then `.mobile-more-list` button by name.
- **R-GUEST (token).** From the host page: `POST /api/shares` with `{path, role:'viewer'|'commenter'|'editor'}` returns `share.token`. Open `/r/<token>` in a new context and wait for `.daw-shell-guest` and `.guest-banner` (`e2e/shareNavigation.ts`, `e2e/ux-demo-screenshots.spec.ts`).
- **R-REC.** From the host page: `POST /api/shares/record` with `{path}` returns `room.guest.token` and `room.producer.token`. Guest/producer: `/rec/<token>?e2e=1` with an init script setting `window.__SHARECUT_E2E = true`, Chromium launch args `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` (`e2e/launchOptions.ts`, `e2e/recordRoom.ts`). Host opens the Record stage (Stage bar > Record). Its buttons are `Create record room`, the dock `Record` / `Stop take` / `Resume recording` and `Pause take`, and `More` (`Stop take`, `Land`, `Invite and links…`); `Copy guest link` is in the palette and the Share dialog.
- **R-MENU.** `getByRole('button',{name:'Menu'})` (aria-label "Menu") opens the overflow menu; `getByRole('button',{name:'View'})` opens View (wide bar only). Menu items are `menuitem` roles with the command label (for example `Share…`).

**Per surface**

| IDs | Steps |
|---|---|
| SCR-HOME, SCR-HOME-NEW, SCR-HOME-OPEN, SCR-HOME-ERROR | Dismiss the Setup card first: `localStorage.setItem('sharecut.bootstrap.skip','1')` via init script (`e2e/home.ts` `openHome`). `goto('/?home=1')`. Heading `ShareCut`, tiles `Import audio` and `Record`, `Open other…`, Help, `More` (Models, Connect agent). A new episode: click `Record`; the helper `createEpisodeFromHome` swaps the folder the tile asks the server for. Error: Open other… with a bad path (mock `pickEpisodeProject` to `{unavailable:true}`), read `role=alert`. |
| SCR-SETUP, SCR-SETUP-CHECKING, SCR-SETUP-DOWNLOAD | No skip key. Mock `**/api/bootstrap/status` (rows from `e2e/modelsMock.ts`), `/api/bootstrap/run`, `/events`, `/cancel`. `openHome(page,{dismissSetup:false})`; `getByRole('region',{name:'Get ShareCut ready'})`, buttons `Get ready`, `Choose…`. Checking: hold the status route (nothing shows for 300 ms). Load error: fulfil with 500. |
| SCR-LOADING | Delay `/api/project*` or `/api/review/<t>/bootstrap`; text "Loading project…" / "Loading studio…". |
| SCR-ERROR, SCR-GUEST-LINK-INVALID, SCR-REC-INVALID | `goto('/r/not-a-token')`, `goto('/rec/not-a-token')`. |
| SCR-RECOVERY | Request a project URL not served with `Accept: text/html`; page has links "Open …" and "Choose a different project…". |
| SCR-SHELL-DESKTOP, SCR-SHELL-TABLET, SCR-SHELL-LOADING | R-HOST at the three viewports. Loading: delay the project request. |
| SCR-SHELL-INGEST | R-HOST with a project that has zero tracks (create via Home > New project) ; look for the button with the drop label "Drop audio files here, or Import Audio". |
| SCR-LAYOUT-* | R-HOST desktop; `View` > Layout radios (`menuitemradio` Default/Timeline/Text/Review) or ⌘/Ctrl+Shift+1..4; Restore chip `Restore`. |
| CMP-TRANSPORT, MENU-MAIN, MENU-VIEW, MENU-PEOPLE | R-HOST; `Menu`, `View`, `People in session` group; collapsed bar at tablet and phone widths. |
| CMP-TOOLRAIL | `getByRole('group', { name: 'Timeline view' })`. |
| CMP-STATUSBAR, CMP-SAVEDOT | `footer.status-bar`. |
| CMP-TIMELINE, CMP-RULER, CMP-MARKERS, CMP-CLIP | R-HOST; `.lane-row[data-track-id]`, `.clip-block`. |
| POP-JOIN | Select two adjoining clips with a join marker; click the marker (see `e2e/join-popover.spec.ts`). |
| OVL-PENDING | Project with pending edits (post `/api/document/command`, see `e2e/pendingEdit.ts`, `e2e/documentCommand.ts`). |
| MENU-CREATE | Right-click an empty lane spot or focus the timeline and press `Shift+F10`; `role=menu` named "Create at …". |
| CMP-RANGE-ACTIONS | Drag across an empty lane, or Shift-drag a clip; `region "Range actions"`. |
| CMP-TRACK-HEADERS | `getByRole('group',{name:'Tracks'})`; buttons `Open track details, <label>`, `Reorder track <label>`, mute and solo by `aria-label`. |
| CMP-TRACK-MIX, SHEET-PHONE-MIX | Phone: More > Mix. |
| PNL-TRANSCRIPT, CMP-TURN, POP-SPEAKER, POP-WORD-EDIT, CMP-FINDREPLACE | R-HOST (aligned_dialogue for words). Wait for `[data-transcript-word]`. Toolbar toggles: `Correct`, `Select`, `Annotate`. Speaker: button "Change speaker <name>". Correct: set Correct, click a word, field "Correct word “…”" (or focus a word and press F2). Find: command `Find and replace transcript` (region "Find and replace transcript"). Phone: nav > Text. |
| CMP-WORDBAR | Select one word, region "Word timing" in the inspector (see `e2e/wordbarFlow.ts`). |
| CMP-EDITBOUNDARY, DLG-PRECISION | After a cut, boundary mark in the transcript; precision button opens dialog "Precision boundary" (see `e2e/edit-boundary-precision.spec.ts`, `e2e/boundaryFixture.ts`). |
| PNL-COMMENTS, CMP-COMMENT-*, CMP-GUEST-NAME | Tab Comments; field label per CommentCompose; for the name step use a guest context with no stored name. |
| PNL-HISTORY, PNL-REVIEW-QUEUE, PNL-TIGHTEN, PNL-PIPELINE | Tab by name. Pipeline needs `/api/pipeline/config`; Tighten needs hits (see `e2e/gui-surfaces.spec.ts`, `e2e/pipeline-*.spec.ts`). |
| DLG-STEP-PARAMS | Phone: More > Pipeline > tap a step. |
| INS-* | Click the object: clip (`.clip-block`), pending region, track header, chapter marker, comment pin, word, envelope point. Tablet: `.bottom-sheet[role=dialog]`; phone: compact inspector at the remembered detent. |
| DLG-SHARE | Menu > `Share…`; dialog name "Share" (exact). Button `Create review link`, copy buttons, `Stop sharing`, `End room` confirm (`e2e/share-dialog.spec.ts`). |
| DLG-MCP | Home or Menu > `Connect agent…`; dialog "Connect agent". |
| DLG-HELP | Home > `Help`, or Menu > Help > `Export diagnostics…`; dialog "Help"; button `Create diagnostics bundle`. |
| DLG-MODELS | Home > `Models`, or command palette "Manage models…"; dialog "Models" (mock `/api/bootstrap/*`). |
| DLG-MODEL-GATE | Mock a job start that returns model_needed (`mockModelFailingJob` in `e2e/modelsMock.ts`) then start Export. |
| DLG-WHISPER | Prepare > Getting ready, when the transcription model is missing: the row asks, and downloads only when Get is tapped. |
| DLG-SPLIT | Select a single long track, Track inspector > `Split speakers…`; dialog "Split speakers". |
| DLG-PALETTE | Press `?` with focus on the page, or Menu > Help > Commands and shortcuts; dialog "Commands and shortcuts", search field "Search commands". |
| DLG-GESTURES | Phone: More > `Gestures`; or palette > link. |
| DLG-ASK-CONFIRM | Remove track: select a track, press Delete, or Track inspector > Remove; dialog title "Remove the <label> track?". Touch blade: phone, Blade cut from the command palette. Bulk review: Review > Queue > `Cut all (n)`. |
| DLG-ASK-TEXT | Removed. Menu > `Open project…` with the OS file picker unavailable (mock `pickEpisodeProject` to `{unavailable:true}`) goes to `/?home=1&openOther=1`, where the path field is open. |
| DLG-RECORD | Removed. R-HOST; Stage bar > `Record` (the Record stage, main "Record"). |
| SCR-PHONE-LISTEN/TIMELINE/TEXT/MORE | R-HOST at 390x844; `navigation "Primary"` buttons `Listen`, `Timeline`, `Text`, `More` (see `e2e/phoneTimeline.ts`). Timeline waits for `.timeline-scroll .track-headers:not([aria-busy=true])`. |
| SCR-GUEST-* | R-GUEST for each role at 1440x900 and 390x844. Offline: block `**/api/review/**` after a first load so the cached snapshot path runs (`e2e/offlineQueue.ts`, `e2e/networkOutage.ts`). Version notice: bump the project from the host while the guest is open. |
| BAN-FOLLOW | Two pages (host + guest); click the other person's avatar in `group "People in session"`; see `e2e/presence-follow.spec.ts`. |
| SCR-REC-* | R-REC. Guest: dialog "Join the room"; textbox `Your name`, button `Allow microphone`, toggle "I'm wearing headphones", button `Join and record`. Producer: textbox `Your name`, button `Join to listen`. Declined: click `Not now`, then `Join recording` on the scrim. Full: open more guests than the room cap. Access ended: host ends access or closes invite. In-room: host clicks `Start`. |
| TOAST-MAIN | Do any edit (for example nudge a fade) and read the toast; Undo button inside. |
| BAN-LOADFAIL | Fail `/api/transcript` or `/api/history` once. |
| BAN-HOME-SCREEN-HINT | Emulate iOS Safari UA in a browser context, More hub. |

---

## 14. Coverage table

| Surface | Story | Notes |
|---|---|---|
| SCR-HOME, SCR-HOME-NEW, SCR-HOME-OPEN, SCR-HOME-ERROR | yes | `stages/home/HomeView.stories.tsx`, `OpenOther.stories.tsx`; `HomeScreen` (recents, picker, tiles) is covered by `HomeScreen.test.tsx` |
| SCR-SETUP, -CHECKING, -DOWNLOAD | yes | `stages/home/SetupCard.stories.tsx`; the mapping from models state is `homeModel.test.ts` |
| SCR-LOADING, SCR-ERROR, SCR-COVER | yes | |
| SCR-RECOVERY | no | Server HTML |
| SCR-SHELL-DESKTOP, -TABLET, -LOADING, -INGEST | partial | Real transport/timeline/panels/inspector are replaced by fixtures |
| SCR-LAYOUT-TIMELINE/TEXT/REVIEW | no | Splitter story only |
| CMP-TRANSPORT | partial | Frame and play controls only; menus, mix pill, audition not |
| MENU-MAIN | partial | Menu atom only |
| MENU-VIEW | partial | Legend only |
| MENU-PEOPLE | yes | |
| CMP-LAYOUT-CHIP, CMP-DRAWER-HANDLE, CMP-TABS | no | |
| CMP-TOOLRAIL, CMP-SPLITTER, CMP-STATUSBAR, CMP-SAVEDOT, CMP-PIPELINE-CHIP | yes | |
| CMP-TIMELINE | partial | Only parts; no full canvas |
| CMP-RULER, CMP-MARKERS, CMP-CLIP, POP-JOIN, OVL-PENDING, -APPLIED, -EDITMARKERS, -STALE, -PRESENCE, -ENVELOPE, -BLEED, -RANGE, -COMMENT-BUBBLE | yes | |
| OVL-PROSODY, OVL-RECORDING | no | |
| CMP-RANGE-ACTIONS, MENU-CREATE, POP-CHOOSER, CMP-SOLO-CHIP | no | |
| CMP-TRACK-HEADERS (header, fader, mix) | yes | Meter and column wrapper no |
| PNL-TRANSCRIPT | partial | Turn, ghost chips, boundary mark only |
| POP-WORD-EDIT, POP-SPEAKER, CMP-FINDREPLACE, CMP-WORDBAR, CMP-WORDRANGE, CMP-VOCAB | no | |
| DLG-PRECISION | no | |
| PNL-COMMENTS | partial | Card and compose; panel and name step no |
| PNL-HISTORY, PNL-REVIEW-QUEUE, PNL-TIGHTEN, PNL-PIPELINE, DLG-STEP-PARAMS | no | All store-bound; no View split |
| INS-CLIP | yes | Multi-select no |
| INS-ENVELOPE, INS-BLEED | yes | |
| INS-PENDING, INS-APPLIED, INS-TRACK, INS-CHAPTER, INS-SOCIAL, INS-COMMENT, INS-WORD, INS-RANGE, INS-PEEK | no | |
| SHEET-INSPECTOR, CMP-SEEK-FOOTER | yes | |
| DLG-SHARE, DLG-MCP, DLG-SPLIT, DLG-PALETTE, DLG-GESTURES, DLG-ASK-CONFIRM, DLG-ASK-TEXT | yes | |
| DLG-HELP, DLG-MODELS, DLG-WHISPER | no | |
| DLG-RECORD | partial | Removed; the Record stage stories (`stage/hosts/RecordStage.stories.tsx`) cover its states |
| DLG-MODEL-GATE | partial | Embedded in Deliver/Split stories only |
| SCR-PHONE-LISTEN | partial | Hero yes; body no |
| SCR-PHONE-TIMELINE, -TEXT, -MORE, -MORE-PANEL | partial | Shell views with fixtures |
| SHEET-PHONE-MIX | yes | |
| BAN-HOME-SCREEN-HINT | no | |
| SCR-GUEST-VIEWER/COMMENTER/EDITOR/MOBILE | partial | Shell chrome and role toggles only; no role banner story |
| SCR-GUEST-LINK-INVALID | yes | ErrorScreen |
| SCR-GUEST-OFFLINE, BAN-GUEST-ATTENTION, BAN-FOLLOW | yes | |
| BAN-GUEST-ROLE, BAN-GUEST-VERSION, CMP-GUEST-NAME, CMP-GUEST-COMMENT | partial | Compose yes; others no |
| SCR-REC-LOADING, -INVALID, -FULL, -DECLINED, -LOBBY-*, -ROOM-*, CMP-REC-DEVICE/CONSENT/INDICATOR/ROSTER/LIVECOMMENTS/UPLOAD/CLIPPING | yes | |
| SCR-REC-ACCESS-ENDED, CMP-REC-HOSTROSTER, CMP-REC-STOP, CHIP-REC-TRANSPORT | no | The last three are removed |
| CMP-REC-NOTICES | Room alerts (mic lost, no audio, storage failed, saving failed, recovery, host offline) and the storage headroom warning; save announcer | Room, Join sheet | `system/RoomAlert.tsx`, `record/StorageHeadroomWarning.tsx`, `record/SaveAnnouncer.tsx` | `system/RoomAlert.stories.tsx`; `record/RecordNotices.stories.tsx` (StorageLow, StorageUnknown) | Props | Fail loudly and recoverably |
| TOAST-MAIN | partial | Toast yes, dock no |
| EMPTY-STATES, CMP-INLINE-ERROR, CMP-INLINE-CONFIRM | yes | |
| BAN-LOADFAIL, STAT-LIVE, CMP-RAIL-PEEK | no | |
| CMP-TUNNEL, CMP-PRESENCE-STATUS | yes | |

Tally of the 153 non-interaction items, counted from the Story columns: 65 yes, 33 partial, 55 no. Interactions: 18 yes (frozen states), 15 partial, 13 none.

---

## 15. Prioritized gaps (screens and modals first)

1. **SCR-HOME and SCR-HOME-NEW/OPEN** (first screen every host sees). Done (#2295): `HomeView` stories Empty, WithRecents, FolderMoved, DropHover, Phone; `OpenOther` stories.
2. **SCR-SETUP** (first-run). Done (#2295): `SetupCard` stories Needed, Downloading, Failed, CheckError, Phone.
3. **DLG-MODELS** and **DLG-MODEL-GATE** (own stories for Ask, Downloading, Failed, Ready). Both already use props-driven `ModelRow`; split the `useModels` read from the render.
4. **DLG-HELP**. Stories: Empty, BundleCreated, Consent, Submitting, Queued, Published, Failed, NoRelay. Move the api calls into an adapter.
5. **DLG-RECORD (the removed Record room dialog)**. Done: the dialog became the Record stage, with `RecordStage` stories NoRoom, LookingForRoom, LookupFailed, Lobby, Live, Paused, SavingTakes, MoreSheet, Loading, LoadError, PhoneLive and GuestViewer.
6. **SCR-SHELL with real parts.** Add story-level composition that mounts real `TransportBar`, `Inspector`, panels against a hydrated store (reuse the ClipInspector hydrate pattern) so desktop, tablet and phone full screens can be seen and screenshotted; keep the fixture stand-ins for the isolated-chrome stories.
7. **PNL-TRANSCRIPT** (the main host surface). Hydrate store with `aligned_dialogue`-like fixture. Stories: Navigate, Correct, Select with range, Annotate, Ignored restore chip, Find and replace open, Low confidence stepping, Empty or loading, Phone.
8. **DLG-PRECISION**. Stories: Loading, Editing, Saving, Queued, Error, Guest-hidden.
9. **INS-PENDING** (core review action) and **INS-TRACK**, **INS-WORD**, **INS-COMMENT**, **INS-APPLIED**, **INS-CHAPTER**, **INS-SOCIAL**. All need store hydration only.
10. **PNL-REVIEW-QUEUE, PNL-TIGHTEN, PNL-HISTORY, PNL-COMMENTS** as full panels (each has empty, populated, busy, error, guest variants; Comments has the guest name step).
11. **PNL-PIPELINE and DLG-STEP-PARAMS, DLG-WHISPER**. Largest panel (1435 lines); needs a pipeline-config fixture and a split.
12. **SCR-PHONE-MORE and SCR-PHONE-LISTEN bodies.** Extract `MoreHub` as a View (it is already a separate function in `MobileShell.tsx`), add Listen body stories with chips and comments list, guest variant.
13. **MENU-MAIN and MENU-VIEW as real menus.** Story with Menu open for host, guest, collapsed (tablet/phone) and menu-only (Listen).
14. **MENU-CREATE, POP-CHOOSER, CMP-RANGE-ACTIONS** (touch-first, core editing) with phone frames.
15. **SCR-GUEST role banners and GuestVersionNotice, LoadFailureBanner, BAN-GUEST-ROLE**: one story file `Templates/GuestBanners` covering Viewer, Commenter, Editor, version notice, load failure.
16. **POP-WORD-EDIT, POP-SPEAKER, CMP-FINDREPLACE, CMP-WORDBAR**: prop-only components; quick wins.
17. **SCR-REC-ACCESS-ENDED, CMP-REC-NOTICES** (small).
18. **SCR-LAYOUT-* modes and CMP-DRAWER-HANDLE, CMP-LAYOUT-CHIP**: add three StudioShellView stories for Timeline/Text/Review layouts.
19. **TOAST dock** over a sheet and over the tool rail (phone and tablet).
20. **Interactions with no frozen-state story**: INT-RANGE, INT-WORD-*, INT-TIGHTEN, INT-CREATE, INT-TOUCH-CHOOSE, INT-PINCH, INT-CLIPBOARD. Prefer Playwright captures for these.

---

## Doc drift (prose vs code)

- `ux/pages/screen-inventory.md` lists Share, Connect agent and Help as the host dialogs; code also has Models, Model gate, Whisper picker, Split speakers, Precision boundary, Gestures, Commands and shortcuts, Step parameters, and Ask (confirm and text).
- `docs/design-system.md` says the live `TransportBar`, full Listen and More bodies, connected panels and full DAW page remain outside Storybook. This inventory confirms it: every full panel (Transcript, Comments, History, Tighten, Pipeline) has no story, and 11 of the 14 inspector rows have none.
- "Manage models…" has no menu item; it exists as a command (palette) and as a Home button.
- Quirk: the `?` shortcut and Menu > Help > "Commands and shortcuts" both open DLG-PALETTE; the phone More hub exposes it as the search row.
