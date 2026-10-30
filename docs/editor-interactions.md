# Editor interaction inventory

The #1033 local placement owner shares the existing move geometry and command.
Preview does not change the project. Apply checks the captured project, epoch,
selection, permission, and edit basis inside the mutation queue. Cancel and no-op
leave History unchanged. A stale queued apply is refused before patch or delivery.
The server concurrency policy is unchanged.

`non-drag-placement.spec.ts` is the focused browser proof command target for the
new controls. Its receipts distinguish native mouse or browser touch initiation
from synthetic selectOption assistance.
It covers exact saved 7/27 placements, lanes, refusal/recovery and Undo, plus local
panel preference steps/reset/reload. Panel tests cover the measured ceiling,
oversized preferences, and passive banner and root-font changes without a window
resize. The banner-row and root-font stimuli are synthetic layout fixtures.
The paired shell, role, theme, motion, short height and large-text cells are
specified tests, not claimed acceptance results.
Arbitrary exact timestamp seek remains a separate precision gap.

This inventory separates navigation, local drafts and browser preferences from
saved episode edits. A selected range, ruler seek, zoom or panel resize does not
create document History. A changed episode gesture saves through the existing
document command and workspace mutation; one Undo restores that logical change.
History snapshot counts are not logical action counts.

The checks below name executable coverage. A test file is not a claim that every
input, interruption or device combination passed. The interaction campaign uses
literal intermediate geometry, reversal and bounds, unchanged saved state during
preview, changed release, no-op, cancellation and a subsequent gesture. Runtime
reports must distinguish the measured cells from unsupported or unrun cells.

## Fourteen interaction families

All browser paths in this table are under `gui/web/e2e`. Touch payloads dispatched
by a test are synthetic, even when the browser viewport resembles a phone.

