import { test } from "@playwright/test";
import { exerciseCommentUndo } from "./commentUndo";

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 360, height: 800 },
]) {
  test.describe(`Comment recovery at ${viewport.width}`, () => {
    test.use({ viewport });
    for (const theme of ["light", "dark"] as const) {
      test(`keeps Undo reachable and returns focus without scrolling in ${theme}`, async ({
        page,
      }, info) => {
        await exerciseCommentUndo(page, theme, info);
      });
    }
  });
}
