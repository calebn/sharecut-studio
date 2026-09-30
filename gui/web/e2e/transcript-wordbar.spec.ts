import { test } from "@playwright/test";
import { checkWordbarOutsideRelease } from "./wordbarFlow";

test("Wordbar native drag saves once outside the inspector and Undo restores exact timing", async ({
  page,
}) => {
  await checkWordbarOutsideRelease(page);
});
