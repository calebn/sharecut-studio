# Component consistency audit

Reviewed 2026-09-30 while adding Storybook **Style guide / Start here**.
The audit compares current components with the incumbent token, brand, and
library rules. It does not propose a new visual identity.

This initial component pass is superseded by the broader
[full GUI surface audit](gui-surface-audit.md). Its coverage below records the
starting point, not the final scope of this change.

## Coverage and method

Two independent assessments reviewed the shared library and domain compositions.
One assessed source, styles, and representative browser examples without seeing
Impeccable detector output. The other ran the detector and inspected source.

All 28 shared production component files were reviewed:
Avatar, BottomSheet, Button, ClipLed, CloseButton, CommandButton,
CommandMenuItem, CoverScreen, DefinitionList/DefItem, Dialog, EmptyState,
ErrorScreen, Field, FieldRow, FocusPull, GesturesSheet, Icon, InlineError,
InspectorSeekFooter, InspectorSeekFooterView, LevelMeter, LoadingScreen, Menu
(including MenuItem/MenuSection), Pill, SegmentedControl, Timecode,
ToggleButton, and UndoToast. Supporting hooks, exports, tokens, reading overrides,
overlay styles, and inspector styles were included where they determine behavior.

The domain composition inventory covered 42 story families:

| Area | Story families |
| --- | --- |
| Layout (16) | AvatarStack, BottomTabsSplitter, BounceDialog, CommandPalette, EditingToolRail, FollowBanner, GuestAttentionBanner, HostMcpDialog, ListenHero, OverlayLegend, PipelineStatusChip, ShareDialog, StatusBar, ToolModeToggle, TransportFrame, TransportPlayControls |
| Timeline (12) | AppliedEditOverlay, ClipBlock, CommentPlaybackBubble, EnvelopeOverlay, JoinBadge, JoinPopover, MarkerLane, PendingEditOverlay, PresenceOverlay, StaleInvalidationOverlay, TimeRuler, TimelineRange |
| Transcript (3) | EditBoundaryMark, GhostWordChips, TranscriptTurn |
| Comments (2) | CommentCard, CommentCompose |
| Recording (8) | ConsentGate, Declined, DeviceCheck, FullRoom, HostUploadRoster, LiveComments, Lobby, RecIndicator |
| Tracks (1) | TrackHeader |

Domain coverage was a source/composition review, with deeper inspection of forms,
dialogs, recording screens, and control consumers. Representative browser checks
covered quiet ToggleButton, DefinitionList, phone ShareDialog, and mobile Lobby.
The new guide was checked at 360px and 1200px in light and dark themes, including
catalog links, horizontal overflow, and axe WCAG A/AA checks with contrast enabled.
This is not an interactive certification of every domain state or browser.

Impeccable markup detection scanned all 411 TSX files then present (179
implementation files, 69 story files, 163 tests), including the guide under
construction, and returned zero findings. No rule/file/value ignores were added.
A supplemental CSS scan flagged the pipeline fill's `width` transition in
`styles/partials/panels.css`. Reduced motion already gates this animation;
the warning is a performance lead, not proof of a visible defect.

## Findings addressed in this change

| Priority | Evidence before the change | Resolution |
| --- | --- | --- |
| P1 | Phone Share and Lobby actions measured about 25.6px high, compared with the repo's 44px touch minimum. CloseButton was a 2rem square. | Share actions and checkbox labels, reading-room controls, and shared dialog close buttons use `--touch-min`. Browser measurements confirm 44px actions in Share and Lobby. Dense editor controls retain their existing sizing. |
| P2 | Lobby Field labels measured 11px next to reading copy and larger inputs. | Reading-room labels, hints, and errors use `--font-size-body`; actions use reading-body type. Lobby labels now measure 14px and actions 16px. |
| P2 | Brand/token/library docs claimed every selected control used a neutral chip, but `.ui-control--quiet` shipped transparent fill and an underline. | Docs and guide explicitly distinguish standalone quiet tabs/toggles from default toggles and grouped segments. Existing selected behavior is preserved and illustrated. |
| P2 | GesturesSheet and CommandPaletteView used raw buttons with only the quiet modifier, bypassing `.ui-control`. | Both cross-links use the existing `Button` link variant and retain callback behavior. |
| P2 | Field could not expose hint/error IDs, and its stories showed visually complete help without a programmatic description. | Added optional `hintId`/`errorId`, documented the caller's `aria-describedby`/`aria-invalid` responsibility, and updated stories and guide. Tests verify accessible descriptions and clearing an error. This does not automatically migrate every existing Field caller. |
| P3 | DefinitionList's standalone story missed the inspector ancestor that owns its typography and spacing. | Story now uses the real inspector context; the library contract explains the composition. |
| P3 | Host MCP snippet and edit-boundary marks used system monospace rather than the bundled family. | Both use `--font-family-mono`. |
| P3 | Field hints used opacity on inherited foreground rather than a semantic text role. | Hints use `--color-text-secondary`. No prior contrast failure was claimed. |

## Remaining work

| Priority | Follow-up | Verification needed |
| --- | --- | --- |
| P2 | Share retains margin-based composition while Bounce uses explicit section/option/footer gaps (`styles/partials/command-palette.css`). Adopt the documented recipe when simplifying Share's creation/list sections. | Long review/record lists, error/status insertion, narrow/short viewports, and lower-action reachability. |
| Resolved | Existing Field hint callers now use explicit description IDs. | Bootstrap and transcript-refinement waiver regressions check the association. |
| P2 | Check compact SegmentedControl and generic native inputs in any new phone context. Their dense editor baseline is intentional. | Per-context touch dimensions and keyboard behavior; do not enlarge all DAW chrome globally. |
| P3 | Consider transform-based pipeline fill animation instead of transitioning width. | Measure layout cost during progress updates before changing the implementation; preserve reduced-motion behavior. |
| P3 | Expand isolated state coverage for RoomToneCapture, StorageHeadroomWarning, NoAudioNotice, MicLossNotice, CommandButton, and CommandMenuItem. | Error, disabled, long-copy, phone, both-theme, and keyboard examples. Existing composition coverage is not equivalent to isolated coverage. |

The shared token architecture, overlay focus/dismissal behavior, native form
controls, reduced-motion gates, and neutral selection treatment remain coherent.
Timeline geometry, inspector metadata, and fixed-dark transport controls are
intentional context differences. Further checks should preserve those distinctions.

## Validation

Focused Vitest tests cover guide navigation/interactions and axe, Field
associations, shortcut callbacks, catalog source boundaries, and the production
build guard. Playwright checks cover Share target sizes/scroll reachability and
mobile recording form targets. Frontend lint, formatting, typecheck, app and
Storybook builds, and CSS policy checks accompany this change. See
[design-system.md](design-system.md) for catalog workflow and
[ui-library.md](../gui/web/docs/ui-library.md) for composition recipes.
