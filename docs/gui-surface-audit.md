# Full GUI audit and fixes

Reviewed 2026-09-30 with Impeccable against the existing Sharecut visual identity.
The scope includes every production React area, shared styles, recording and
review routes, and native startup/error/close surfaces. Refinement preserves task
behavior and the distinction between dense editor chrome and reading rooms.

## Coverage

Source review, rendered examples, and live workflows establish different kinds
of evidence. The source inventory contains about 180 implementation TSX files,
including shared components and application entry points. Helpers and native
wrapper code were reviewed where they determine visible states.

| Area | Source coverage | Rendered and workflow checks |
| --- | --- | --- |
| Shared controls and overlays | All 28 shared components, focus/keyboard helpers, menus, fields, dialogs, status and typography roles | Existing Storybook catalog, modal/menu confirmation, focused Vitest including axe; live modal focus and menu toggle regressions |
| Home, setup and help | Loading/error states, empty/populated home, bootstrap/model selection, help/report flows | Existing stories and focused Home/Bootstrap/Help tests; home inert/focus restoration regression |
| Editor shells and transport | Desktop, tablet and phone modes, transport, status, editing tools, tabs and sheets | Catalog viewport/theme scan; live shell/layout/overlay workflows |
| Panels and inspectors | All nine panel and 15 inspector implementation files, permission branches, error and recovery paths | Focused inspector tests; live panel navigation, long comments/vocabulary/chapter names and phone Pipeline modal checks |
| Timeline, tracks and transcript | Every implementation component and its relevant styles; selection, pending/applied edits, joins, envelopes, marker/comment/presence and word editing states | Catalog scan; live editing, transcript and inspector workflows |
| Recording | All 22 implementation components and relevant hooks; consent/lobby, host/guest/producer rooms, mic/storage/capture failures, room tone, clipping, upload, recovery and terminal states | 42 new prop-driven states; 168 desktop/phone cases in both themes; 12 live recording workflows with fake media; recovery and roster regressions |
| Guest review | Audio readiness, access failures, review controls, comments/replies, filters and layout | Four initial live commenter-share cases at desktop/phone sizes in both themes, with contrast-enabled axe; shipping confirmation adds 320px and enlarged native-field preferences |
| Native wrapper | Splash/startup and sidecar errors, close/quit failure paths, CLI installation and permission interfaces | Responsive splash/error browser checks; OS-native prompts and packaged WebViews remain source-reviewed |

## Findings fixed

| Finding | Change and regression evidence |
| --- | --- |
| Reading inputs expanded consent checkboxes to full width | Exclude checkbox/radio/range from text-input sizing; preserve comfortable labels. Recording phone target checks cover consent. |
| Support text and actions were too small on reading surfaces | Use body/reading type and touch tokens. Share and reading-room actions, hints, labels, errors and Close controls have focused browser coverage. |
| Chapter/reply/action-item fields lacked persistent accessible names | Name the controls; inspector and comment tests exercise their actions and axe. Existing Field hints now use associated IDs. |
| Shortcut category buttons claimed tab semantics without tab keyboard behavior | Use grouped pressed buttons; update component, adapter and story tests. |
| Menu arrows could steal focus after exit; Tab did not close the menu | Close on focus departure and handle arrows only inside the menu. Preserve pointer focus until an open trigger toggles closed. Test forward/backward Tab and repeated trigger clicks. |
| Phone Pipeline parameters lacked modal keyboard handling | Reuse shared Dialog. Shared dialogs portal outside inert chrome; parameters suspend during model-download confirmation to keep one modal active. Test focus trap, dismissal, cancellation and return focus in the app. |
| Long comments, roster names, vocabulary terms and inspector metadata escaped their panes | Wrap text at the owning component, including vocabulary announcements. Live maximum-length and phone/tablet regressions retain reachable actions. |
| Resolved comments, muted track metadata and status labels had insufficient contrast | Preserve state backgrounds/borders and use readable text roles instead of whole-surface opacity or decorative ink. Contrast-enabled browser checks cover both themes. |
| Guest status controls opened unavailable host panels | Render host-only status summaries as text for guests; retain the supported Comments action. Test adapter and view permissions. |
| Applied edit restore failures misreported access restrictions as missing source clocks | Distinguish permission and data failures; test the access matrix and restore callbacks. |
| Keeper recovery promised upload after access/transport ended | Report download advice when upload is unavailable. Tests interrupt real in-memory keeper recovery and cover guest terminal access and host transport loss. |
| Empty-to-joined rosters stayed silent; multiple changes overwrote announcements | Track initial hydration separately and announce subsequent joins/departures together. |
| Startup error paths overflowed the native splash | Add viewport metadata, token padding and text wrapping. Check long paths at 360px and 820px in both themes. |
| Several story wrappers overflowed outside their intended app context | Cap preview widths and put the ruler in its production scroll context. Wide Transport states remain desktop previews; Collapsed is the narrow composition. |
| Envelope story simulated a pointer without browser capture ownership | Use the supported keyboard interaction in its play function; retain real pointer behavior coverage elsewhere. |

