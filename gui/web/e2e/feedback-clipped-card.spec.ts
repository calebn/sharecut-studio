import { expect, test } from "@playwright/test";
import { expectFeedback } from "./feedback";
import { withShareableProject } from "./shareableProject";
import { openProject } from "./stageNav";

const TOAST_MS = 8000;
const CLIPPED_MAX_MS = 8000;

test.use({
  viewport: { width: 320, height: 460 },
  hasTouch: true,
  storageState: { cookies: [], origins: [] },
});

for (const ratio of [0.5, 0.97]) {
  test(`a failure card the observer reports at ratio ${ratio} clears on its own`, async ({
    page,
  }) => {
    await withShareableProject(async (projectPath) => {
      await page.addInitScript((reported) => {
        window.IntersectionObserver = class {
          callback: (entries: unknown[]) => void;
          constructor(callback: (entries: unknown[]) => void) {
            this.callback = callback;
          }
          observe(target: Element) {
            this.callback([
              {
                target,
                isIntersecting: true,
                intersectionRatio: reported,
              },
            ]);
          }
          unobserve() {}
          disconnect() {}
          takeRecords() {
            return [];
          }
        } as unknown as typeof IntersectionObserver;
      }, ratio);
      await page.route("**/api/pipeline/render-preview", (route) =>
        route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ detail: "Bad request" }),
        }),
      );
      await page.clock.install();
      await openProject(page, projectPath);
      const play = page.getByRole("button", { name: "Play", exact: true });
      await expect(play).toBeVisible();
      await expectFeedback(page, /^Refresh failed/);
      const card = page.locator(".ui-toast-region--app .ui-toast");
      await page.clock.runFor(TOAST_MS + 100);
      if (ratio < 0.95) {
        await expect(card).toBeVisible();
        await page.clock.runFor(CLIPPED_MAX_MS + 100);
      }
      await expect(card).toHaveCount(0);
    });
  });
}
