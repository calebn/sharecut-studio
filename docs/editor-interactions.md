# Editor interaction inventory

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
| Clip body move | Drag an off-center grab; click selects and modifier click extends selection. Shift drag selects a range instead. A focused keyboard move equivalent is not established. | Local move ghost before `MoveClips`; Escape cancels from the existing focus without changing selection timing. Owner cancellation/capture loss, focused-owner blur and unmount discard the preview; later held input is inert. One changed release and Undo. `ClipBlock.test.tsx` and `edit/clipMove.test.ts` cover the owner and geometry. `inventory-audit.spec.ts` uses a separated-clip fixture for native first-drag, reversal, cancellation, saved geometry and Undo. |
| Roll seam | Drag the seam between adjacent clips. Click selects it; Precision boundary supplies exact offset and audition. | Preview moves the paired boundary within legal source limits. `transitions-acceptance.spec.ts` checks saved paired bounds and Undo; `edit-boundary-precision.spec.ts` checks the alternative. |
| Ruler position | Click or tap seeks; double-click fits. Focused Left/Right steps major ticks; Home/End reaches session endpoints. Ordinary desktop ruler dragging is not continuous scrubbing. Phone scroll moves time under its fixed playhead. | Navigation only. `arrange-chrome.spec.ts`, `pinned-ruler.spec.ts` and `sharecut.mobile.spec.ts` check endpoints, fit, pinning and phone position. An atomic seek has no pointer-preview cancellation transaction. |
| Ruler comment anchor | Comment mode click creates an instant anchor; drag beyond 4 px drafts a span. The composer supplies exact bounds and an explicit submit action. | Escape exits comment mode and clears the draft. Anchoring alone saves no comment. Interrupted ownership outside Escape needs separate evidence; submission/queue tests do not establish it. `TimeRuler.test.tsx` and comment cases in `sharecut.smoke.spec.ts` cover their distinct paths. |
| Timeline range | Empty-lane mouse drag, Shift clip drag or the phone/tablet Select range rail. Numeric In/Out and lane checkboxes are the alternative. | Local exact occurrence target until Cut/Mute/Comment/Bounce. `contextual-range.spec.ts` checks repeated occurrences, one Undo and guest proposal policy. Its dispatched phone range events are synthetic. |
| Transcript passage | Select passage mode accepts pointer sweep or a Shift-click extension. Selection maps surviving words and pauses through clip placements. | Local range until an explicit action. Repeated placements require choosing the intended occurrence. `contextual-range.spec.ts` checks resulting range operations; `inventory-audit.spec.ts` checks native passage sweep and Shift-click endpoints without writes; `TranscriptPanel.test.tsx` checks passage selection. |
| Clip trim | Drag the thin edge strip with existing waveform magnets and source/neighbor limits. Focused arrows move 10 ms, Shift 100 ms; exact timing controls remain available. | Draft then one saved boundary. `fade-curves.spec.ts` and `ClipBlock.test.tsx` check pointer/keyboard geometry, cancellation, no-op and durable values. Hidden snap ticks do not disable the existing magnet. |
| Fade and coupled crossfade | Drag the corner or coupled endpoint. Focused fade arrows move 1 ms, Shift 10 ms; numeric inspector controls supply precise values. | Preview respects remaining clip length, opposite edge and track cap. `fade-curves.spec.ts`, `crossfade-length.spec.ts` and `transitions-acceptance.spec.ts` check persistence, Undo and competing gesture blocking during acknowledgement. |
| Existing volume envelope | Drag an existing point. Enter/Space selects an idle point; Time/Value Apply is the exact alternative. | Host-only owned preview; Escape, blur and owner interruption cancel, foreign pointer events are ignored. `envelope-recovery.spec.ts` uses native mouse owners and explicitly synthetic foreign events. Creation/discovery is separately deferred to #950. |
| Pending region and chapter/social marker | Drag a pending outer edge/span, chapter position or social body/edge. Existing inspector numeric bounds supply exact edits; dense touch pending regions use Edit timing. | Pending drafts save through `UpdatePendingEdit`; review/apply remains separate. Chapter/social changes use their existing commands. Their owning marker restores its preview on Escape, cancellation/capture loss, blur or unmount; project switches end the old marker lifetime even when values match. Other pointer events are ignored. `transitions-acceptance.spec.ts`, `pending-edge-controls.spec.ts` and `MarkerLane.test.tsx` cover distinct paths; `inventory-audit.spec.ts` checks native chapter/social body preview, Escape, release, exact saved values and Undo in the representative fixture. |
| Transcript edit boundary | Drag the boundary grab; Precision boundary supplies exact offsets, Apply/Cancel and Listen current/proposed. | Existing owned preview and roll lock. `edit-boundary-touch.spec.ts` checks owner isolation, grab geometry and one saved roll; `edit-boundary-precision.spec.ts` checks exact edits, stale recovery and current/proposed routes. The landed boundary engine remains unchanged. |
| Editor panel space | Desktop/tablet separator drag; arrows, Shift arrows, Home/End, Enter and double-click reset. Phone inspectors use Expand/Collapse. | Browser preference only. Accessible values report the measured panel height, including an unset responsive default. Owner interruption or Escape restores the prior explicit value or absence while still owned. `splitter-recovery.spec.ts` checks intermediate/reversed geometry, cancellation, capture loss, clamp/no-op and phone alternatives in both themes. |
| Zoom, pinch and scroll | Persistent zoom controls and Fit; Ctrl/Meta wheel and two-touch pinch at their anchor. Ordinary wheel scrolls. Safari gesture routing is a separate path. | Navigation only. `waveform.spec.ts`, `timelineZoomGestures.test.ts` and `applyAnchoredZoom.test.ts` check deep geometry and anchoring. Synthetic contact tests do not establish physical trackpad or touch delivery. |
| Word timing resize | Wordbar source-local start/end handles, native range/number fields, explicit Apply timing/Cancel draft and optional edge listening. | Owned local draft before `SetTranscriptWordTiming`. `transcript-wordbar.spec.ts` checks real source timing, reload and Undo. Existing transcript boundary wrapping/grab checks live in `edit-boundary-touch.spec.ts`; they are retained rather than reimplemented. |

