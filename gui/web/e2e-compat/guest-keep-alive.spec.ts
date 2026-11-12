import { expect, test } from "@playwright/test";
import {
  installOsRecorder,
  type OsRecorderSnapshot,
  readOsRecorder,
} from "../e2e/osMediaSessionRecorder";
import { withShareableProject } from "../e2e/shareableProject";
import { createReviewShare, openGuestShare } from "../e2e/shareNavigation";
import { withBrowserPages } from "../e2e/twoBrowserPages";

/**
 * The guest keep-alive must load under the page's real Content-Security-Policy
 * (`media-src 'self' blob:`) in both engines. WebKit and Chromium adopt a
 * media element as the OS Now Playing source only when it loads and lasts
 * more than 5 s (#3785).
 */

const keepAlive = (snapshot: OsRecorderSnapshot) =>
  snapshot.media.find((media) => media.src.startsWith("blob:"));

test("the guest keep-alive loads from a blob under the page CSP", async ({
  browser,
}) => {
  await withShareableProject(async (projectPath) => {
    await withBrowserPages(browser, [{}, {}], async ([host, page]) => {
      await installOsRecorder(page!);
      const token = await createReviewShare(host!, projectPath, "commenter");
      await openGuestShare(page!, token);
      expect((await readOsRecorder(page!)).media.map((m) => m.src)).toEqual([]);

      await page!.getByRole("button", { name: "Play", exact: true }).click();
      await expect(
        page!.getByRole("button", { name: "Pause", exact: true }).first(),
      ).toBeVisible();
      await expect
        .poll(async () => keepAlive(await readOsRecorder(page!))?.duration)
        .toBeGreaterThan(5);

      const snapshot = await readOsRecorder(page!);
      expect(keepAlive(snapshot)).toMatchObject({ error: null, paused: false });
      expect(keepAlive(snapshot)?.readyState).toBeGreaterThanOrEqual(1);
      expect(snapshot.violations).toEqual([]);
      await expect
        .poll(async () => (await readOsRecorder(page!)).playbackState)
        .toBe("playing");

      await page!
        .getByRole("button", { name: "Pause", exact: true })
        .first()
        .click();
      await expect
        .poll(async () => (await readOsRecorder(page!)).playbackState)
        .toBe("paused");
    });
  });
});
