import { test } from "@playwright/test";
import { exerciseCommentUndo } from "../e2e/commentUndo";

test("comment recovery keeps native disabled-button focus and sticky controls", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await exerciseCommentUndo(page, "dark", info);
});
