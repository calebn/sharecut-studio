import { test } from "@playwright/test";
import { withAppearance } from "./theme";
import { exerciseTouchSheetAffordances } from "./touchAffordances";

const cases = [
  { width: 360, height: 800, sheetExpected: true },
  { width: 667, height: 360, sheetExpected: true },
  { width: 820, height: 1180, sheetExpected: false },
  { width: 1440, height: 900, sheetExpected: false },
] as const;

for (const { cell: viewport, theme, reducedMotion } of withAppearance(cases)) {
  test(`sheet affordances ${viewport.width}x${viewport.height}${viewport.sheetExpected ? "" : " (no legacy sheet)"}, ${theme}, reduced motion ${reducedMotion}`, async ({
    page,
  }) => {
    await exerciseTouchSheetAffordances(page, viewport, theme, reducedMotion, {
      suite: "main",
    });
  });
}

test("sheet affordances remain available at 200% text scale", async ({
  page,
}) => {
  await exerciseTouchSheetAffordances(
    page,
    {
      width: 360,
      height: 800,
      sheetExpected: true,
      textScale: true,
      requireBodyOverflow: true,
    },
    "light",
    true,
    { suite: "main" },
  );
});
