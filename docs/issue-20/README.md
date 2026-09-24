# Issue #20 visual comparison

These captures use the same deterministic Playwright episode fixture, viewport,
and light theme before and after the design polish change. Desktop views are
1440 × 900; the mobile navigation view is 390 × 844. The capture path is
`gui/web/e2e/design-polish.spec.ts`.
The empty timeline uses a separate disposable empty project with
`EMPTY_STAGE_SCREENSHOT_DIR` set during capture.

| View | Before | After |
| --- | --- | --- |
| Timeline | ![Timeline before](before/timeline.png) | ![Timeline after](after/timeline.png) |
| Inspector | ![Inspector before](before/inspector.png) | ![Inspector after](after/inspector.png) |
| Share dialog | ![Share dialog before](before/share-dialog.png) | ![Share dialog after](after/share-dialog.png) |
| Empty state | ![Empty state before](before/empty-state.png) | ![Empty state after](after/empty-state.png) |
| Empty timeline | — | ![Empty timeline after](after/empty-timeline.png) |
| Mobile navigation | ![Mobile navigation before](before/mobile-nav.png) | ![Mobile navigation after](after/mobile-nav.png) |
