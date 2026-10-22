import { expect, test } from "@playwright/test";
import { timelineTestIds } from "../src/timeline/selectors";
import { e2eProjectPath } from "./env";
import { openPhoneTimeline } from "./phoneTimeline";

const SHORT_LANDSCAPES = [{ name: "iPhone SE", width: 667, height: 375 }];

for (const { name, width, height } of SHORT_LANDSCAPES) {
  test.describe(`Menu panel on a short phone landscape: ${name}`, () => {
    test.use({ viewport: { width, height }, isMobile: true, hasTouch: true });

    test("keeps room for its items while the Inspector is a column (#2125)", async ({
      page,
    }) => {
      await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
      await expect(page.locator("[data-save-state]")).toBeVisible();
      await openPhoneTimeline(page);
      await page.getByTestId(timelineTestIds.clip).first().click();
      await expect(page.locator(".daw-shell--inspector-column")).toBeVisible();
      await expect(page.locator(".mobile-nav")).toBeHidden();

      await page.getByRole("button", { name: "Menu", exact: true }).click();
      const panel = page.locator(".ui-menu-panel");
      await expect(panel).toBeVisible();
      await expect
        .poll(async () =>
          panel.evaluate((el) => {
            const rect = el.getBoundingClientRect();
            return {
              tall: rect.height >= Math.min(el.scrollHeight, 0.5 * innerHeight),
              inside: rect.top >= 0 && rect.bottom <= innerHeight,
            };
          }),
        )
        .toEqual({ tall: true, inside: true });
    });
  });
}
