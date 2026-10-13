import { test } from "@playwright/test";
import { exerciseCommentUndo } from "./commentUndo";
import { withAppearance } from "./theme";

for (const { cell: viewport, theme } of withAppearance([
  { width: 1440, height: 900 },
  { width: 360, height: 800 },
])) {
  test.describe(`Comment recovery at ${viewport.width}`, () => {
    test.use({ viewport });
    test(`keeps Undo reachable and returns focus without scrolling in ${theme}`, async ({
      page,
    }, info) => {
      await exerciseCommentUndo(page, theme, info);
    });
  });
}
