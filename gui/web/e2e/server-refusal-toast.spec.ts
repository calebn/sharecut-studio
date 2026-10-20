import { expect, test } from "@playwright/test";
import { expectFeedback } from "./feedback";
import { withShareableProject } from "./shareableProject";

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
    await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
    await expect(page.locator(".lane-row").first()).toBeVisible();
    await page.getByRole("button", { name: /^Mix out of date/ }).click();
    const toast = page.locator(".ui-toast-region--app");
    await expectFeedback(page, `Refresh failed: ${HOST_MESSAGE}`);
    await expect(toast).not.toContainText(/PODCAST_[A-Z_]+|Traceback|\.py\b/);
  });
});
