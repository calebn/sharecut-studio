# Issue #20 visual comparison

These captures use the same deterministic Playwright episode fixture and
viewport before and after the design polish change. **Before** is the light
theme on `main` before #20; **after** shows the facelift in both themes.
Desktop views are 1440 × 900; the phone view is 390 × 844 (the Listen screen
with its hero). The capture path is `gui/web/e2e/design-polish.spec.ts`
(`DESIGN_POLISH_SCREENSHOT_DIR`). The empty timeline uses a separate
disposable empty project with `EMPTY_STAGE_SCREENSHOT_DIR` set during capture.

| View | Before (light) | After (light) | After (dark) |
| --- | --- | --- | --- |
| Timeline | ![Timeline before](before/timeline.png) | ![Timeline after, light](after/timeline.png) | ![Timeline after, dark](after/timeline-dark.png) |
| Inspector | ![Inspector before](before/inspector.png) | ![Inspector after, light](after/inspector.png) | ![Inspector after, dark](after/inspector-dark.png) |
| Share dialog | ![Share dialog before](before/share-dialog.png) | ![Share dialog after, light](after/share-dialog.png) | ![Share dialog after, dark](after/share-dialog-dark.png) |
| Empty state | ![Empty state before](before/empty-state.png) | ![Empty state after, light](after/empty-state.png) | ![Empty state after, dark](after/empty-state-dark.png) |
| Empty timeline | — | ![Empty timeline after, light](after/empty-timeline.png) | ![Empty timeline after, dark](after/empty-timeline-dark.png) |
| Phone Listen | ![Phone before](before/mobile-nav.png) | ![Phone after, light](after/mobile-nav.png) | ![Phone after, dark](after/mobile-nav-dark.png) |

Storybook has the reusable pieces behind these views for iteration:
`Atoms/SurfaceLadder` (palette from live tokens), `Templates/Transport`,
`Templates/ListenHero`, `Molecules/SegmentedControl`, `Molecules/Menu`,
`Atoms/Pill`, `Atoms/Timecode`, `Atoms/EmptyState`, and `Atoms/Icon`.
