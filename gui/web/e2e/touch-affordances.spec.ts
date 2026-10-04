import { test } from "@playwright/test";
import { exerciseTouchSheetAffordances } from "./touchAffordances";

const cases = [
  { width: 360, height: 800, sheetExpected: true },
  { width: 667, height: 360, sheetExpected: true },
  { width: 820, height: 1180, sheetExpected: true },
  { width: 1440, height: 900, sheetExpected: false },
] as const;

for (const viewport of cases) {
  for (const theme of ["light", "dark"] as const) {
    for (const reducedMotion of [false, true]) {
      test(`sheet affordances ${viewport.width}x${viewport.height}, ${theme}, reduced motion ${reducedMotion}`, async ({
        page,
      }) => {
        await exerciseTouchSheetAffordances(
          page,
          viewport,
          theme,
          reducedMotion,
        );
      });
    }
  }
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
  );
});
