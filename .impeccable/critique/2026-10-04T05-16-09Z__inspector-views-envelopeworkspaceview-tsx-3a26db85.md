---
target: Volume envelope workspace — independent Assessment B
total_score: 29
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 0
target_identity: "file:/workspace/poteto-950/worktree/gui/web/src/inspector/views/EnvelopeWorkspaceView.tsx"
target_fingerprint: "sha256:fee7273985e7f967a81ac026d8df5fc77c9d27943451ab52d9012c2a9e32d133"
target_path: /workspace/poteto-950/worktree/gui/web/src/inspector/views/EnvelopeWorkspaceView.tsx
timestamp: 2026-10-04T05-16-09Z
slug: inspector-views-envelopeworkspaceview-tsx-3a26db85
---
# Assessment B — volume envelope workspace

Method: dual-agent (A: /root/design_judge · B: /root/review_correctness). This is B's independent assessment only; A's findings were not read. Requested native reviewer configuration Astra medium; served model/tier unobservable.

Scope: established Operate editor UI, `gui/web/src/inspector/views/EnvelopeWorkspaceView.tsx`. Fresh desktop light 1440×900 and emulated phone dark 360×740 contexts; track entry → empty envelope → Add point draft → Cancel. No save/delete or physical touchscreen claim. The candidate's served JS/CSS bytes matched its frozen and on-disk asset identities in each context. Both recorded zero document commands and unchanged saved project bytes.

## Verdict and specificity

The workspace is recognizably an audio editor, with explicit timeline seconds, level multipliers, track identity and envelope semantics. It is not a generic dashboard or decorative landing page. Desktop hierarchy and controls work within the existing inspector. One evidenced P2 responsive visibility issue warrants bounded refinement. No P0/P1 defect was demonstrated by this draft-only assessment. This is not a general functional acceptance certificate.

## Heuristics

Scores are scoped judgments combining observed draft flow and clearly identified source evidence, not certificates for unvisited save/error paths.

| # | Heuristic | Score /4 | Basis |
|---|---|---|---|
| 1 | Visibility of system status | 3 | Explicit editing context and focused draft; phone focus is below the exposed sheet content. Saving status is source evidence only. |
| 2 | Match to real world | 4 | Timeline seconds and multiplier meaning, including unity/silence/maximum, are stated clearly. |
| 3 | User control and freedom | 3 | Done and Cancel are explicit; Cancel returned to Add point in both contexts. Undo not exercised here. |
| 4 | Consistency and standards | 3 | Existing inspector, buttons, themes and focus treatment; no competing visual system. |
| 5 | Error prevention | 3 | Source bounds, busy disabling and field associations are present; invalid submission not exercised here. |
| 6 | Recognition over recall | 3 | Visible labels and explanations; phone hides immediate editing controls below introductory content. |
| 7 | Flexibility and efficiency | 2 | Desktop direct form; phone requires additional scrolling/expansion to expose draft controls. |
| 8 | Aesthetic and minimalist design | 2 | Calm established styling; empty-state explanation remains alongside draft and consumes scarce phone height. |
| 9 | Error recognition and recovery | 3 | Source has targeted alerts and explicit discard/reload recovery. No live error state visited in this batch. |
| 10 | Help and documentation | 3 | Useful task-specific inline help; lengthy placement competes with the form on phone. |

Total: **29/40**. No n/a heuristics. Cognitive load: low-to-moderate on desktop, moderate on phone because explanatory text precedes the working controls. Emotional journey: clear entry and reassuring semantics, followed by uncertainty about where to type on the initial phone draft; visible Expand and successful Cancel provide recovery.

## Priority issue

**P2 — expose the active draft within the phone sheet.** In `B-phone-dark-draft.png`, the sheet's visible working region ends above the bottom navigation/status area while the focused Time input begins at y658, Level at y738, and Save/Cancel at y790 (viewport height740). The initial empty state also places Add point at the bottom edge beneath a long explanation (`B-phone-dark-empty.png`). The source retains empty-state copy while rendering the draft form. See EnvelopeWorkspaceView.tsx form lines156–233 and its preceding explanatory/empty-state content.

A bounded remedy should prioritize the active form and its actions when Add point is chosen—for example, reduce redundant empty-state copy during editing and ensure the existing sheet scroll/expansion exposes the focused input. Preserve useful multiplier semantics and the existing sheet system. Acceptance should verify visible/hittable input and actions after actual Add point in this same phone layout, without relying on Playwright auto-scroll. Cancel clicked successfully with Playwright's scrolling, so this is not evidence that the controls are unreachable. No keyboard-open, physical-touch, or human-visibility proof was collected. Do not infer a specific focus/scroll cause from these screenshots alone.

Only one independently evidenced priority issue is reported; related density and below-fold symptoms are not inflated into multiple findings.

## Strengths and persona considerations

- Track identity and explicit envelope terminology preserve context and explain domain effects rather than exposing implementation details.
- Desktop fields/actions fit the inspector. Measured numeric inputs and Save/Cancel have44px height; the focused Time field is visibly distinguished.
- Both themes retain the established editor language. The draft is cancellable without issuing a document command.

A new audio editor benefits from the unity/silence explanation. A frequent mobile editor pays the largest repeated navigation cost; a keyboard or magnification user may also be affected by off-screen focus, but those modalities were not tested. Screen-reader associations are source-grounded through labels and per-field error IDs, not a screen-reader runtime claim. No new color/contrast or unsupported interaction defect is asserted.

## Detector and evidence limits

Scoped CLI detector: exit0, raw `[]`, zero findings/rules/locations, no ignored/suppressed entries. CLI output does not certify the layout. Both actual pages passed the mutable title and appended application/json script probe. After that probe, a real local live-server was started and `http://localhost:8400/detect.js` injection attempted. Both attempts were blocked by the actual `script-src 'self'` CSP; full errors and in-page console messages are in runtime.json. No detector execution, live overlays, or detector badges are claimed. A blocked script element appearing in DOM is not evidence of execution. No CSP bypass was attempted.

This was headless Chromium via CDP, with screenshots and geometry inspected by the reviewer, not a browser presented to a human. Phone is viewport/touch-capability emulation; actions use native Playwright click API, not physical touch. No additional matrix, production writes, or save mutations were performed.

Evidence directory: `/workspace/poteto-950/artifacts/950-impeccable-b`. Raw detector JSON/stderr/exit, runtime.json, run.ts/run.log, live-start/stop logs, both per-profile evidence JSONs, and eight screenshots are retained. The source-frozen candidate host and asset map are identified by the harness candidate ready.json.

Questions skipped: user authorized bounded issue implementation; root synthesizes findings without reopening scope.
