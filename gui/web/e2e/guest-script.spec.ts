import { expect, test } from "@playwright/test";
import { withShareableProject } from "./shareableProject";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
} from "./shareNavigation";
import { withBrowserPages } from "./twoBrowserPages";

const SIZES = [
  { width: 320, height: 568, script: true },
  { width: 390, height: 844, script: true },
  { width: 844, height: 390, script: false },
  { width: 1280, height: 800, script: true },
  { width: 800, height: 1280, script: true },
] as const;

for (const size of SIZES) {
  test(`a Commenter link ${size.script ? "shows" : "hides"} the read-only Script and keeps the composer in view at ${size.width}x${size.height}`, async ({
    browser,
  }) => {
    await withShareableProject(async (projectPath) => {
      await withBrowserPages(
        browser,
        [
          {},
          {
            viewport: { width: size.width, height: size.height },
            hasTouch: size.width < 900,
          },
        ],
        async ([host, guest]) => {
          await openHostShare(host, projectPath);
          const token = await createReviewShare(host, projectPath, "commenter");
          await openGuestShare(guest, token);
          const script = guest.locator(".stage-host-guest-script");
          if (size.script) {
            await expect(script).toBeVisible();
            await expect(script).toContainText("Read only");
            await expect(script).toBeInViewport();
          } else {
            await expect(script).toHaveCount(0);
          }
          const field = guest
            .locator(".rv-compose")
            .getByRole("textbox", { name: "Comment", exact: true });
          await expect(field).toBeInViewport();
          await expect
            .poll(() =>
              guest.evaluate(() => document.documentElement.scrollWidth),
            )
            .toBeLessThanOrEqual(size.width);
        },
      );
    });
  });
}

test("a Viewer link shows no Script, because its guests are not sent word timings", async ({
  browser,
}) => {
  await withShareableProject(async (projectPath) => {
    await withBrowserPages(browser, [{}, {}], async ([host, guest]) => {
      await openHostShare(host, projectPath);
      const token = await createReviewShare(host, projectPath, "viewer");
      await openGuestShare(guest, token);
      await expect(guest.locator(".rv-stage")).toBeVisible();
      await expect(guest.locator(".stage-host-guest-script")).toHaveCount(0);
      await expect(guest.getByText("Nothing to read yet")).toHaveCount(0);
    });
  });
});
