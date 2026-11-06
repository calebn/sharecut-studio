/**
 * Stories whose play function needs the Storybook runtime (they hang or look
 * for elements the portable runner does not wait for). `e2e-storybook/coverage.spec.ts`
 * sweeps exactly these; every other story is swept by
 * `storySweep.sweep.browser.test.tsx` (`npm run test:stories`).
 */
export const STORYBOOK_ONLY: readonly string[] = [
  "stages-edit-workspace--loading",
  "stages-edit-trackcolumn--loading",
  "templates-timeline--loading",
  "stages-deliver-podcast-listing--writing",
  "stages-review-host--find-more",
  "stages-review-host--find-more-busy",
  "stages-review-host--queue",
  "stages-review-host--queue-phone",
  "stages-review-host--unsure-words",
  "stages-review-host--unsure-words-phone",
  "stages-edit-speakerpopover--open",
  "templates-editboundarymark--roll-drag-preview",
];