## Verification record

The initial catalog pass rendered 294 states at 1440px, 820px and 360px in both
themes, totaling 1,764 cases. It recorded 62 axe finding cases and 58 document
overflow cases, with overlap between categories. One execution-context change interrupted axe;
six Envelope play functions also reported synthetic pointer-capture errors.
Fixes overlapped this pass, so it is not a pristine before-change baseline.

The first targeted confirmation covered 468 cases. It had no overflow, render
failures or page errors, but retained six warning/audition pill contrast cases.
After correcting those text roles and integrating the modal review fixes, a
second targeted check covered 192 pill/menu/dialog cases with zero axe violations,
overflow, render failures or page errors. The separate final recording matrix
covered 168 cases with the same clean result. Axe included WCAG A/AA contrast.
These checks do not constitute exhaustive accessibility certification.

The pre-shipping editor/splash run passed 25 cases. Its 21 editor cases
include 30 panel scans and six chapter-inspector scans across both themes and
three sizes with contrast enabled. A broader 43-case run passed existing editor
workflows and all 12 recording workflows against the final build. Four separate
live guest-review cases passed. Focused Python CSS, Storybook workflow and native
packaging-policy checks pass all 44 tests.

The complete frontend suite passes all 4,850 tests in 477 files. Frontend lint,
formatting, typecheck, production app build and Storybook build pass. Lint/build
retain existing warnings. The production build guard excludes catalog-only code.
The Chromium/WebKit compatibility matrix passes all 18 cases, including playback,
offline/reconnect, phone layout, recording, review, Bounce and waveform flows.
Together, the pre-shipping editor/splash, broader workflow, guest-review and compatibility
runs comprise 90 passing browser cases; earlier repeated runs are not added to
that total.

## Practical limits

Chromium recording workflows use fake microphone input. Physical microphones,
physical device removal, sound quality, OS-native permission/quit prompts and
packaged Tauri WebViews require platform/device validation. The native splash
checks exercise its real HTML in Chromium, not the packaged native process.

Real processing pipelines and speech-model downloads were not run during this
visual audit. Running/error pipeline states and the remaining FX, music-track
and session inspector subtypes received source/unit/story coverage.

Every production surface received source review; runtime checks cover the
catalog matrix and named workflows, not every possible combination of role,
network timing, device and project data. No new lint suppression or detector
ignore was added. Dense timeline geometry and compact editor controls remain
intentional; measuring a target below 44px alone does not establish a defect in
that context. Pipeline progress animation respects reduced motion; its layout
cost was not profiled, so no performance improvement is claimed.

Decision trail: [gui-audit-decisions.tsv](gui-audit-decisions.tsv).
The initial component pass is preserved in [design-system-audit.md](design-system-audit.md).

## Known interaction gap and follow-ups

After this audit, review of EditBoundaryMark identified cursor drift and bouncing
while dragging. [Issue #877](https://github.com/calebn/sharecut-studio/issues/877)
tracks the defect, preview layout, cancellation semantics, and intermediate
geometry regressions. The audit's drag completion checks did not measure the
pointer-to-handle offset throughout the gesture. Source and catalog coverage do
not establish that every interaction meets the quality requirements.

Follow-up work is scoped separately from this consistency patch:

- [#878](https://github.com/calebn/sharecut-studio/issues/878) reviews precision,
  feedback, snapping, cancellation, and recovery across editor interactions.
- [#879](https://github.com/calebn/sharecut-studio/issues/879) measures large-project
  responsiveness and progress rendering before optimizing.
- [#880](https://github.com/calebn/sharecut-studio/issues/880) validates physical
  recording hardware and packaged desktop states, using existing
  [#193](https://github.com/calebn/sharecut-studio/issues/193) and
  [#301](https://github.com/calebn/sharecut-studio/issues/301) for quit and phone QA.

The [design system interaction requirements](design-system.md#interaction-quality-requirements)
define the target without implying those follow-ups have shipped.

## Shipping CI corrections

The first Linux PR browser run exposed a guest-review column that grew with
native fields' preferred width. The reading column now stays within its parent,
and composer fields can shrink. The guest regression matrix includes 320px
with enlarged native field preferences, as well as the original 360px and
1440px cases in both themes. These shipping checks supplement the pre-shipping
90-case record rather than replacing its evidence with a fresh full local run.

The phone model-confirmation fixture now declares an installed current Whisper
model and an uncached alternative. It exercises the intended confirmation path
without depending on installed models on the runner. Touch-target assertions
retain an exact 44px layout-height floor and allow only 0.001px of floating-point
error in translated bounding rectangles.

Local shipping confirmation passes six guest-review cases and five focused model,
Share, and Bounce cases. The enlarged-field 320px regression fails against the
old build before the layout fix. Eight beta-story coverage-policy tests pass.