| Family | Pointer behavior and alternative | State and executable checks |
| --- | --- | --- |
| Clip body move | Drag an off-center grab; click selects and modifier click extends selection. Shift drag selects a range instead. The Clip inspector offers Move clip, native target track and exact timeline start, Earlier/Later 10 ms, Use playhead, Apply move and Cancel. No typing is required for time stepping. | Local in-place preview or destination-lane ghost before `MoveClips`; Escape cancels from the existing focus without changing selection timing. Owner cancellation/capture loss, focused-owner blur and unmount discard the preview; later held input is inert. One changed release and Undo. `ClipBlock.test.tsx` and `edit/clipMove.test.ts` cover the owner and geometry. `inventory-audit.spec.ts` uses a separated-clip fixture for native first-drag, reversal, cancellation, saved geometry and Undo. |
| Roll seam | Drag the seam between adjacent clips. Click selects it; Precision boundary supplies exact offset and audition. | Preview moves the paired boundary within legal source limits. `transitions-acceptance.spec.ts` checks saved paired bounds and Undo; `edit-boundary-precision.spec.ts` checks the alternative. |
| Ruler position | Click or tap seeks; double-click fits. Focused Left/Right steps major ticks; Home/End reaches session endpoints. Ordinary desktop ruler dragging is not continuous scrubbing. Phone scroll moves the time by what it moves the content: the playhead keeps its place in the view (time 0 beside the headers on load, the center once playback passes it). | Navigation only. `arrange-chrome.spec.ts`, `pinned-ruler.spec.ts` and `sharecut.mobile.spec.ts` check endpoints, fit, pinning and phone position. An atomic seek has no pointer-preview cancellation transaction. Handled ruler arrows and Home/End stay local rather than also invoking global navigation; global Escape remains available. `ruler-recovery.spec.ts` checks the current endpoint and fit paths. |
| Alt-click Split | Alt held over the timeline lanes shows a 2 px guide (1 px ring) on the lanes the split will cut (the targeted tracks, else the dialogue tracks, the same set Mod+K cuts); Alt-click runs `edit.bladeCut` at that time. A plain click never splits, a click on a control inside a lane is left alone, an Alt press dragged past the 5 px move threshold is a drag and never a split, and the ruler stays a seek (#2294). | Mouse only. Releasing Alt, a window blur or a hidden tab clears the guide; a viewer who cannot suggest edits gets neither guide nor crosshair; a refused or failed split (including a gap with no clip) is announced as an error. The guide uses Highlight under forced colors. The permission gate and the phone/tablet confirm are those of `edit.bladeCut`. `TimelineView.test.tsx` (Alt-click Split) and `stage-shell.spec.ts` cover it. The ruler comment anchor (comment mode) was removed in #2294. |
| Timeline range | Empty-lane mouse drag, Shift clip drag or the phone/tablet Select range rail. Numeric In/Out and lane checkboxes are the alternative. | Local exact occurrence target until Cut/Mute/Comment/Bounce. `contextual-range.spec.ts` checks repeated occurrences, one Undo and guest proposal policy. Its dispatched phone range events are synthetic. |
| Transcript passage | A pointer sweep or a Shift-click extension selects a passage in the Script. Selection maps surviving words and pauses through clip placements. | Local range until an explicit action. Repeated placements require choosing the intended occurrence. `contextual-range.spec.ts` checks resulting range operations; `inventory-audit.spec.ts` checks native passage sweep and Shift-click endpoints without writes; `ScriptHost.test.tsx` checks passage selection. |
| Clip trim | Drag the thin edge strip with existing waveform magnets and source/neighbor limits. Focused arrows move 10 ms, Shift 100 ms; exact timing controls remain available. | Draft then one saved boundary. `fade-curves.spec.ts` and `ClipBlock.test.tsx` check pointer/keyboard geometry, cancellation, no-op and durable values. Hidden snap ticks do not disable the existing magnet. |
| Fade and coupled crossfade | Drag the corner or coupled endpoint. Focused fade arrows move 1 ms, Shift 10 ms; numeric inspector controls supply precise values. | Preview respects remaining clip length, opposite edge and track cap. `fade-curves.spec.ts`, `crossfade-length.spec.ts` and `transitions-acceptance.spec.ts` check persistence, Undo and competing gesture blocking during acknowledgement. |
| Existing volume envelope | Drag an existing point. Enter/Space selects an idle point; Time/Value Apply is the exact alternative. Arrow keys do not provide point editing and may retain global playhead navigation. | Owned preview, for the host and Editor links (other links view envelopes only); Escape, blur and owner interruption cancel, foreign pointer events are ignored. `envelope-recovery.spec.ts` uses native mouse owners and explicitly synthetic foreign events. Points are created from the track inspector's **Add volume envelope** and **Add point**, or the touch create menu's **Add envelope point**. |
| Pending region and chapter/social marker | Pending bodies select; only eligible outer start/end handles drag. There is no whole pending-span drag transaction. Drag chapter position or social body/edge. Existing inspector numeric bounds supply exact edits; dense touch pending regions use Edit timing. | Pending drafts save through `UpdatePendingEdit`; review/apply remains separate. Chapter/social changes use their existing commands. Their owning marker restores its preview on Escape, cancellation/capture loss, blur or unmount; project switches end the old marker lifetime even when values match. Other pointer events are ignored. `transitions-acceptance.spec.ts`, `pending-edge-controls.spec.ts` and `MarkerLane.test.tsx` cover distinct paths; `inventory-audit.spec.ts` checks native chapter/social body preview, Escape, release, exact saved values and Undo in the representative fixture. |
| Transcript edit boundary | Drag the boundary grab; Precision boundary supplies exact offsets, Apply/Cancel and Listen current/proposed. | Existing owned preview and roll lock. `edit-boundary-touch.spec.ts` checks owner isolation, grab geometry and one saved roll; `edit-boundary-precision.spec.ts` checks exact edits, stale recovery and current/proposed routes. The landed boundary engine remains unchanged. |
| Script pane width | The Script divider (`role="separator"`, "Resize Script"): drag; arrows (1 rem), Shift arrows (4 rem), Home/End (smallest, largest), Enter or double-click resets. **T** hides or shows Script. Phone inspectors use Expand/Collapse. | Browser preference only. Keyboard, drag clamps and accessible values use `SCRIPT_WIDTH_MIN_REM` and `SCRIPT_WIDTH_MAX_REM`. The Shorter/Taller/Reset buttons, the bottom splitter and its rail collapse were removed in #2292, with `splitter-recovery.spec.ts`; `ScriptDivider.test.tsx` covers the keyboard and pointer paths. |
| Zoom, pinch and scroll | Persistent zoom controls and Fit; Ctrl/Meta wheel and two-touch pinch at their anchor. Ordinary wheel scrolls. Safari gesture routing is a separate path. | Navigation only. `waveform.spec.ts`, `timelineZoomGestures.test.ts` and `applyAnchoredZoom.test.ts` check deep geometry and anchoring. Synthetic contact tests do not establish physical trackpad or touch delivery. |
| Word timing resize | Wordbar source-local start/end handles, native range/number fields, explicit Apply timing/Cancel draft and optional edge listening. | Owned local draft before `SetTranscriptWordTiming`. `transcript-wordbar.spec.ts` checks real source timing, reload and Undo. Existing transcript boundary wrapping/grab checks live in `edit-boundary-touch.spec.ts`; they are retained rather than reimplemented. |

Build the frontend, then run the focused browser files through the existing
wrapper with zero retries. The wrapper owns a disposable project, port and server.
Use separate output directories when retaining baseline failures and corrected
runs. Do not run concurrent browsers against one mutable fixture.

```bash
npm --prefix gui/web run build
npm --prefix gui/web run test:e2e -- envelope-recovery.spec.ts arrange-chrome.spec.ts pinned-ruler.spec.ts \
  fade-curves.spec.ts crossfade-length.spec.ts transitions-acceptance.spec.ts \
  contextual-range.spec.ts edit-boundary-touch.spec.ts \
  edit-boundary-precision.spec.ts transcript-wordbar.spec.ts \
  pending-edge-controls.spec.ts --retries=0
VITE_SHARECUT_E2E=1 npm --prefix gui/web run build
npm --prefix gui/web run test:e2e -- waveform.spec.ts \
  --grep 'host zooms to near-sample detail' --retries=0
```

The waveform diagnostic spec requires the explicit E2E build above; production
builds remove its tile-mode counter. Keep its instrumented result separate from
the production-built interaction checks.

`inventory-audit.spec.ts` supplies the native clip-body, passage and marker
fixture, including a separate fractional-scale marker rollback. Start with `--grep desktop-light` to verify preparation, then expand
the responsive profiles serially. Retain its real
input/hit-test preparation and observations with the campaign results. Unrun
interruption cells remain gaps; aggregate success does not invent those cells.

`navigation-policy.spec.ts` checks trusted ruler and fixed-anchor wheel input,
focused Find-input refusal, and host/view-only existing-point inspection. The
minimum-scale observation is the rendered clip floor; it does not measure the
underlying zoom minimum. In the representative tablet fixture, the Inspector
covered the selected pending edge; its inventory row checks Source end/Apply
timing with the existing Snap to silence option disabled and exact Undo. That
row does not claim native edge preview on tablet.
`clip-marker-lifecycle.spec.ts`,
`range-passage-lifecycle.spec.ts`, `edge-envelope-lifecycle.spec.ts` and
`wordbar-delivery-lifecycle.spec.ts` retain per-family interruption and delivery
evidence. Capture release is scripted and pointercancel is explicitly synthetic.
Public layer hiding uses a normal focus departure before the menu, so its result
checks a composite blur/unmount route rather than isolated unmount. Chapter click
selection and its seek remain available after a canceled drag; preview restoration
is measured before release and durable state remains unchanged afterward.
The previous-range replacement check starts in exposed clip body: an offset
inside the existing painted range hit its overlay in the browser audit and did
not admit the replacement drag. Clear range and numeric range controls remain
available; the test does not change that overlay hit policy.

First clip selection can open an inspector and change fitted timeline geometry.
The native recovery check starts without preselection or forced clip focus, records
that settled layout before moving, and compares cancellation to that origin.

## Recovery and permission evidence

A mutation check records the outgoing command, response, saved project and history
before preview, during preview, after changed release and after Undo. Cancellation
and no-op must send no mutation. A delayed response, refusal and queued transport
failure are different outcomes. A queue entry is not a server acknowledgement;
replay must retain command identity and avoid a second history action.

Use the existing crossfade acknowledgement case in
`transitions-acceptance.spec.ts` and queued host comment in
`sharecut.smoke.spec.ts` for their actual policies. Their evidence does not prove
every other gesture's rejection path. The host, an Editor, a Commenter and a
Viewer have different action permissions. `contextual-range.spec.ts`
checks proposed ranges and forbidden host approval. Envelope and Wordbar editing
remain host-only; guest navigation does not grant those commands.

The representative cloud matrix uses desktop 1440×900, tablet 820×1024 and
phone 390×844 in light/dark, with sampled reduced motion and fit/deep zoom.
The Script divider is absent on phone; test the shipped Expand/Collapse control.
A mouse at phone width is a mouse test. Record trusted contacts separately from
synthetic foreign-pointer rejection and DOM-dispatched touch.

## Precision, audition and limits

The current proximity magnet is 8 px and is independent of snap-tick visibility.
Keyboard trim/fade steps and exact numeric fields remain the fine-adjustment
alternatives. Do not infer a new snap engine or modifier from this audit.

The Clip inspector exposes the existing Seek join / Play across join footer.
Retained Precision boundary evidence checks Listen current → Listen proposed →
Listen current through the existing audio routes and playing state without saving
that proposal. The join footer is source-verified here; this checkpoint does not
claim a new native Play across join run. Cloud route and playing-state checks do
not establish splice audio quality or physical hearing. No new A/B player is
introduced.

The currently measured separator pointer strip is 10 px high. Keyboard resizing
is available, but physical touch comfort remains unverified; this change does
not enlarge or redesign that target.

Physical iOS/Android, stylus, actual Mac trackpad, native Safari gestures,
VoiceOver/TalkBack and OS interception remain manual validation. The protected Mac
work and #775/#945 audition work are outside this change. Envelope creation #950
is a separate task. Touch-gesture and sheet-drag research is tracked separately
in #951; this inventory does not add those gestures. No telemetry or user study
is added.

## Bounded interaction acceptance checkpoint (2026-10-04)

The original acceptance uses representative behavior and an explicit unverified
inventory, not every controller × input × profile × interruption combination.
Retained evidence contains 108 distinct production-built browser cases; the
instrumented waveform diagnostic remains separate. Stronger assertion reruns do
not add unique cases. The continuation first run passed 12 cases and retained two
range failures. Its corrected two-case range follow-up passed live-target
multilane reversal and exact numeric Mute/accepted Undo. The initial failures
remain evidence: Range actions reflow required fresh lane coordinates, and the
committed full clip rows were compared by stable ID without weakening field
equality or treating changed array order as an edit defect.

The selected-pair diagnostic retained its initial preview precision failure.
With a CSS-pixel preview check, both clips previewed and reversed, then one
accepted `MoveClips` saved both requested full rows with their 20-second spacing
and one history operation. The exact 7/27-second persistence assertion remained
failed: the outgoing command contained tiny fractional offsets from those
times, whose source was not established. Group-specific Undo was not reached. This disproves selection collapse
on the observed path without certifying that whole test. The changed ruler
comment controller's allowed/refused guest pair passed actual bootstrap
capabilities, native submission/full saved row, host Undo, and viewer refusal. `ruler-recovery.spec.ts` and
`edge-keyboard-recovery.spec.ts` retain the current changed-controller behavior
checks; a prepared test is not a runtime PASS.

Actual inventory runs covered desktop 1440×900, tablet 820×1024 and phone 390×844
in both themes: light with normal motion and dark with reduced motion. The
splitter desktop run (before the splitter was removed in #2292) used 1440×1024. Some phone clip preparation used public zoom
controls for a legal body target; those cases are not fit-zoom claims. The tablet
pending case used Source end/Apply timing/Undo because the Inspector covered its
edge. A mouse at phone width remains a mouse result.

Native mouse ownership is distinct from scripted capture release followed by
trusted native loss delivery, explicitly synthetic `pointercancel` or foreign
pointer events, and public layer/page departure combining blur and unmount. None
is an OS-interception or isolated-unmount certification. Trusted CDP two-contact
boundary input is cloud touch evidence, not a physical-device result.

Extra unique bounds, scrolling, touch, interruption and permission combinations
remain explicitly unverified where no actual test asserted them. Shared source
and controller units explain applicability, not a runtime PASS for every row.
Physical devices, assistive technology and heard splice quality remain manual
gaps. #950 envelope creation/discovery and #951 touch-first work are separately
sequenced follow-ups.

## Bounded #951 sheet decision

The #951 touch-editor decision record is [touch-editor-decisions.md](touch-editor-decisions.md).
This follow-up removes the inert BottomSheet grip while keeping its existing
Expand/Collapse and Close controls. It does not add sheet drag handling or change
the bounded #878 counts, cases, or claims above. Physical device checks remain
pending #301, and named-device profiling remains with #879.

## Automatic reduction inspection

The Clip inspector opens **Automatic reduction** for the current occurrence.
A selected region uses the same inspector body on desktop and the phone sheet.
The timeline band uses a compact selector in the lane’s lower gutter. Its visual
wash lets pointer input through to the clip. The full-size inspector list and
keyboard button remain available for narrow regions. The selector is an
activation target registered in the central input contract. It does not start a clip drag or a second touch recognizer. Nearby clip
handles retain the existing touch selection grammar and cancellation behavior.

While a band is being inspected the clip is not selected, so its trim handles
are click-through. A held touch at the selector's edge beside a trim handle
therefore selects that band and opens no chooser. A held press at the
selector where a band starts at a join lists the Roll and the band. In that
fixture the selector and the comment pin are farther apart than
`TOUCH_HIT_RADIUS_PX`, so a held press on the pin lists the Join and the comment, not the band.

Selecting a reduction cancels a local Move clip placement preview first.
Reduction selection and its inspection target stay local to this tab. Canceling
a touch selection restores the prior selection. A stale inspection or a clip
placement preview does not display actionable bands at obsolete geometry.
Refresh clears the selected region and requires an explicit selection again.
