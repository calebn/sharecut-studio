import { test } from "@playwright/test";
import { exerciseEnvelopeRecovery } from "./envelopeRecovery";
import { withAppearance } from "./theme";

for (const { cell: viewport, theme } of withAppearance([
  { width: 1440, height: 900 },
  { width: 820, height: 1024 },
  { width: 360, height: 800 },
])) {
  test.describe(`Envelope recovery at ${viewport.width}`, () => {
    test.use({ viewport, reducedMotion: "reduce" });
    test(`native envelope owner cancels locally and ignores synthetic foreign events in ${theme}`, async ({
      page,
    }, info) => {
      await exerciseEnvelopeRecovery(page, theme, info);
    });
  });
}
