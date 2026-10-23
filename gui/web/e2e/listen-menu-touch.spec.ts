import { expect, test } from "@playwright/test";
import { withShareableProject } from "./shareableProject";

test.use({ hasTouch: true, storageState: { cookies: [], origins: [] } });

for (const viewport of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
]) {
  test(`Listen menu keeps actions usable at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await withShareableProject(async (projectPath) => {
      await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
      await page
        .locator(".listen-hero")
        .getByRole("button", { name: "Menu" })
        .click();
      const menu = page.getByRole("menu", { name: "Transport menu" });
      await expect(
        menu.getByRole("menuitem", { name: /Export deliverables/ }),
      ).toBeVisible();
      const share = menu.getByRole("menuitem", { name: /Share/ });
      if (await share.count()) await expect(share).toBeVisible();
      await expect(
        menu.getByRole("menuitem", { name: /Remove track/ }),
      ).toHaveCount(0);
      await expect(
        menu.getByRole("menuitem", { name: /Move track/ }),
      ).toHaveCount(0);
      await expect(menu.getByRole("group", { name: "Zoom" })).toHaveCount(0);
      const shortcutsVisible = await menu
        .locator(".ui-menu-shortcut")
        .evaluateAll((items) =>
          items.some((item) => getComputedStyle(item).display !== "none"),
        );
      expect(shortcutsVisible).toBe(false);
      const rowHeights = await menu
        .getByRole("menuitem")
        .evaluateAll((rows) =>
          rows.map((row) => row.getBoundingClientRect().height),
        );
      expect(Math.min(...rowHeights)).toBeGreaterThanOrEqual(44);
    });
  });
}
