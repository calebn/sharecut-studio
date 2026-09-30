import { test } from "@playwright/test";
import { checkWordbarOutsideRelease } from "../e2e/wordbarFlow";

test("Wordbar native boundary release and exact Undo work across browsers", async ({
  page,
}) => {
  await checkWordbarOutsideRelease(page);
});
