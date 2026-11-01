import { test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import { checkUnsureWordJumps } from "./unsureWordsFlow";

test.describe("Script unsure-word jump (#634)", () => {
  test("the unsure button visits every low-confidence word in order, wraps and selects each", async ({
    page,
  }) => {
    await checkUnsureWordJumps(
      page,
      e2eProjectPath,
      "chromium-main-1280",
      "light",
    );
  });
});