Build the frontend, then run the focused browser files through the existing
wrapper with zero retries. The wrapper owns a disposable project, port and server.
Use separate output directories when retaining baseline failures and corrected
runs. Do not run concurrent browsers against one mutable fixture.

```bash
npm --prefix gui/web run build
npm --prefix gui/web run test:e2e -- splitter-recovery.spec.ts \
  envelope-recovery.spec.ts arrange-chrome.spec.ts pinned-ruler.spec.ts \
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
every other gesture's rejection path. Host, edit guest, suggest-only guest and
view-only guest have different action permissions. `contextual-range.spec.ts`
checks proposed ranges and forbidden host approval. Envelope and Wordbar editing
remain host-only; guest navigation does not grant those commands.

The representative cloud matrix uses desktop 1440×900, tablet 820×1024 and
phone 390×844 in light/dark, with sampled reduced motion and fit/deep zoom.
Desktop splitters are absent on phone; test the shipped Expand/Collapse control.
A mouse at phone width is a mouse test. Record trusted contacts separately from
synthetic foreign-pointer rejection and DOM-dispatched touch.

## Precision, audition and limits

The current proximity magnet is 8 px and is independent of snap-tick visibility.
Keyboard trim/fade steps and exact numeric fields remain the fine-adjustment
alternatives. Do not infer a new snap engine or modifier from this audit.

Existing Play across join and Precision boundary Listen current/Listen proposed
are evaluated through their existing playback routes without saving an edit.
Cloud route and playing-state checks do not establish splice audio quality or
physical hearing. No new A/B player is introduced.

The currently measured separator pointer strip is 10 px high. Keyboard resizing
is available, but physical touch comfort remains unverified; this change does
not enlarge or redesign that target.

Physical iOS/Android, stylus, actual Mac trackpad, native Safari gestures,
VoiceOver/TalkBack and OS interception remain manual validation. The protected Mac
work and #775/#945 audition work are outside this change. Envelope creation #950
is a separate task. Touch-gesture and sheet-drag research is tracked separately
in #951; this inventory does not add those gestures. No telemetry or user study
is added.
