import { test } from "@playwright/test";
import { e2eProjectPath } from "../e2e/env";
import { withAppearance } from "../e2e/theme";
import { checkUnsureWordJumps } from "../e2e/unsureWordsFlow";

for (const { cell, theme, reducedMotion } of withAppearance([
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
  { width: 820, height: 1180 },
])) {
  test.describe(`words header reachability at ${cell.width}`, () => {
    test.use({
      viewport: cell,
      reducedMotion: reducedMotion ? "reduce" : "no-preference",
    });
    test("keeps Next, its selection and the following Script line reachable", async ({
      page,
      browserName,
    }) => {
      await checkUnsureWordJumps(
        page,
        e2eProjectPath,
        `${browserName}-${cell.width}-${theme}`,
        theme,
      );
    });
  });
}
