import { expect, test } from "@playwright/test";
import { expectFeedback } from "./feedback";
import { withShareableProject } from "./shareableProject";
import { openProject } from "./stageNav";

const HOST_MESSAGE =
  "Couldn't rebuild the mix because a track file is missing. Re-add the track from Tracks, then refresh again.";

test("a server refusal reaches the toast as the host message with a next step", async ({
  page,
}) => {
  await withShareableProject(async (projectPath) => {
    await page.route("**/api/pipeline/render-preview", (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        headers: { "X-Sharecut-Error-Code": "render_input_missing" },
        body: JSON.stringify({ detail: HOST_MESSAGE }),
      }),
    );
    await openProject(page, projectPath);
    await expect(page.locator(".lane-row").first()).toBeVisible();
    // Refresh mix is a command now (the old pill is gone): its shortcut.
    await page.locator("body").click({ position: { x: 1, y: 1 } });
    await page.keyboard.press("ControlOrMeta+b");
    const toast = page.locator(".ui-toast-region--app");
    await expectFeedback(page, `Refresh failed: ${HOST_MESSAGE}`);
    await expect(toast).not.toContainText(/PODCAST_[A-Z_]+|Traceback|\.py\b/);
  });
});
